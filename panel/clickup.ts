// Pure ClickUp API helpers for the ClickUp Tasks extension.
//
// No DOM and no host import: the caller supplies a `request` function. The
// panel passes the OpenChamber host request; scripts/live-check.ts passes one
// backed by fetch, so the same code that runs in the app is tested against the
// real API.

export type ClickUpFieldOption = { id?: string; name?: string; orderindex?: number | string };
export type ClickUpCustomField = {
  name?: string;
  type?: string;
  value?: unknown;
  type_config?: { options?: ClickUpFieldOption[] } | null;
};
export type ClickUpTask = {
  id: string;
  custom_id?: string | null;
  name?: string;
  url?: string | null;
  status?: { status?: string; type?: string; color?: string } | null;
  priority?: { priority?: string } | null;
  due_date?: string | null;
  date_updated?: string | null;
  list?: { name?: string } | null;
  folder?: { name?: string } | null;
  project?: { name?: string } | null;
  space?: { name?: string } | null;
  parent?: string | null;
  top_level_parent?: string | null;
  assignees?: Array<{ username?: string }>;
  custom_fields?: ClickUpCustomField[] | null;
};

/** A ClickUp request that returns the status and raw body. */
export type ClickUpRequest = (
  path: string,
  query?: Record<string, string>,
) => Promise<{ status: number; body: string }>;

/** OpenChamber's GUEST_REQUEST_RESPONSE_MAX: every response body is cut here. */
export const RESPONSE_MAX = 256_000;

export const REJECTED_TOKEN =
  "ClickUp rejected the token. Reconnect it in Settings → Integrations → ClickUp.";

/**
 * Read the complete task objects out of a `{"tasks":[...]}` body, tolerating a
 * body the host cut off mid-array. Returns whether the array was truncated.
 */
export const extractTasks = (body: string): { tasks: ClickUpTask[]; truncated: boolean } => {
  const match = /"tasks"\s*:\s*\[/.exec(body);
  if (!match) return { tasks: [], truncated: body.length >= RESPONSE_MAX };
  const tasks: ClickUpTask[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = match.index + match[0].length; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          tasks.push(JSON.parse(body.slice(start, i + 1)) as ClickUpTask);
        } catch {
          // A malformed object is skipped rather than failing the whole load.
        }
        start = -1;
      }
    } else if (char === "]" && depth === 0) {
      return { tasks, truncated: false };
    }
  }
  return { tasks, truncated: true };
};

export const byDueDate = (a: ClickUpTask, b: ClickUpTask): number => {
  const left = a.due_date ? Number(a.due_date) : Number.POSITIVE_INFINITY;
  const right = b.due_date ? Number(b.due_date) : Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return (a.name ?? "").localeCompare(b.name ?? "");
};

export const isClosed = (task: ClickUpTask): boolean => {
  const type = task.status?.type;
  return type === "closed" || type === "done";
};

export const shortId = (task: ClickUpTask): string => task.custom_id || task.id.slice(0, 8);

export const taskFolder = (task: ClickUpTask): string => task.project?.name ?? task.folder?.name ?? "";

export const isFrenteTask = (task: ClickUpTask, frenteFolder: string): boolean =>
  taskFolder(task).toLowerCase() === frenteFolder.toLowerCase();

/** Resolve a custom field to display text, mapping dropdown orderindex to its option name. */
export const resolveCustomField = (task: ClickUpTask, fieldName: string): string | undefined => {
  const field = (task.custom_fields ?? []).find(
    (entry) => (entry.name ?? "").toLowerCase() === fieldName.toLowerCase(),
  );
  if (!field || field.value === null || field.value === undefined) return undefined;
  const value = field.value;
  if (field.type === "drop_down") {
    const options = field.type_config?.options ?? [];
    const match =
      options.find((option) => String(option.orderindex) === String(value)) ??
      options.find((option) => String(option.id) === String(value));
    if (match?.name) return match.name;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : ((entry as { username?: string; name?: string })?.username ??
            (entry as { name?: string })?.name ??
            ""),
      )
      .filter(Boolean)
      .join(", ");
    return text || undefined;
  }
  return String(value);
};

/**
 * One ClickUp page, tolerant of the host cutting the body at 256 KB. A range
 * that fits returns every task in it; a truncated one is split by
 * `date_updated` and fetched as two smaller ranges. The server does not order
 * by date, so a cursor sweep cannot be trusted — bisection can.
 */
const fetchRange = async (
  request: ClickUpRequest,
  teamId: string,
  userId: string,
  includeClosed: boolean,
  gt: number | undefined,
  lt: number | undefined,
  depth: number,
): Promise<ClickUpTask[]> => {
  const query: Record<string, string> = {
    "assignees[]": userId,
    subtasks: "true",
    include_closed: includeClosed ? "true" : "false",
    order_by: "updated",
    page: "0",
  };
  if (gt !== undefined) query.date_updated_gt = String(gt);
  if (lt !== undefined) query.date_updated_lt = String(lt);
  const result = await request(`/api/v2/team/${encodeURIComponent(teamId)}/task`, query);
  if (result.status === 401 || result.status === 403) throw new Error(REJECTED_TOKEN);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`ClickUp answered ${result.status}`);
  }
  const { tasks, truncated } = extractTasks(result.body);
  // A complete page under 100 tasks is the whole range.
  if (!truncated && tasks.length < 100) return tasks;
  const dates = tasks.map((task) => Number(task.date_updated)).filter(Number.isFinite);
  if (dates.length === 0 || depth >= 30) return tasks;
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  if (min >= max) return tasks;
  const pivot = Math.floor((min + max) / 2);
  const lowerLt = lt === undefined ? pivot : Math.min(lt, pivot);
  const upperGt = gt === undefined ? pivot - 1 : Math.max(gt, pivot - 1);
  const [older, newer] = await Promise.all([
    fetchRange(request, teamId, userId, includeClosed, gt, lowerLt, depth + 1),
    fetchRange(request, teamId, userId, includeClosed, upperGt, lt, depth + 1),
  ]);
  return [...older, ...newer];
};

/** All tasks assigned to a user, across every workspace, merged by id and sorted by due date. */
export const fetchAssignedTasks = async (
  request: ClickUpRequest,
  teamIds: string[],
  userId: string,
  includeClosed: boolean,
): Promise<ClickUpTask[]> => {
  const byId = new Map<string, ClickUpTask>();
  for (const teamId of teamIds) {
    for (const task of await fetchRange(request, teamId, userId, includeClosed, undefined, undefined, 0)) {
      if (task && typeof task.id === "string") byId.set(task.id, task);
    }
  }
  return [...byId.values()].sort(byDueDate);
};

export type TaskGroup = { label: string; frente: boolean; tasks: ClickUpTask[] };

export const buildGroups = (tasks: ClickUpTask[], frenteFolder: string): TaskGroup[] => {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const frente = isFrenteTask(task, frenteFolder);
    const label = frente
      ? (task.list?.name ?? "Unnamed frente")
      : `${taskFolder(task) || "Other"} (no frente)`;
    const key = `${frente ? "f" : "n"}:${label}`;
    let group = groups.get(key);
    if (!group) {
      group = { label, frente, tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()].sort((a, b) =>
    a.frente !== b.frente ? (a.frente ? -1 : 1) : a.label.localeCompare(b.label),
  );
};

export type TreeNode = { task: ClickUpTask; children: TreeNode[] };

/**
 * Nest subtasks under their parent. A subtask whose parent is not in the set
 * (assigned to someone else, or filtered out) becomes a root, so nothing is
 * hidden. Depth is capped defensively.
 */
export const buildTree = (tasks: ClickUpTask[]): TreeNode[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childMap = new Map<string, ClickUpTask[]>();
  const roots: ClickUpTask[] = [];
  for (const task of tasks) {
    const parentId = task.parent ?? null;
    if (parentId && parentId !== task.id && byId.has(parentId)) {
      const list = childMap.get(parentId);
      if (list) list.push(task);
      else childMap.set(parentId, [task]);
    } else {
      roots.push(task);
    }
  }
  const build = (task: ClickUpTask, depth: number): TreeNode => ({
    task,
    children:
      depth >= 20 ? [] : (childMap.get(task.id) ?? []).map((child) => build(child, depth + 1)),
  });
  return roots.map((task) => build(task, 0));
};

/** The sprint a task sits in: its sprint field for frente tasks, else its list. */
export const sprintLabel = (task: ClickUpTask, frenteFolder: string, sprintField: string): string =>
  (
    (isFrenteTask(task, frenteFolder) ? resolveCustomField(task, sprintField) : task.list?.name) ?? ""
  ).trim();

type SprintKey = { rank: number; label: string };

const sprintKey = (task: ClickUpTask, frenteFolder: string, sprintField: string): SprintKey => {
  const label = sprintLabel(task, frenteFolder, sprintField);
  const numbered = /^sprint\s*0*(\d+)/i.exec(label);
  if (numbered) return { rank: Number(numbered[1]), label };
  // "Sprint" or "Sprint Bugs …" sort after numbered sprints.
  if (/^sprint\b/i.test(label)) return { rank: Number.MAX_SAFE_INTEGER, label };
  return { rank: Number.POSITIVE_INFINITY, label };
};

/** Order by sprint (01, 02, …; unnumbered last), then by due date and name. */
export const compareBySprint = (
  a: ClickUpTask,
  b: ClickUpTask,
  frenteFolder: string,
  sprintField: string,
): number => {
  const left = sprintKey(a, frenteFolder, sprintField);
  const right = sprintKey(b, frenteFolder, sprintField);
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1;
  if (left.label !== right.label) return left.label.localeCompare(right.label);
  return byDueDate(a, b);
};

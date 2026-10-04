// OpenChamber extension: your assigned ClickUp tasks in a simple table.
//
// Data comes from the ClickUp Public API v2 through the extension's declared
// `integration`, so the personal API token stays on the OpenChamber server and
// never reaches this sandboxed page. MCP is a separate concern: the `tools`
// block in package.json styles `mcp.clickup.*` agent tool calls as tables.
import { connectHost, HostRequestError } from "@openchamber/sdk";
import type { AttachIssueRequest, GuestConnection, GuestSettings } from "@openchamber/sdk";
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSpinner,
  mountTabs,
} from "@openchamber/sdk/ui";
import type { ButtonHandle, TabsHandle, Tone } from "@openchamber/sdk/ui";
import {
  buildGroups,
  buildTree,
  compareBySprint,
  fetchAssignedTasks,
  isClosed,
  resolveCustomField,
  shortId,
  sprintLabel,
  taskFolder,
  REJECTED_TOKEN,
  RESPONSE_MAX,
  type ClickUpRequest,
  type ClickUpTask,
  type TreeNode,
} from "./clickup.ts";

// --- ClickUp API glue -------------------------------------------------------

type ClickUpUser = { id: number; username?: string };
type ClickUpTeam = { id: string | number; name?: string };

type Filter = "open" | "all";
type LoadStatus = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

type State = {
  connected: boolean;
  account: string;
  settings: GuestSettings;
  filter: Filter;
  query: string;
  frenteFilter: string | null;
  tasks: ClickUpTask[];
  status: LoadStatus;
};

const host = connectHost();
const PROVIDER = "clickup-tasks";
const DEFAULT_ORIGIN = "https://app.clickup.com";

const state: State = {
  connected: false,
  account: "",
  settings: {},
  filter: "open",
  query: "",
  frenteFilter: null,
  tasks: [],
  status: { kind: "idle" },
};

let user: ClickUpUser | null = null;
let teamIds: string[] = [];
let generation = 0;

// --- Small DOM helpers ------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Missing #root");

const bar = el("div", "bar");
const title = el("div", "title");
title.textContent = "ClickUp Tasks";
bar.append(title);
const spacer = el("div");
spacer.style.flex = "1";
bar.append(spacer);
const refreshHost = el("div");
bar.append(refreshHost);

const sub = el("div", "sub");
const tools = el("div", "tools");
const searchHost = el("div");
const tabsHost = el("div");
const frenteRow = el("div", "frente-row");
const frenteLabel = el("span", "frente-label");
frenteLabel.textContent = "Frentes";
const frenteTabsHost = el("div", "frente-tabs");
frenteRow.append(frenteLabel, frenteTabsHost);
frenteRow.hidden = true;
tools.append(searchHost, tabsHost, frenteRow);
const content = el("div", "content");
root.append(bar, sub, tools, content);

let refreshButton: ButtonHandle | null = null;
let frenteTabs: TabsHandle | null = null;
let active: Array<{ dispose: () => void }> = [];

const clearContent = () => {
  for (const handle of active) handle.dispose();
  active = [];
  content.replaceChildren();
};

mountSearchField(searchHost, {
  value: "",
  placeholder: "Filter tasks",
  label: "Filter tasks",
  onChange: (value) => {
    state.query = value;
    renderContent();
  },
});

const tabs = mountTabs(tabsHost, {
  items: [
    { id: "open", label: "Open" },
    { id: "all", label: "All" },
  ],
  activeId: "open",
  onChange: (id) => {
    if (id !== "open" && id !== "all") return;
    state.filter = id;
    tabs.update({ activeId: id });
    void load(false);
  },
});

frenteTabs = mountTabs(frenteTabsHost, {
  items: [],
  activeId: "all",
  onChange: (id) => {
    state.frenteFilter = id === "all" ? null : id.replace(/^f:/, "");
    frenteTabs?.update({ activeId: id });
    renderContent();
  },
});

refreshButton = mountButton(refreshHost, {
  label: "Refresh",
  variant: "secondary",
  size: "sm",
  onClick: () => void load(true),
});

// --- ClickUp calls through the host (token never reaches this page) --------

const callClickUp: ClickUpRequest = (path, query) => host.request({ method: "GET", path, query });

const requestJson = async <T,>(path: string, query?: Record<string, string>): Promise<T> => {
  const result = await callClickUp(path, query);
  if (result.status === 401 || result.status === 403) throw new Error(REJECTED_TOKEN);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`ClickUp answered ${result.status}`);
  }
  if (result.body.length >= RESPONSE_MAX) {
    throw new Error("ClickUp's response was too large for one request.");
  }
  return JSON.parse(result.body) as T;
};

const ensureContext = async (): Promise<void> => {
  if (user && teamIds.length > 0) return;
  const me = await requestJson<{ user: ClickUpUser }>("/api/v2/user");
  user = me.user;
  const configured = state.settings["team-id"]?.trim();
  if (configured) {
    teamIds = [configured];
    return;
  }
  const teams = await requestJson<{ teams: ClickUpTeam[] }>("/api/v2/team");
  teamIds = (teams.teams ?? []).map((team) => String(team.id));
  if (teamIds.length === 0) throw new Error("No ClickUp workspace is available for this token.");
};

const fetchTaskById = async (id: string): Promise<ClickUpTask | null> => {
  await ensureContext();
  const isCustomId = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id);
  const attempts: Array<Record<string, string>> = isCustomId
    ? teamIds.map((teamId) => ({ custom_task_ids: "true", team_id: teamId }))
    : [{}];
  for (const query of attempts) {
    try {
      return await requestJson<ClickUpTask>(`/api/v2/task/${encodeURIComponent(id)}`, query);
    } catch {
      // Try the next workspace, then give up.
    }
  }
  return null;
};

// --- Presentation helpers ---------------------------------------------------

const priorityTone = (priority: string | null | undefined): Tone => {
  switch ((priority ?? "").toLowerCase()) {
    case "urgent":
      return "error";
    case "high":
      return "warning";
    case "normal":
      return "info";
    case "low":
      return "neutral";
    default:
      return "neutral";
  }
};

const formatDue = (task: ClickUpTask): string | undefined => {
  if (!task.due_date) return undefined;
  const date = new Date(Number(task.due_date));
  if (Number.isNaN(date.getTime())) return undefined;
  const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return !isClosed(task) && date.getTime() < Date.now() ? `${label} overdue` : label;
};

const attachPayload = (task: ClickUpTask): AttachIssueRequest => {
  const label = shortId(task);
  const url = task.url || `${DEFAULT_ORIGIN}/t/${task.id}`;
  const lines = [
    `ClickUp task ${label}: ${task.name ?? "(untitled)"}`,
    task.status?.status ? `Status: ${task.status.status}` : "",
    task.list?.name ? `List: ${task.list.name}` : "",
    task.due_date ? `Due: ${new Date(Number(task.due_date)).toISOString().slice(0, 10)}` : "",
    url,
  ].filter(Boolean);
  return {
    providerId: PROVIDER,
    id: label,
    title: task.name || label,
    url,
    kind: "issue",
    text: `${lines.join("\n")}\n`,
    data: {
      status: task.status?.status ?? "",
      priority: task.priority?.priority ?? "",
      list: task.list?.name ?? "",
    },
  };
};

const visibleTasks = (): ClickUpTask[] => {
  const query = state.query.trim().toLowerCase();
  let tasks = state.tasks;
  if (state.filter === "open") tasks = tasks.filter((task) => !isClosed(task));
  if (query) {
    tasks = tasks.filter((task) =>
      `${task.name ?? ""} ${task.custom_id ?? ""} ${task.id} ${task.list?.name ?? ""} ${taskFolder(task)} ${
        resolveCustomField(task, sprintField()) ?? ""
      }`
        .toLowerCase()
        .includes(query),
    );
  }
  return tasks;
};

// --- Frente grouping --------------------------------------------------------

const frenteFolder = (): string => state.settings["frente-folder"]?.trim() || "Frentes";
const sprintField = (): string => state.settings["sprint-field"]?.trim() || "Sprints";

/** Fill the Frentes tab row from the tasks in hand; hide it when there are none. */
const renderFrenteTabs = (tasks: ClickUpTask[], frente: string): void => {
  const frentes = buildGroups(tasks, frente).filter((group) => group.frente);
  if (frentes.length === 0) {
    state.frenteFilter = null;
    frenteRow.hidden = true;
    frenteTabs?.update({ items: [], activeId: "all" });
    return;
  }
  const labels = new Set(frentes.map((group) => group.label));
  if (state.frenteFilter && !labels.has(state.frenteFilter)) state.frenteFilter = null;
  const items = [
    { id: "all", label: "All", count: tasks.length },
    ...frentes.map((group) => ({
      id: `f:${group.label}`,
      label: group.label,
      count: group.tasks.length,
    })),
  ];
  frenteRow.hidden = false;
  frenteTabs?.update({ items, activeId: state.frenteFilter ? `f:${state.frenteFilter}` : "all" });
};

// --- Rows with expandable subtasks ------------------------------------------

const collapsed = new Set<string>();

const rowSubtitle = (task: ClickUpTask, frente: string): string | undefined =>
  sprintLabel(task, frente, sprintField()) || undefined;

const statusTone = (status: string, type: string | undefined): Tone => {
  const value = status.toLowerCase();
  if (/refus|block|fail|cancel|reject/.test(value)) return "error";
  if (/done|complete|closed|tested|approv/.test(value)) return "success";
  if (/review|qa|\bpr\b|stage|verif/.test(value)) return "warning";
  if (/progress|doing|active|commit|ready/.test(value)) return "info";
  if (type === "closed" || type === "done") return "success";
  return "neutral";
};

const makeStatusDot = (task: ClickUpTask): HTMLElement | null => {
  const status = task.status?.status;
  if (!status) return null;
  const dot = el("span", "cu-dot");
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", status);
  const color = task.status?.color;
  if (color) dot.style.background = color;
  else dot.dataset.tone = statusTone(status, task.status?.type);
  return dot;
};

const attachTask = (task: ClickUpTask): void => {
  void host
    .attach(attachPayload(task))
    .then(() => host.toast({ kind: "success", message: `Attached ${shortId(task)} to the chat.` }))
    .catch((error) =>
      host.toast({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
};

const makeRow = (task: ClickUpTask, frente: string): HTMLElement => {
  const row = el("div", "cu-row");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const main = el("div", "cu-main");
  const title = el("div", "cu-title");
  title.textContent = task.name || "(untitled)";
  main.append(title);
  const subtitle = rowSubtitle(task, frente);
  if (subtitle) {
    const subEl = el("div", "cu-sub");
    subEl.textContent = subtitle;
    main.append(subEl);
  }
  row.append(main);
  const priority = task.priority?.priority;
  if (priority) {
    const badge = el("span", "cu-badge");
    badge.textContent = priority;
    badge.dataset.tone = priorityTone(priority);
    row.append(badge);
  }
  const statusDot = makeStatusDot(task);
  if (statusDot) row.append(statusDot);
  const due = formatDue(task);
  if (due) {
    const metaEl = el("span", "cu-meta");
    metaEl.textContent = due;
    row.append(metaEl);
  }
  row.addEventListener("click", () => attachTask(task));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      attachTask(task);
    }
  });
  return row;
};

const renderTree = (container: HTMLElement, nodes: TreeNode[], depth: number, frente: string): void => {
  for (const node of nodes) {
    const row = makeRow(node.task, frente);
    row.style.setProperty("--cu-indent", `${depth * 14}px`);
    let childrenBox: HTMLElement | null = null;
    if (node.children.length > 0) {
      childrenBox = el("div", "cu-children");
      const isOpen = !collapsed.has(node.task.id);
      childrenBox.hidden = !isOpen;
      const caret = el("button", "cu-caret");
      caret.type = "button";
      caret.textContent = isOpen ? "▾" : "▸";
      caret.setAttribute("aria-expanded", String(isOpen));
      caret.setAttribute("aria-label", isOpen ? "Collapse subtasks" : "Expand subtasks");
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = !collapsed.has(node.task.id);
        if (open) collapsed.add(node.task.id);
        else collapsed.delete(node.task.id);
        caret.textContent = open ? "▸" : "▾";
        caret.setAttribute("aria-expanded", String(!open));
        caret.setAttribute("aria-label", open ? "Expand subtasks" : "Collapse subtasks");
        if (childrenBox) childrenBox.hidden = open;
      });
      row.prepend(caret);
    } else {
      row.prepend(el("span", "cu-caret-spacer"));
    }
    container.append(row);
    if (childrenBox) {
      renderTree(childrenBox, node.children, depth + 1, frente);
      container.append(childrenBox);
    }
  }
};

// --- Rendering --------------------------------------------------------------

const renderHeader = () => {
  const open = state.tasks.filter((task) => !isClosed(task)).length;
  const shown = visibleTasks().length;
  const who = user?.username ? `${user.username} · ` : "";
  sub.textContent = state.connected ? `${who}${shown} shown · ${open} open` : "Not connected";
};

const renderContent = () => {
  clearContent();
  frenteRow.hidden = true;
  if (!state.connected) {
    active.push(
      mountEmpty(content, {
        title: "Not connected",
        body: "Open Settings → Integrations → ClickUp and paste your personal API token to see your tasks.",
      }),
    );
    return;
  }
  if (state.status.kind === "loading" && state.tasks.length === 0) {
    active.push(mountSpinner(content, { label: "Loading tasks" }));
    return;
  }
  if (state.status.kind === "error") {
    active.push(
      mountBanner(content, {
        tone: "error",
        title: "Could not load tasks",
        body: state.status.message,
        action: { label: "Retry", onClick: () => void load(true) },
      }),
    );
    return;
  }
  const frente = frenteFolder();
  const tasks = [...visibleTasks()].sort((a, b) => compareBySprint(a, b, frente, sprintField()));
  renderFrenteTabs(tasks, frente);
  if (tasks.length === 0) {
    active.push(
      mountEmpty(content, {
        title: state.query
          ? "No matching tasks"
          : state.filter === "all"
            ? "No assigned tasks"
            : "No open tasks",
        body: state.query ? "Clear the filter to see everything." : "You are all caught up in ClickUp.",
      }),
    );
    return;
  }
  const groups = buildGroups(tasks, frente).filter(
    (group) => !state.frenteFilter || group.label === state.frenteFilter,
  );
  if (groups.length === 0) {
    active.push(
      mountEmpty(content, {
        title: `No open tasks in ${state.frenteFilter}`,
        body: "Switch the Frentes tab or clear the filter.",
      }),
    );
    return;
  }
  for (const group of groups) {
    const header = el("div", "group");
    const name = el("span", "group-name");
    name.textContent = group.label;
    const count = el("span", "group-count");
    count.textContent = String(group.tasks.length);
    header.append(name, count);
    content.append(header);
    const list = el("div", "cu-list");
    list.setAttribute("role", "list");
    renderTree(list, buildTree(group.tasks), 0, frente);
    content.append(list);
  }
};

// --- Loading ----------------------------------------------------------------

const load = async (force: boolean): Promise<void> => {
  if (!state.connected) {
    renderHeader();
    renderContent();
    return;
  }
  const current = ++generation;
  state.status = { kind: "loading" };
  refreshButton?.update({ loading: true, disabled: true });
  renderHeader();
  renderContent();
  try {
    if (force) {
      user = null;
      teamIds = [];
    }
    await ensureContext();
    const tasks = await fetchAssignedTasks(callClickUp, teamIds, String(user!.id), state.filter === "all");
    if (current !== generation) return;
    state.tasks = tasks;
    state.status = { kind: "idle" };
    const open = tasks.filter((task) => !isClosed(task)).length;
    void host.setBadge(state.filter === "all" ? open : tasks.length).catch(() => undefined);
  } catch (error) {
    if (current !== generation) return;
    const code = error instanceof HostRequestError ? error.code : undefined;
    if (code === "DISCONNECTED" || code === "NO_INTEGRATION") {
      state.connected = false;
      state.status = { kind: "idle" };
      void host.setBadge(null).catch(() => undefined);
    } else {
      state.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    if (current === generation) {
      refreshButton?.update({ loading: false, disabled: false });
      renderHeader();
      renderContent();
    }
  }
};

// --- Slash command: /clickup ABC-12 ----------------------------------------

host.onResolve(async ({ args }) => {
  const id = args.trim();
  if (!id) throw new Error("Give a task id, for example /clickup ABC-12");
  const task = await fetchTaskById(id);
  return task ? attachPayload(task) : null;
});

// --- Host wiring ------------------------------------------------------------

const applyConnection = (connection: GuestConnection | undefined): void => {
  const connected = Boolean(connection?.connected);
  const wasConnected = state.connected;
  state.connected = connected;
  state.account = connection?.account ?? "";
  if (connected && !wasConnected) {
    void load(true);
  } else if (!connected) {
    state.tasks = [];
    state.status = { kind: "idle" };
    renderHeader();
    renderContent();
  }
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  state.settings = ctx.settings ?? {};
  applyConnection(ctx.connection);
});

host.onConnection(applyConnection);

host.onSettings((settings) => {
  const changed = (settings?.["team-id"] ?? "") !== (state.settings["team-id"] ?? "");
  state.settings = settings ?? {};
  if (changed && state.connected) void load(true);
});

renderHeader();
renderContent();

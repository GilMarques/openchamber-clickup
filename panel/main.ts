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
  mountCheckbox,
  mountEmpty,
  mountSearchField,
  mountSpinner,
  mountTabs,
  mountTextField,
} from "@openchamber/sdk/ui";
import type { TabsHandle, Tone } from "@openchamber/sdk/ui";
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
const spacer = el("div", "bar-spacer");
bar.append(spacer);
const tabsHost = el("div", "bar-tabs");
const refreshHost = el("div", "bar-actions");
bar.append(tabsHost, refreshHost);

const tools = el("div", "tools");
const searchHost = el("div");
const frenteRow = el("div", "frente-row");
const frenteTabsHost = el("div", "frente-tabs");
frenteRow.append(frenteTabsHost);
frenteRow.hidden = true;
tools.append(searchHost, frenteRow);
const content = el("div", "content");
root.append(bar, tools, content);

const REFRESH_ICON = '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>';

const createIconButton = (label: string, icon: string, onClick: () => void): HTMLButtonElement => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cu-icon-btn";
  button.setAttribute("aria-label", label);
  button.innerHTML =
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
  button.addEventListener("click", onClick);
  return button;
};

let refreshButton: HTMLButtonElement | null = null;
let frenteTabs: TabsHandle | null = null;
let active: Array<{ dispose: () => void }> = [];

const setRefreshLoading = (loading: boolean): void => {
  if (!refreshButton) return;
  refreshButton.disabled = loading;
  refreshButton.dataset.loading = loading ? "true" : "false";
};

const clearContent = () => {
  for (const handle of active) handle.dispose();
  active = [];
  content.replaceChildren();
  content.classList.remove("cu-center");
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

refreshButton = createIconButton("Refresh", REFRESH_ICON, () => void load(true));
refreshHost.append(refreshButton);

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

// Local "done today" tracking, stored on the OpenChamber server under one key.
const localDateKey = (): string => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const parseDone = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [date, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[date] = ids.filter((id): id is string => typeof id === "string");
  }
  return out;
};

let doneByDate: Record<string, string[]> = {};
let doneToday = new Set<string>();
let todayKey = localDateKey();
let doneLoaded = false;

const readDone = async (): Promise<void> => {
  if (!doneLoaded) {
    try {
      doneByDate = parseDone(await host.storage.get("done"));
    } catch {
      doneByDate = {};
    }
    doneLoaded = true;
  }
  todayKey = localDateKey();
  doneToday = new Set(doneByDate[todayKey] ?? []);
};

const persistDone = async (): Promise<void> => {
  doneByDate[todayKey] = [...doneToday];
  const kept: Record<string, string[]> = {};
  for (const date of Object.keys(doneByDate).sort().reverse().slice(0, 60)) {
    kept[date] = doneByDate[date];
  }
  doneByDate = kept;
  try {
    await host.storage.set("done", doneByDate);
  } catch {
    // Local-only tracking; a failed write is not worth interrupting the panel.
  }
};

// Local notes, one storage key per task (`note:<id>`), never sent to ClickUp.
const notes: Record<string, string> = {};
const editingNote = new Set<string>();
let notesLoaded = false;

const readNotes = async (): Promise<void> => {
  if (notesLoaded) return;
  notesLoaded = true;
  try {
    const keys = await host.storage.keys();
    const noteKeys = keys.filter((key) => key.startsWith("note:"));
    const values = await Promise.all(
      noteKeys.map(async (key) => [key, await host.storage.get(key)] as const),
    );
    for (const [key, value] of values) {
      if (typeof value === "string" && value) notes[key.slice("note:".length)] = value;
    }
  } catch {
    // Notes are local-only; start empty if storage is unavailable.
  }
};

const persistNote = async (taskId: string): Promise<void> => {
  try {
    const value = notes[taskId];
    if (value) await host.storage.set(`note:${taskId}`, value);
    else await host.storage.delete(`note:${taskId}`);
  } catch {
    // Ignore; the note stays in memory for this session.
  }
};

/** Force the next read to pick up changes made outside the panel (e.g. by a script). */
const resetLocal = (): void => {
  doneLoaded = false;
  notesLoaded = false;
  for (const taskId of Object.keys(notes)) delete notes[taskId];
};

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

type NoteController = { element: HTMLElement; open: () => void };

/** The note block under a row: shows the note, or an editor when opened. */
const createNote = (task: ClickUpTask, depth: number): NoteController => {
  const element = el("div", "cu-note-wrap");
  element.style.setProperty("--cu-indent", `${depth * 14}px`);
  const paint = () => {
    element.replaceChildren();
    const value = notes[task.id] ?? "";
    if (editingNote.has(task.id)) {
      let draft = value;
      const editor = el("div", "cu-note-editor");
      const fieldHost = el("div");
      editor.append(fieldHost);
      active.push(
        mountTextField(fieldHost, {
          value,
          multiline: true,
          rows: 3,
          placeholder: "Local note (kept in OpenChamber, not in ClickUp)",
          onChange: (next) => {
            draft = next;
          },
        }),
      );
      const actions = el("div", "cu-note-actions");
      active.push(
        mountButton(actions, {
          label: "Save",
          size: "xs",
          onClick: () => {
            const trimmed = draft.trim();
            if (trimmed) notes[task.id] = trimmed;
            else delete notes[task.id];
            editingNote.delete(task.id);
            syncNoteButton(task.id);
            void persistNote(task.id);
            paint();
          },
        }),
        mountButton(actions, {
          label: "Cancel",
          variant: "ghost",
          size: "xs",
          onClick: () => {
            editingNote.delete(task.id);
            paint();
          },
        }),
      );
      if (value) {
        active.push(
          mountButton(actions, {
            label: "Delete",
            variant: "destructive",
            size: "xs",
            onClick: () => {
              delete notes[task.id];
              editingNote.delete(task.id);
              syncNoteButton(task.id);
              void persistNote(task.id);
              paint();
            },
          }),
        );
      }
      editor.append(actions);
      element.append(editor);
      element.hidden = false;
      return;
    }
    element.hidden = true;
  };
  const open = () => {
    editingNote.add(task.id);
    paint();
  };
  paint();
  return { element, open };
};

const NOTE_ICON =
  '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>';

const noteButtonByTask = new Map<string, HTMLButtonElement>();

const syncNoteButton = (taskId: string): void => {
  const button = noteButtonByTask.get(taskId);
  if (button) button.dataset.has = notes[taskId] ? "true" : "false";
};

const makeNoteButton = (task: ClickUpTask, onNote: () => void): HTMLButtonElement => {
  const button = createIconButton("Add or edit note", NOTE_ICON, onNote);
  button.dataset.has = notes[task.id] ? "true" : "false";
  noteButtonByTask.set(task.id, button);
  return button;
};

const makeDoneCheckbox = (task: ClickUpTask, row: HTMLElement): void => {
  row.classList.toggle("cu-done", doneToday.has(task.id));
  const wrap = el("span", "cu-check");
  wrap.addEventListener("click", (event) => event.stopPropagation());
  wrap.addEventListener("keydown", (event) => event.stopPropagation());
  row.append(wrap);
  const handle = mountCheckbox(wrap, {
    label: "",
    checked: doneToday.has(task.id),
    onChange: (checked) => {
      if (checked) doneToday.add(task.id);
      else doneToday.delete(task.id);
      row.classList.toggle("cu-done", checked);
      handle.update({ checked });
      void persistDone();
    },
  });
  active.push(handle);
};

const makeRow = (task: ClickUpTask, frente: string, onNote: () => void): HTMLElement => {
  const row = el("div", "cu-row");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  makeDoneCheckbox(task, row);
  const main = el("div", "cu-main");
  const title = el("div", "cu-title");
  title.textContent = task.name || "(untitled)";
  main.append(title);
  const subtitle = sprintLabel(task, frente, sprintField());
  const priority = task.priority?.priority;
  if (subtitle || priority) {
    const subEl = el("div", "cu-sub");
    if (subtitle) {
      const sprintText = el("span", "cu-sub-text");
      sprintText.textContent = subtitle;
      subEl.append(sprintText);
    }
    if (priority) {
      const badge = el("span", "cu-badge cu-badge-sm");
      badge.textContent = priority;
      badge.dataset.tone = priorityTone(priority);
      subEl.append(badge);
    }
    main.append(subEl);
  }
  row.append(main);
  const statusDot = makeStatusDot(task);
  if (statusDot) row.append(statusDot);
  const due = formatDue(task);
  if (due) {
    const metaEl = el("span", "cu-meta");
    metaEl.textContent = due;
    row.append(metaEl);
  }
  const noteHost = el("span", "cu-note-btn");
  noteHost.addEventListener("click", (event) => event.stopPropagation());
  noteHost.addEventListener("keydown", (event) => event.stopPropagation());
  noteHost.append(makeNoteButton(task, onNote));
  row.append(noteHost);
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
    const note = createNote(node.task, depth);
    const row = makeRow(node.task, frente, note.open);
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
    container.append(note.element);
    if (childrenBox) {
      renderTree(childrenBox, node.children, depth + 1, frente);
      container.append(childrenBox);
    }
  }
};

// --- Rendering --------------------------------------------------------------

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
    content.classList.add("cu-center");
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
    renderContent();
    return;
  }
  const current = ++generation;
  state.status = { kind: "loading" };
  setRefreshLoading(true);
  renderContent();
  try {
    if (force) {
      user = null;
      teamIds = [];
      resetLocal();
    }
    await readDone();
    await readNotes();
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
      setRefreshLoading(false);
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

renderContent();

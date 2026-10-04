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
  mountCheckbox,
  mountEmpty,
  mountSearchField,
  mountSpinner,
  mountTabs,
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

import {
  EVENTS_MAX,
  localDateKey,
  pushEvent,
  type LocalEvent,
} from "./local.ts";

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
let lastUpdated: string | null = null;

const readUpdated = async (): Promise<string | null> => {
  try {
    const value = await host.storage.get("updated");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

/** Bump the marker external writers set, and the panel polls. */
const touchUpdated = async (): Promise<void> => {
  const stamp = String(Date.now());
  lastUpdated = stamp;
  try {
    await host.storage.set("updated", stamp);
  } catch {
    // Ignore; polling simply will not see this particular write.
  }
};

const readDone = async (): Promise<void> => {  if (!doneLoaded) {
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

const persistDone = async (
  action: "done-add" | "done-remove",
  taskId: string,
): Promise<void> => {
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
  await recordEvent(action, taskId);
};

// Local notes live as markdown files in the user's Obsidian vault, one per
// task. The panel never edits them — clicking the note icon ensures the file
// exists and points Obsidian at it. Nothing is ever sent to ClickUp.
const DEFAULT_NOTES_DIR = "~/Documents/obsidian/ClickUp";

const notesDir = (): string => {
  const configured = state.settings["notes-dir"]?.trim().replace(/\/+$/, "");
  return configured || DEFAULT_NOTES_DIR;
};

const noteFileName = (taskId: string): string => `${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}.md`;

const notePath = (taskId: string): string => `${notesDir()}/${noteFileName(taskId)}`;

/** Task ids that have a note file, from a single directory listing. */
let noteFiles = new Set<string>();

const readNoteFiles = async (): Promise<void> => {
  try {
    const { entries } = await host.listDir(notesDir());
    noteFiles = new Set(
      entries
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -".md".length)),
    );
  } catch {
    // Missing folder (or denied) simply means no notes yet.
    noteFiles = new Set();
  }
};

const noteTemplate = (task: ClickUpTask, body: string): string => {
  const url = task.url || `${DEFAULT_ORIGIN}/t/${task.id}`;
  const label = task.custom_id || task.id;
  const title = task.name ? `${label} - ${task.name}` : label;
  const meta = [sprintLabel(task, frenteFolder(), sprintField()), task.status?.status, task.list?.name]
    .filter(Boolean)
    .join(" · ");
  return `# ${title}\n\n[${label}](${url})${meta ? ` · ${meta}` : ""}\n\n---\n\n${body}`;
};

/** One-time move of pre-file notes (`note:<id>` storage keys) into the vault. */
const migrateStorageNotes = async (): Promise<void> => {
  let keys: string[];
  try {
    keys = (await host.storage.keys()).filter((key) => key.startsWith("note:"));
  } catch {
    return;
  }
  if (keys.length === 0) return;
  for (const key of keys) {
    const taskId = key.slice("note:".length);
    try {
      const value = await host.storage.get(key);
      if (typeof value === "string" && value) {
        const path = notePath(taskId);
        try {
          await host.readFile(path);
        } catch {
          const task = state.tasks.find((entry) => entry.id === taskId);
          await host.writeFile(path, task ? noteTemplate(task, value) : value);
          noteFiles.add(taskId);
          syncNoteButton(taskId);
        }
      }
      await host.storage.delete(key);
    } catch {
      // Leave the key; the next load retries.
    }
  }
};

/** Ensure the note file exists, then open it in Obsidian through the
 * extension's local service (which runs unsandboxed and can launch apps).
 * Falls back to a copyable vault path when the service is unavailable. */
const openInObsidian = (task: ClickUpTask): void => {
  void (async () => {
    const path = notePath(task.id);
    try {
      await host.readFile(path);
    } catch {
      try {
        await host.writeFile(path, noteTemplate(task, ""));
      } catch (error) {
        await host.toast({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      noteFiles.add(task.id);
      renderContent();
      await recordEvent("note-set", task.id);
    }
    let answer: { status: number; body: string };
    try {
      answer = await host.serviceRequest({
        method: "POST",
        path: "/open",
        body: JSON.stringify({ dir: notesDir(), taskId: task.id }),
      });
    } catch (error) {
      const code = error instanceof HostRequestError ? error.code : undefined;
      await host.toast({
        kind: code === "NO_SERVICE" ? "info" : "error",
        message:
          code === "NO_SERVICE"
            ? `Approve the local service in Settings → Extensions, then click again. Note file: ${path}`
            : error instanceof Error
              ? error.message
              : String(error),
        copy: { text: path },
      });
      return;
    }
    let failure: string | null = null;
    let parsed: { ok?: boolean; error?: string } | null = null;
    try {
      parsed = JSON.parse(answer.body) as { ok?: boolean; error?: string };
    } catch {
      parsed = null;
    }
    if (answer.status !== 200) {
      failure = parsed?.error
        ? `Obsidian launcher failed: ${parsed.error}`
        : `Obsidian launcher answered ${answer.status}.`;
    } else if (!parsed?.ok) {
      failure = parsed?.error ? `Obsidian did not open: ${parsed.error}` : "Obsidian did not open.";
    }
    if (failure) {
      await host.toast({
        kind: "error",
        message: `${failure} Note file: ${path}`,
        copy: { text: path },
      });
      return;
    }
    await host.toast({ kind: "success", message: `Opened ${noteFileName(task.id)} in Obsidian.` });
  })();
};

// Append-only history with timestamps. Stored only; nothing shows it in the UI.
const events: LocalEvent[] = [];
let eventsLoaded = false;

const readEvents = async (): Promise<void> => {
  if (eventsLoaded) return;
  eventsLoaded = true;
  try {
    const value = await host.storage.get("events");
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as LocalEvent).at === "string" &&
          typeof (entry as LocalEvent).taskId === "string"
        ) {
          const record = entry as LocalEvent;
          events.push({
            at: record.at,
            type: String(record.type ?? ""),
            taskId: record.taskId,
            date: typeof record.date === "string" ? record.date : undefined,
          });
        }
      }
    }
  } catch {
    // History is best-effort.
  }
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
};

const recordEvent = async (type: string, taskId: string, date?: string): Promise<void> => {
  pushEvent(events, type, taskId, date);
  try {
    await host.storage.set("events", events);
  } catch {
    // Best-effort; the state change itself already succeeded.
  }
  await touchUpdated();
};

/** Force the next read to pick up changes made outside the panel (e.g. by a script). */
const resetLocal = (): void => {
  doneLoaded = false;
  eventsLoaded = false;
  events.length = 0;
};

/** Re-read local state when an external writer (script or MCP) bumps `updated`. */
const pollLocal = async (): Promise<void> => {
  if (document.visibilityState !== "visible") return;
  const stamp = await readUpdated();
  if (!stamp || stamp === lastUpdated) return;
  lastUpdated = stamp;
  resetLocal();
  await readDone();
  await readNoteFiles();
  if (state.connected && state.status.kind === "idle") {
    const top = content.scrollTop;
    renderContent();
    content.scrollTop = top;
  }
};

const startLocalPolling = (): void => {
  window.setInterval(() => void pollLocal(), 10_000);
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

const NOTE_ICON =
  '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2Z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>';

const noteButtonByTask = new Map<string, HTMLButtonElement>();

const makeNoteButton = (task: ClickUpTask): HTMLButtonElement => {
  const button = createIconButton("Open note in Obsidian", NOTE_ICON, () => openInObsidian(task));
  button.dataset.has = noteFiles.has(task.id) ? "true" : "false";
  noteButtonByTask.set(task.id, button);
  return button;
};

const syncNoteButton = (taskId: string): void => {
  const button = noteButtonByTask.get(taskId);
  if (button) button.dataset.has = noteFiles.has(taskId) ? "true" : "false";
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
      void persistDone(checked ? "done-add" : "done-remove", task.id);
    },
  });
  active.push(handle);
};

const makeRow = (task: ClickUpTask, frente: string): HTMLElement => {
  const row = el("div", "cu-row");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  makeDoneCheckbox(task, row);
  const main = el("div", "cu-main");
  const title = el("div", "cu-title");
  const idSpan = el("span", "cu-id");
  idSpan.textContent = shortId(task);
  const nameSpan = el("span", "cu-name");
  nameSpan.textContent = task.name || "(untitled)";
  title.append(idSpan, document.createTextNode(" "), nameSpan);
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
  noteHost.append(makeNoteButton(task));
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
    await readNoteFiles();
    await readEvents();
    lastUpdated = await readUpdated();
    await ensureContext();
    const tasks = await fetchAssignedTasks(callClickUp, teamIds, String(user!.id), state.filter === "all");
    if (current !== generation) return;
    state.tasks = tasks;
    await migrateStorageNotes();
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
  const teamChanged = (settings?.["team-id"] ?? "") !== (state.settings["team-id"] ?? "");
  const dirChanged = (settings?.["notes-dir"] ?? "") !== (state.settings["notes-dir"] ?? "");
  state.settings = settings ?? {};
  if ((teamChanged || dirChanged) && state.connected) void load(true);
});

renderContent();
startLocalPolling();

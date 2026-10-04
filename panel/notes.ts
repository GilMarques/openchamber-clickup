// Full-screen "ClickUp Notes" page (contributes.page), Files-style split layout.
//
// Opened from the Extension pages menu in the main area. Layout mirrors the
// host Files view: a tabs row of open notes on top, a hiddable notes list on
// the left, and a hiddable viewer on the right with per-note view/edit modes.
// Notes stay local to OpenChamber.
import { connectHost } from "@openchamber/sdk";
import {
  applyHostReady,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSpinner,
} from "@openchamber/sdk/ui";
import { marked } from "marked";
import { EditorView } from "@codemirror/view";
import { makeEditor } from "./editor.ts";
import {
  fetchAssignedTasks,
  sprintLabel,
  type ClickUpRequest,
  type ClickUpTask,
} from "./clickup.ts";
import { noteKey, pushEvent, type LocalEvent } from "./local.ts";

const host = connectHost();
const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Missing #root");

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

type ViewMode = "view" | "edit";

// --- Shell (built once) -----------------------------------------------------

const bar = el("div", "bar");
const title = el("div", "title");
title.textContent = "ClickUp Notes";
const count = el("div", "count");
const spacer = el("div", "spacer");
const listToggleHost = el("div");
const viewerToggleHost = el("div");
const refreshHost = el("div");
bar.append(title, count, spacer, listToggleHost, viewerToggleHost, refreshHost);

const tabsHost = el("div", "tabs");
tabsHost.setAttribute("role", "tablist");

const body = el("div", "nbody");
const left = el("section", "left");
const leftHead = el("div", "left-head");
const searchHost = el("div", "left-search");
leftHead.append(searchHost);
const leftList = el("div", "left-list");
leftList.setAttribute("role", "listbox");
left.append(leftHead, leftList);

const right = el("section", "right");
const viewerHead = el("div", "viewer-head");
const viewerTitle = el("div", "viewer-title");
const viewerActions = el("div", "viewer-actions");
viewerHead.append(viewerTitle, viewerActions);
const viewerMeta = el("div", "viewer-meta");
const viewerBody = el("div", "viewer-body");
right.append(viewerHead, viewerMeta, viewerBody);

body.append(left, right);
root.append(bar, tabsHost, body);

// --- State ------------------------------------------------------------------

let notes: Record<string, string> = {};
let lastNoteAt: Record<string, string> = {};
let tasks = new Map<string, ClickUpTask>();
let ids: string[] = [];
let openIds: string[] = [];
let activeId: string | null = null;
let modes: Record<string, ViewMode> = {};
let drafts: Record<string, string> = {};
let leftVisible = true;
let viewerVisible = true;
let query = "";
let settings: Record<string, string> = {};
let editorView: EditorView | null = null;
let editorTaskId: string | null = null;
let loading = false;
let loadError: string | null = null;
let lastUpdated: string | null = null;

const frenteFolder = (): string => settings["frente-folder"]?.trim() || "Frentes";
const sprintField = (): string => settings["sprint-field"]?.trim() || "Sprints";

let handles: Array<{ dispose: () => void }> = [];
const track = (handle: { dispose: () => void }): void => {
  handles.push(handle);
};

// --- Data -------------------------------------------------------------------

const requestJson = async <T,>(path: string, queryParams?: Record<string, string>): Promise<T> => {
  const result = await host.request({ method: "GET", path, query: queryParams });
  if (result.status === 401 || result.status === 403) throw new Error("ClickUp rejected the token.");
  if (result.status < 200 || result.status >= 300) throw new Error(`ClickUp answered ${result.status}`);
  return JSON.parse(result.body) as T;
};

const readNotes = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const keys = await host.storage.keys();
  const entries = await Promise.all(
    keys
      .filter((key) => key.startsWith("note:"))
      .map(async (key) => [key.slice("note:".length), await host.storage.get(key)] as const),
  );
  for (const [taskId, text] of entries) {
    if (typeof text === "string" && text) out[taskId] = text;
  }
  return out;
};

/** Latest note-set timestamp per task, from the local event log. */
const readLastNoteAt = async (): Promise<Record<string, string>> => {
  const last: Record<string, string> = {};
  try {
    const events = await host.storage.get("events");
    if (Array.isArray(events)) {
      for (const event of events) {
        const record = event as { at?: unknown; type?: unknown; taskId?: unknown };
        if (record?.type === "note-set" && typeof record.taskId === "string" && typeof record.at === "string") {
          last[record.taskId] = record.at;
        }
      }
    }
  } catch {
    // Ordering is best-effort.
  }
  return last;
};

const readUpdated = async (): Promise<string | null> => {
  try {
    const value = await host.storage.get("updated");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const loadTasks = async (): Promise<Map<string, ClickUpTask>> => {
  const me = await requestJson<{ user: { id: number } }>("/api/v2/user");
  const teams = await requestJson<{ teams: Array<{ id: string | number }> }>("/api/v2/team");
  const request: ClickUpRequest = (path, queryParams) => host.request({ method: "GET", path, query: queryParams });
  const fetched = await fetchAssignedTasks(
    request,
    (teams.teams ?? []).map((team) => String(team.id)),
    String(me.user.id),
    true,
  );
  return new Map(fetched.map((task) => [task.id, task]));
};

/** Write a note (or delete it when empty), append the event, and bump the poll marker. */
const persistNote = async (taskId: string, text: string): Promise<void> => {
  const trimmed = text.trim();
  try {
    if (trimmed) await host.storage.set(noteKey(taskId), trimmed);
    else await host.storage.delete(noteKey(taskId));
  } catch {
    // Fall through to the event write; the caller shows errors.
  }
  let events: LocalEvent[] = [];
  try {
    const stored = await host.storage.get("events");
    if (Array.isArray(stored)) events = stored as LocalEvent[];
  } catch {
    events = [];
  }
  pushEvent(events, trimmed ? "note-set" : "note-delete", taskId);
  try {
    await host.storage.set("events", events);
    await host.storage.set("updated", String(Date.now()));
  } catch {
    // Best-effort history.
  }
};

const saveUI = async (): Promise<void> => {
  try {
    await host.storage.set("notes-ui", { openIds, activeId, leftVisible, viewerVisible });
  } catch {
    // UI prefs are best-effort.
  }
};

const loadUI = async (): Promise<void> => {
  try {
    const stored = (await host.storage.get("notes-ui")) as {
      openIds?: unknown;
      activeId?: unknown;
      leftVisible?: unknown;
      viewerVisible?: unknown;
    } | null;
    if (stored && typeof stored === "object") {
      if (Array.isArray(stored.openIds)) {
        openIds = stored.openIds.filter((id): id is string => typeof id === "string");
      }
      if (typeof stored.activeId === "string" || stored.activeId === null) activeId = stored.activeId;
      if (typeof stored.leftVisible === "boolean") leftVisible = stored.leftVisible;
      if (typeof stored.viewerVisible === "boolean") viewerVisible = stored.viewerVisible;
    }
  } catch {
    // Defaults stand.
  }
};

// --- Markdown rendering -----------------------------------------------------

/** Markdown to HTML, with scripts/event handlers stripped before it lands in the DOM. */
const renderMarkdown = (container: HTMLElement, text: string): void => {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const node of doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta")) {
    node.remove();
  }
  for (const node of doc.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (attr.name === "href" && /^\s*javascript:/i.test(attr.value)) node.removeAttribute("href");
    }
  }
  container.innerHTML = doc.body.innerHTML;
};

root.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement | null)?.closest("a");
  const href = anchor?.getAttribute("href");
  if (href && /^https?:/i.test(href)) {
    event.preventDefault();
    void host.openUrl(href);
  }
});

// --- Helpers ----------------------------------------------------------------

const destroyEditor = (): void => {
  editorView?.destroy();
  editorView = null;
  editorTaskId = null;
};

const taskTitle = (taskId: string): string => tasks.get(taskId)?.name ?? taskId;

const metaFor = (taskId: string): string => {
  const task = tasks.get(taskId);
  const parts = task
    ? [sprintLabel(task, frenteFolder(), sprintField()), task.status?.status, task.list?.name]
    : [];
  if (lastNoteAt[taskId]) parts.push(`saved ${new Date(lastNoteAt[taskId]).toLocaleString()}`);
  return parts.filter(Boolean).join(" · ") || taskId;
};

const matchesQuery = (taskId: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const task = tasks.get(taskId);
  return `${task?.name ?? ""} ${taskId} ${notes[taskId] ?? ""}`.toLowerCase().includes(q);
};

// --- Tabs -------------------------------------------------------------------

const openNote = (taskId: string): void => {
  if (!notes[taskId]) return;
  if (!openIds.includes(taskId)) openIds.push(taskId);
  activeId = taskId;
  if (!notes[taskId] && modes[taskId] === undefined) modes[taskId] = "edit";
  void saveUI();
  renderTabs();
  renderList();
  renderViewer();
};

const closeTab = (taskId: string): void => {
  openIds = openIds.filter((id) => id !== taskId);
  if (activeId === taskId) {
    activeId = openIds.length > 0 ? openIds[openIds.length - 1] : null;
  }
  // Drafts survive a closed tab so unsaved text is not lost.
  void saveUI();
  renderTabs();
  renderList();
  renderViewer();
};

const renderTabs = (): void => {
  tabsHost.replaceChildren();
  if (openIds.length === 0) {
    tabsHost.hidden = true;
    return;
  }
  tabsHost.hidden = false;
  for (const taskId of openIds) {
    const tab = el("button", "tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(taskId === activeId));
    if (taskId === activeId) tab.classList.add("active");
    const label = el("span", "tab-label");
    label.textContent = taskTitle(taskId);
    label.title = taskTitle(taskId);
    tab.append(label);
    if (drafts[taskId] !== undefined) {
      const dot = el("span", "tab-dirty");
      dot.title = "Unsaved changes";
      tab.append(dot);
    }
    const close = el("button", "tab-close");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${taskTitle(taskId)}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(taskId);
    });
    tab.append(close);
    tab.addEventListener("click", () => {
      if (activeId !== taskId) {
        activeId = taskId;
        void saveUI();
        renderTabs();
        renderList();
        renderViewer();
      }
    });
    tabsHost.append(tab);
  }
};

// --- Left list ---------------------------------------------------------------

const renderList = (): void => {
  leftList.replaceChildren();
  const visible = ids.filter(matchesQuery);
  for (const taskId of visible) {
    const row = el("button", "note-row");
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(taskId === activeId));
    if (taskId === activeId) row.classList.add("active");
    const rowTitle = el("div", "note-row-title");
    rowTitle.textContent = taskTitle(taskId);
    rowTitle.title = taskTitle(taskId);
    const rowSub = el("div", "note-row-sub");
    rowSub.textContent = metaFor(taskId);
    row.append(rowTitle, rowSub);
    if (drafts[taskId] !== undefined) {
      const dot = el("span", "draft-dot");
      dot.title = "Unsaved changes";
      row.append(dot);
    }
    row.addEventListener("click", () => openNote(taskId));
    leftList.append(row);
  }
  if (visible.length === 0) {
    const empty = el("div", "left-empty");
    empty.textContent = query.trim() ? "No matching notes" : "No notes";
    leftList.append(empty);
  }
};

// --- Right viewer ------------------------------------------------------------

const paintViewerActions = (taskId: string, mode: ViewMode): void => {
  viewerActions.replaceChildren();
  if (mode === "view") {
    track(
      mountButton(viewerActions, {
        label: "Edit",
        variant: "ghost",
        size: "xs",
        onClick: () => {
          modes[taskId] = "edit";
          renderViewer();
        },
      }),
    );
    return;
  }
  track(
    mountButton(viewerActions, {
      label: "Save",
      size: "xs",
      onClick: () => void saveEdit(taskId),
    }),
  );
  track(
    mountButton(viewerActions, {
      label: "Cancel",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        delete drafts[taskId];
        modes[taskId] = "view";
        renderTabs();
        renderList();
        renderViewer();
      },
    }),
  );
  if (notes[taskId]) {
    track(
      mountButton(viewerActions, {
        label: "Delete",
        variant: "destructive",
        size: "xs",
        onClick: () => void deleteNote(taskId),
      }),
    );
  }
};

const saveEdit = async (taskId: string): Promise<void> => {
  const value = (editorView && editorTaskId === taskId ? editorView.state.doc.toString() : drafts[taskId] ?? "").trim();
  try {
    await persistNote(taskId, value);
  } catch (error) {
    await host.toast({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (value) {
    notes[taskId] = value;
    lastNoteAt[taskId] = new Date().toISOString();
  } else {
    delete notes[taskId];
  }
  delete drafts[taskId];
  modes[taskId] = "view";
  ids = Object.keys(notes).sort(
    (a, b) => (lastNoteAt[b] ?? "").localeCompare(lastNoteAt[a] ?? "") || a.localeCompare(b),
  );
  if (!notes[taskId]) {
    closeTab(taskId);
    return;
  }
  renderTabs();
  renderList();
  renderViewer();
  updateCount();
};

const deleteNote = async (taskId: string): Promise<void> => {
  try {
    await persistNote(taskId, "");
  } catch (error) {
    await host.toast({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  delete notes[taskId];
  delete drafts[taskId];
  delete modes[taskId];
  ids = ids.filter((id) => id !== taskId);
  closeTab(taskId);
  updateCount();
};

const renderViewer = (): void => {
  destroyEditor();
  for (const handle of handles) handle.dispose();
  handles = [];
  viewerTitle.replaceChildren();
  viewerMeta.textContent = "";
  viewerBody.replaceChildren();

  if (!viewerVisible) {
    right.hidden = true;
    return;
  }
  right.hidden = false;
  paintToggles();

  if (!activeId || !notes[activeId]) {
    const empty = el("div", "viewer-empty");
    empty.textContent = openIds.length > 0 ? "Select a note" : "No notes open";
    viewerBody.append(empty);
    return;
  }

  const taskId = activeId;
  const task = tasks.get(taskId);
  const link = el("a", "viewer-link");
  link.href = task?.url ?? `https://app.clickup.com/t/${taskId}`;
  link.textContent = task?.name ?? taskId;
  viewerTitle.append(link);
  viewerMeta.textContent = metaFor(taskId);

  const mode = modes[taskId] ?? "view";
  paintViewerActions(taskId, mode);
  if (mode === "view") {
    const rendered = el("div", "md");
    renderMarkdown(rendered, notes[taskId]);
    viewerBody.append(rendered);
    return;
  }

  const editorHost = el("div", "editor");
  viewerBody.append(editorHost);
  const startingText = drafts[taskId] ?? notes[taskId] ?? "";
  const save = () => void saveEdit(taskId);
  const view = makeEditor(editorHost, startingText, save);
  editorView = view;
  editorTaskId = taskId;
  view.contentDOM.addEventListener("input", () => {
    drafts[taskId] = view.state.doc.toString();
    renderTabs();
    renderList();
  });
  view.focus();
};

// --- Toggles, count, shell controls ------------------------------------------

const paintToggles = (): void => {
  listToggleHost.replaceChildren();
  viewerToggleHost.replaceChildren();
  track(
    mountButton(listToggleHost, {
      label: leftVisible ? "Hide list" : "Show list",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        leftVisible = !leftVisible;
        left.hidden = !leftVisible;
        void saveUI();
        paintToggles();
      },
    }),
  );
  track(
    mountButton(viewerToggleHost, {
      label: viewerVisible ? "Hide viewer" : "Show viewer",
      variant: "ghost",
      size: "xs",
      onClick: () => {
        viewerVisible = !viewerVisible;
        void saveUI();
        renderViewer();
      },
    }),
  );
};

const updateCount = (): void => {
  count.textContent = ids.length === 1 ? "1 note" : `${ids.length} notes`;
};

let listToggleInit = false;
const initShellControls = (): void => {
  if (listToggleInit) return;
  listToggleInit = true;
  track(
    mountSearchField(searchHost, {
      value: "",
      placeholder: "Filter notes",
      label: "Filter notes",
      onChange: (value) => {
        query = value;
        renderList();
      },
    }),
  );
  paintToggles();
};

// --- Load + poll -------------------------------------------------------------

const reconcile = (): void => {
  ids = Object.keys(notes).sort(
    (a, b) => (lastNoteAt[b] ?? "").localeCompare(lastNoteAt[a] ?? "") || a.localeCompare(b),
  );
  openIds = openIds.filter((id) => notes[id] || drafts[id] !== undefined);
  if (activeId && (!notes[activeId] || !openIds.includes(activeId))) {
    activeId = openIds.length > 0 ? openIds[openIds.length - 1] : null;
  }
  if (!activeId && openIds.length === 0 && ids.length > 0) {
    openIds = [ids[0]];
    activeId = ids[0];
  }
};

const renderAll = (): void => {
  left.hidden = !leftVisible;
  updateCount();
  renderTabs();
  renderList();
  renderViewer();
};

const showLoading = (): void => {
  body.replaceChildren();
  const wrap = el("div", "loading-wrap");
  body.append(wrap);
  track(mountSpinner(wrap, { label: "Loading notes" }));
};

const restoreBody = (): void => {
  body.replaceChildren();
  body.append(left, right);
};

const loadAll = async (initial: boolean): Promise<void> => {
  loading = true;
  loadError = null;
  if (initial) showLoading();
  try {
    const [freshNotes, freshLastNoteAt] = await Promise.all([readNotes(), readLastNoteAt()]);
    let freshTasks = new Map<string, ClickUpTask>();
    try {
      freshTasks = await loadTasks();
    } catch {
      if (initial) throw new Error("ClickUp rejected the token.");
      // Keep old task titles on background refreshes.
      freshTasks = tasks;
    }
    notes = freshNotes;
    lastNoteAt = freshLastNoteAt;
    tasks = freshTasks;
    lastUpdated = await readUpdated();
    if (initial) await loadUI();
    reconcile();
    if (initial) {
      restoreBody();
      initShellControls();
    }
    renderAll();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    if (initial) {
      restoreBody();
      body.replaceChildren();
      track(mountEmpty(body, { title: "Could not load notes", body: loadError ?? "" }));
    } else {
      await host.toast({ kind: "error", message: loadError ?? "Could not load notes" });
    }
  } finally {
    loading = false;
  }
};

/** Re-read local state when an external writer bumps `updated`. Skips while editing. */
const pollLocal = async (): Promise<void> => {
  if (document.visibilityState !== "visible" || loading || editorView) return;
  const stamp = await readUpdated();
  if (!stamp || stamp === lastUpdated) return;
  lastUpdated = stamp;
  try {
    const [freshNotes, freshLastNoteAt] = await Promise.all([readNotes(), readLastNoteAt()]);
    notes = freshNotes;
    lastNoteAt = freshLastNoteAt;
    reconcile();
    renderAll();
  } catch {
    // Next poll retries.
  }
};

let refreshButton: ReturnType<typeof mountButton> | null = null;
refreshButton = mountButton(refreshHost, {
  label: "Refresh",
  variant: "secondary",
  size: "sm",
  onClick: () => void loadAll(false),
});

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  const next = ctx.settings ?? {};
  const folderChanged = (next["frente-folder"] ?? "") !== (settings["frente-folder"] ?? "");
  const fieldChanged = (next["sprint-field"] ?? "") !== (settings["sprint-field"] ?? "");
  settings = next;
  if ((folderChanged || fieldChanged) && !editorView) {
    renderList();
    renderViewer();
  }
});

host.onSettings((next) => {
  settings = next ?? {};
  if (!editorView) {
    renderList();
    renderViewer();
  }
});

window.setInterval(() => void pollLocal(), 10_000);

void loadAll(true);

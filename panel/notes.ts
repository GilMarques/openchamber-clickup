// Full-screen "ClickUp Notes" page (contributes.page).
//
// Opened from the Extension pages menu in the main area. Every local note is
// rendered as markdown and can be edited in place with CodeMirror (markdown
// highlighting, Cmd/Ctrl+S to save). Notes stay local to OpenChamber.
import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountButton, mountEmpty, mountSpinner } from "@openchamber/sdk/ui";
import { marked } from "marked";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  defineLanguageFacet,
  Language,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { GFM, parser as markdownParser } from "@lezer/markdown";
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

const bar = el("div", "bar");
const title = el("div", "title");
title.textContent = "ClickUp Notes";
const count = el("div", "count");
const spacer = el("div", "spacer");
const refreshHost = el("div");
bar.append(title, count, spacer, refreshHost);
const content = el("div", "content");
root.append(bar, content);

let active: Array<{ dispose: () => void }> = [];
let settings: Record<string, string> = {};
const frenteFolder = (): string => settings["frente-folder"]?.trim() || "Frentes";
const sprintField = (): string => settings["sprint-field"]?.trim() || "Sprints";

const clear = () => {
  for (const handle of active) handle.dispose();
  active = [];
  content.replaceChildren();
  content.classList.remove("cu-center");
};

const updateCount = () => {
  const total = content.querySelectorAll(".card").length;
  count.textContent = total === 1 ? "1 note" : `${total} notes`;
};

// --- Data -------------------------------------------------------------------

const requestJson = async <T,>(path: string, query?: Record<string, string>): Promise<T> => {
  const result = await host.request({ method: "GET", path, query });
  if (result.status === 401 || result.status === 403) throw new Error("ClickUp rejected the token.");
  if (result.status < 200 || result.status >= 300) throw new Error(`ClickUp answered ${result.status}`);
  return JSON.parse(result.body) as T;
};

const readNotes = async (): Promise<Record<string, string>> => {
  const notes: Record<string, string> = {};
  const keys = await host.storage.keys();
  const entries = await Promise.all(
    keys
      .filter((key) => key.startsWith("note:"))
      .map(async (key) => [key.slice("note:".length), await host.storage.get(key)] as const),
  );
  for (const [taskId, text] of entries) {
    if (typeof text === "string" && text) notes[taskId] = text;
  }
  return notes;
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

const loadTasks = async (): Promise<Map<string, ClickUpTask>> => {
  const me = await requestJson<{ user: { id: number } }>("/api/v2/user");
  const teams = await requestJson<{ teams: Array<{ id: string | number }> }>("/api/v2/team");
  const request: ClickUpRequest = (path, query) => host.request({ method: "GET", path, query });
  const tasks = await fetchAssignedTasks(
    request,
    (teams.teams ?? []).map((team) => String(team.id)),
    String(me.user.id),
    true,
  );
  return new Map(tasks.map((task) => [task.id, task]));
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

content.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement | null)?.closest("a");
  const href = anchor?.getAttribute("href");
  if (href && /^https?:/i.test(href)) {
    event.preventDefault();
    void host.openUrl(href);
  }
});

// --- Editor -----------------------------------------------------------------

const editorTheme = () =>
  EditorView.theme(
    {
      "&": { color: "var(--oc-fg, inherit)", backgroundColor: "transparent", fontSize: "13px" },
      ".cm-content": { fontFamily: "var(--oc-mono, monospace)", padding: "8px 0" },
      ".cm-line": { padding: "0 10px" },
      "&.cm-focused": { outline: "none" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--oc-muted, inherit)",
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: "var(--oc-hover, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--oc-hover, transparent)" },
      ".cm-cursor": { borderLeftColor: "var(--oc-fg, inherit)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--oc-selection, rgba(127,127,127,0.3))",
      },
    },
    { dark: document.documentElement.dataset.ocTheme === "dark" },
  );

// Bare markdown parser: @codemirror/lang-markdown would also bundle the HTML,
// CSS and JS grammars for embedded blocks (~1 MB); notes do not need them.
// `Language` (not `LRLanguage`) is the wrapper for non-LR parsers.
const markdownLanguage = new LanguageSupport(
  new Language(defineLanguageFacet(), markdownParser.configure([GFM]), [], "markdown"),
);

const makeEditor = (parent: HTMLElement, text: string, save: () => void): EditorView => {
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      markdownLanguage,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      editorTheme(),
    ],
  });
  return new EditorView({ state, parent });
};

// --- Cards ------------------------------------------------------------------

const metaFor = (task: ClickUpTask | undefined, taskId: string, savedAt?: string): string => {
  const parts = task
    ? [sprintLabel(task, frenteFolder(), sprintField()), task.status?.status, task.list?.name]
    : [];
  if (savedAt) parts.push(`saved ${new Date(savedAt).toLocaleString()}`);
  return parts.filter(Boolean).join(" · ") || taskId;
};

const renderCard = (
  taskId: string,
  task: ClickUpTask | undefined,
  initialText: string,
  initialSavedAt: string | undefined,
): HTMLElement => {
  let text = initialText;
  let savedAt = initialSavedAt;

  const card = el("div", "card");
  const head = el("div", "card-head");
  const heading = el("div", "card-title");
  const link = el("a");
  link.href = task?.url ?? `https://app.clickup.com/t/${taskId}`;
  link.textContent = task?.name ?? taskId;
  heading.append(link);
  const actions = el("div", "card-actions");
  head.append(heading, el("div", "spacer"), actions);
  const meta = el("div", "card-meta");
  const body = el("div", "card-body");
  card.append(head, meta, body);

  const paintMeta = () => {
    meta.textContent = metaFor(task, taskId, savedAt);
  };

  const showView = () => {
    actions.replaceChildren();
    active.push(
      mountButton(actions, {
        label: "Edit",
        variant: "ghost",
        size: "xs",
        onClick: () => showEdit(),
      }),
    );
    body.replaceChildren();
    const rendered = el("div", "md");
    renderMarkdown(rendered, text);
    body.append(rendered);
  };

  const showEdit = () => {
    actions.replaceChildren();
    body.replaceChildren();
    const editorHost = el("div", "editor");
    body.append(editorHost);
    let view: EditorView | null = null;

    const save = async () => {
      const value = (view?.state.doc.toString() ?? text).trim();
      try {
        await persistNote(taskId, value);
      } catch (error) {
        await host.toast({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      text = value;
      savedAt = new Date().toISOString();
      view?.destroy();
      paintMeta();
      if (!text) {
        card.remove();
        updateCount();
        return;
      }
      showView();
    };

    const cancel = () => {
      view?.destroy();
      showView();
    };

    view = makeEditor(editorHost, text, () => void save());
    active.push(
      mountButton(actions, { label: "Save", size: "xs", onClick: () => void save() }),
      mountButton(actions, { label: "Cancel", variant: "ghost", size: "xs", onClick: cancel }),
    );
    if (text) {
      active.push(
        mountButton(actions, {
          label: "Delete",
          variant: "destructive",
          size: "xs",
          onClick: async () => {
            await persistNote(taskId, "");
            view?.destroy();
            card.remove();
            updateCount();
          },
        }),
      );
    }
    view.focus();
  };

  paintMeta();
  showView();
  return card;
};

// --- Page -------------------------------------------------------------------

const render = async (): Promise<void> => {
  clear();
  refreshButton?.update({ loading: true, disabled: true });
  content.classList.add("cu-center");
  active.push(mountSpinner(content, { label: "Loading notes" }));
  try {
    const [notes, lastNoteAt] = await Promise.all([readNotes(), readLastNoteAt()]);
    let tasks = new Map<string, ClickUpTask>();
    try {
      tasks = await loadTasks();
    } catch {
      // Task titles are a nicety; notes still render without them.
    }
    clear();
    const ids = Object.keys(notes).sort(
      (a, b) => (lastNoteAt[b] ?? "").localeCompare(lastNoteAt[a] ?? "") || a.localeCompare(b),
    );
    if (ids.length === 0) {
      count.textContent = "0 notes";
      active.push(
        mountEmpty(content, {
          title: "No local notes yet",
          body: "Add one from the ClickUp Tasks panel, or let an agent write one.",
        }),
      );
      return;
    }
    for (const taskId of ids) {
      content.append(renderCard(taskId, tasks.get(taskId), notes[taskId], lastNoteAt[taskId]));
    }
    updateCount();
  } catch (error) {
    clear();
    active.push(
      mountEmpty(content, {
        title: "Could not load notes",
        body: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    refreshButton?.update({ loading: false, disabled: false });
  }
};

let refreshButton: ReturnType<typeof mountButton> | null = null;
refreshButton = mountButton(refreshHost, {
  label: "Refresh",
  variant: "secondary",
  size: "sm",
  onClick: () => void render(),
});

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  settings = ctx.settings ?? {};
});

void render();

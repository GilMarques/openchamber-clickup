// Full-screen "ClickUp Notes" page (contributes.page).
//
// Opened from the Extension pages menu in the main area. Renders every local
// note as markdown, newest note first. Notes stay local to OpenChamber.
import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountButton, mountEmpty, mountSpinner } from "@openchamber/sdk/ui";
import { marked } from "marked";
import {
  fetchAssignedTasks,
  sprintLabel,
  type ClickUpRequest,
  type ClickUpTask,
} from "./clickup.ts";

const host = connectHost();
const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Missing #root");

const bar = document.createElement("div");
bar.className = "bar";
const title = document.createElement("div");
title.className = "title";
title.textContent = "ClickUp Notes";
const count = document.createElement("div");
count.className = "count";
const spacer = document.createElement("div");
spacer.className = "spacer";
const exportHost = document.createElement("div");
const refreshHost = document.createElement("div");
bar.append(title, count, spacer, exportHost, refreshHost);
const content = document.createElement("div");
content.className = "content";
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
    count.textContent = ids.length === 1 ? "1 note" : `${ids.length} notes`;
    if (ids.length === 0) {
      active.push(
        mountEmpty(content, {
          title: "No local notes yet",
          body: "Add one from the ClickUp Tasks panel, or let an agent write one.",
        }),
      );
      return;
    }
    for (const taskId of ids) {
      const task = tasks.get(taskId);
      const card = document.createElement("div");
      card.className = "card";
      const heading = document.createElement("div");
      heading.className = "card-title";
      const link = document.createElement("a");
      link.href = task?.url ?? `https://app.clickup.com/t/${taskId}`;
      link.textContent = task?.name ?? taskId;
      heading.append(link);
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = task
        ? [
            sprintLabel(task, frenteFolder(), sprintField()),
            task.status?.status,
            task.list?.name,
            lastNoteAt[taskId] ? new Date(lastNoteAt[taskId]).toLocaleString() : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : taskId;
      const body = document.createElement("div");
      body.className = "md";
      renderMarkdown(body, notes[taskId]);
      card.append(heading, meta, body);
      content.append(card);
    }
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

/** Export every note to a markdown file the Files panel (or files-nav) can open. */
const EXPORT_PATH = "~/clickup-notes.md";
let exportButton: ReturnType<typeof mountButton> | null = null;

const exportNotes = async (): Promise<void> => {
  exportButton?.update({ loading: true, disabled: true });
  try {
    const [notes, lastNoteAt] = await Promise.all([readNotes(), readLastNoteAt()]);
    let tasks = new Map<string, ClickUpTask>();
    try {
      tasks = await loadTasks();
    } catch {
      // Export without titles if the API is unavailable.
    }
    const ids = Object.keys(notes).sort(
      (a, b) => (lastNoteAt[b] ?? "").localeCompare(lastNoteAt[a] ?? "") || a.localeCompare(b),
    );
    const lines: string[] = [
      "# ClickUp Notes",
      "",
      `_${ids.length} note${ids.length === 1 ? "" : "s"} · exported ${new Date().toLocaleString()} · local to OpenChamber, never sent to ClickUp_`,
      "",
    ];
    for (const taskId of ids) {
      const task = tasks.get(taskId);
      const url = task?.url ?? `https://app.clickup.com/t/${taskId}`;
      const title = task?.name ?? taskId;
      const meta = task
        ? [sprintLabel(task, frenteFolder(), sprintField()), task.status?.status, task.list?.name]
            .filter(Boolean)
            .join(" · ")
        : "";
      lines.push(
        `## ${title}`,
        "",
        `[${taskId}](${url})${meta ? ` · ${meta}` : ""}${
          lastNoteAt[taskId] ? ` · saved ${new Date(lastNoteAt[taskId]).toLocaleString()}` : ""
        }`,
        "",
        notes[taskId],
        "",
        "---",
        "",
      );
    }
    await host.writeFile(EXPORT_PATH, lines.join("\n"));
    await host.toast({
      kind: "success",
      message: `Notes exported to ${EXPORT_PATH}`,
      copy: { text: EXPORT_PATH },
    });
  } catch (error) {
    await host.toast({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    exportButton?.update({ loading: false, disabled: false });
  }
};

exportButton = mountButton(exportHost, {
  label: "Export",
  variant: "secondary",
  size: "sm",
  onClick: () => void exportNotes(),
});

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  settings = ctx.settings ?? {};
});

void render();

#!/usr/bin/env node
// Read/write the ClickUp Tasks extension's local state.
//
// Notes live as markdown files in the user's Obsidian vault (one per task), so
// Obsidian and any agent share the same files. Done ticks and the event log
// stay in OpenChamber's guest storage as plain JSON, which the panel polls.
//
// Notes dir: $CLICKUP_NOTES_DIR or ~/Documents/obsidian/ClickUp
// Storage:   ~/.config/openchamber/guest-storage/clickup-tasks.json
// Shape: { "done": { "YYYY-MM-DD": ["<taskId>", ...] },
//          "events": [ { "at", "type", "taskId", "date?" } ],
//          "updated": "<epoch ms>" }
//
// Usage:
//   node scripts/state.mjs list
//   node scripts/state.mjs notes
//   node scripts/state.mjs note-set <taskId> <text...>
//   node scripts/state.mjs note-del <taskId>
//   node scripts/state.mjs note-open <taskId>
//   node scripts/state.mjs done-list [YYYY-MM-DD]
//   node scripts/state.mjs done-add <taskId> [YYYY-MM-DD]
//   node scripts/state.mjs done-remove <taskId> [YYYY-MM-DD]
//   node scripts/state.mjs events [taskId]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file =
  process.env.OPENCHAMBER_GUEST_STORAGE ??
  join(homedir(), ".config", "openchamber", "guest-storage", "clickup-tasks.json");

const NOTES_DIR = (process.env.CLICKUP_NOTES_DIR ?? "").trim()
  || join(homedir(), "Documents", "obsidian", "ClickUp");

const safeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    console.error(`Bad task id: ${JSON.stringify(id)}`);
    process.exit(2);
  }
  return id;
};

const safeTaskName = (name) =>
  String(name ?? "")
    .split("")
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 32;
      if (
        ch === "/" ||
        ch === "\\" ||
        ch === ":" ||
        ch === "*" ||
        ch === "?" ||
        ch === '"' ||
        ch === "<" ||
        ch === ">" ||
        ch === "|" ||
        code < 32 ||
        code === 127
      ) {
        return "-";
      }
      return ch;
    })
    .join("")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 100);

const expectedName = (taskId, name) => {
  const clean = safeTaskName(name);
  return clean ? `${taskId} - ${clean}.md` : `${taskId}.md`;
};

const fileIdOf = (fileName) => {
  if (!fileName.endsWith(".md")) return null;
  const base = fileName.slice(0, -".md".length);
  if (/^[A-Za-z0-9_-]+$/.test(base)) return base;
  const sep = base.indexOf(" - ");
  if (sep > 0) {
    const id = base.slice(0, sep);
    if (/^[A-Za-z0-9_-]+$/.test(id)) return id;
  }
  return null;
};

/** Find a task's note file: exact `<id>.md` wins, else the first `<id> - ….md`. */
const findNoteFile = (taskId) => {
  const id = safeId(taskId);
  if (!existsSync(NOTES_DIR)) return null;
  const names = readdirSync(NOTES_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  const exact = `${id}.md`;
  if (names.includes(exact)) return join(NOTES_DIR, exact);
  const dashed = names.find((entry) => entry.startsWith(`${id} - `));
  return dashed ? join(NOTES_DIR, dashed) : null;
};
const HEADER_SEP = "\n---\n\n";

const splitBody = (content) => {
  const at = content.indexOf(HEADER_SEP);
  return at < 0 ? content : content.slice(at + HEADER_SEP.length);
};

const readNoteBody = (taskId) => {
  const file = findNoteFile(taskId);
  if (!file) return null;
  try {
    return splitBody(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const writeNoteBody = (taskId, header, text) => {
  const id = safeId(taskId);
  mkdirSync(NOTES_DIR, { recursive: true });
  const trimmed = String(text ?? "").trim();
  const file = findNoteFile(id) ?? join(NOTES_DIR, `${id}.md`);
  writeFileSync(file, `${header}${HEADER_SEP}${trimmed}\n`, { mode: 0o600 });
  return trimmed;
};

const plainHeader = (taskId) => `[${taskId}](https://app.clickup.com/t/${taskId})`;

const openInObsidian = (taskId) => {
  const file = findNoteFile(taskId);
  if (!file) throw new Error(`no note file for ${taskId}`);
  const uri = `obsidian://open?path=${encodeURIComponent(file)}`;
  const result = spawnSync("xdg-open", [uri], { stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`xdg-open exited with status ${result.status}`);
  return uri;
};

const read = () => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const write = (data) => {
  data.updated = String(Date.now());
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
};

const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const EVENTS_MAX = 500;
const pushEvent = (data, type, taskId, date) => {
  const events = Array.isArray(data.events) ? data.events : [];
  events.push({ at: new Date().toISOString(), type, taskId, ...(date ? { date } : {}) });
  data.events = events.slice(-EVENTS_MAX);
};

const usage = () => {
  console.error(
    "usage: state.mjs list | notes | note-set <id> <text...> | note-del <id> | note-open <id> | " +
      "done-list [date] | done-add <id> [date] | done-remove <id> [date] | events [taskId]",
  );
  process.exit(2);
};

const [command, ...args] = process.argv.slice(2);
const data = read();

switch (command) {
  case "list": {
    console.log(JSON.stringify(data, null, 2));
    break;
  }
  case "notes": {
    if (!existsSync(NOTES_DIR)) break;
    if (!existsSync(NOTES_DIR)) break;
    const seen = new Set();
    for (const name of readdirSync(NOTES_DIR)
      .filter((entry) => entry.endsWith(".md"))
      .sort()) {
      const taskId = fileIdOf(name);
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      const first = (readNoteBody(taskId) ?? "").split("\n")[0] ?? "";
      console.log(`${taskId}\t${first}`);
    }
    break;
  }
  case "note-set": {
    const [rawId, ...rest] = args;
    const id = safeId(rawId);
    const text = rest.join(" ").trim();
    if (!id || !text) usage();
    writeNoteBody(id, plainHeader(id), text);
    pushEvent(data, "note-set", id);
    write(data);
    console.log(`note set on ${id}`);
    break;
  }
  case "note-del": {
    const id = safeId(args[0]);
    if (!id) usage();
    const file = findNoteFile(id);
    if (file) {
      try {
        unlinkSync(file);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    pushEvent(data, "note-delete", id);
    write(data);
    console.log(`note removed from ${id}`);
    break;
  }
  case "note-open": {
    const id = safeId(args[0]);
    if (!id) usage();
    if (readNoteBody(id) === null) writeNoteBody(id, plainHeader(id), "");
    console.log(openInObsidian(id));
    break;
  }
  case "done-list": {
    const date = args[0] ?? today();
    console.log((data.done?.[date] ?? []).join("\n"));
    break;
  }
  case "done-add":
  case "done-remove": {
    const [id, dateArg] = args;
    if (!id) usage();
    const date = dateArg ?? today();
    const done = data.done && typeof data.done === "object" ? data.done : {};
    const set = new Set(Array.isArray(done[date]) ? done[date] : []);
    if (command === "done-add") set.add(id);
    else set.delete(id);
    done[date] = [...set];
    data.done = done;
    pushEvent(data, command, id, date);
    write(data);
    console.log(`${command === "done-add" ? "checked" : "unchecked"} ${id} on ${date}`);
    break;
  }
  case "events": {
    const [taskId] = args;
    for (const event of Array.isArray(data.events) ? data.events : []) {
      if (taskId && event?.taskId !== taskId) continue;
      console.log(`${event.at}\t${event.type}\t${event.taskId}${event.date ? `\t${event.date}` : ""}`);
    }
    break;
  }
  default:
    usage();
}

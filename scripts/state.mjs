#!/usr/bin/env node
// Read/write the ClickUp Tasks extension's local state (notes + done ticks).
//
// The panel keeps its local state in OpenChamber's guest storage as plain JSON.
// This script edits that same file atomically (temp file + rename, mode 600), so
// an agent or a shell can manipulate the extension without hand-editing JSON.
//
// File: ~/.config/openchamber/guest-storage/clickup-tasks.json
// Shape: { "done": { "YYYY-MM-DD": ["<taskId>", ...] },
//          "note:<taskId>": "text", ... }
//
// After a change, press Refresh in the panel (or reopen it) to see it.
//
// Usage:
//   node scripts/state.mjs list
//   node scripts/state.mjs notes
//   node scripts/state.mjs note-set <taskId> <text...>
//   node scripts/state.mjs note-del <taskId>
//   node scripts/state.mjs done-list [YYYY-MM-DD]
//   node scripts/state.mjs done-add <taskId> [YYYY-MM-DD]
//   node scripts/state.mjs done-remove <taskId> [YYYY-MM-DD]
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file =
  process.env.OPENCHAMBER_GUEST_STORAGE ??
  join(homedir(), ".config", "openchamber", "guest-storage", "clickup-tasks.json");

const read = () => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const write = (data) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
};

const today = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const usage = () => {
  console.error(
    "usage: state.mjs list | notes | note-set <id> <text...> | note-del <id> | " +
      "done-list [date] | done-add <id> [date] | done-remove <id> [date]",
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
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("note:")) {
        console.log(`${key.slice("note:".length)}\t${String(value).replace(/\n/g, " ")}`);
      }
    }
    break;
  }
  case "note-set": {
    const [id, ...rest] = args;
    const text = rest.join(" ").trim();
    if (!id || !text) usage();
    data[`note:${id}`] = text;
    write(data);
    console.log(`note set on ${id}`);
    break;
  }
  case "note-del": {
    const [id] = args;
    if (!id) usage();
    delete data[`note:${id}`];
    write(data);
    console.log(`note removed from ${id}`);
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
    write(data);
    console.log(`${command === "done-add" ? "checked" : "unchecked"} ${id} on ${date}`);
    break;
  }
  default:
    usage();
}

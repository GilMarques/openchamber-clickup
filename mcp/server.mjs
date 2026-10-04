#!/usr/bin/env node
// MCP server for the ClickUp Tasks OpenChamber extension.
//
// Gives an agent typed tools to manipulate the extension's local state and to
// read ClickUp itself. Notes live as markdown files inside the user's Obsidian
// vault (one per task), so the agent and Obsidian share the same files; done
// ticks and the event log stay in the extension's guest storage, which the
// panel polls.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio).
// Configure as a local MCP server, e.g. in opencode.json:
//   "mcp": { "clickup": { "type": "local", "command": ["node", "…/mcp/server.mjs"], "enabled": true } }
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const STORAGE =
  process.env.OPENCHAMBER_GUEST_STORAGE ??
  join(homedir(), ".config", "openchamber", "guest-storage", "clickup-tasks.json");
const AUTH = join(homedir(), ".config", "openchamber", "guest-auth.json");

const DEFAULT_NOTES_DIR = join(homedir(), "Documents", "obsidian", "ClickUp");
const notesDir = () =>
  process.env.CLICKUP_NOTES_DIR ? process.env.CLICKUP_NOTES_DIR.trim() : DEFAULT_NOTES_DIR;

/** Task ids are ClickUp identifiers; anything else is rejected, never used as a path. */
const safeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Bad task id: ${JSON.stringify(id)}`);
  return id;
};

const noteFile = (taskId) => join(notesDir(), `${safeId(taskId)}.md`);

const ensureNotesDir = () => mkdirSync(notesDir(), { recursive: true });

const HEADER_SEP = "\n---\n\n";

/** Split a note file into its template header and the editable body. */
const splitBody = (content) => {
  const at = content.indexOf(HEADER_SEP);
  return at < 0 ? content : content.slice(at + HEADER_SEP.length);
};

const readNoteBody = (taskId) => {
  try {
    return splitBody(readFileSync(noteFile(taskId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const readState = () => {
  try {
    const parsed = JSON.parse(readFileSync(STORAGE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeState = (data) => {
  const tmp = `${STORAGE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, STORAGE);
};

/** Bump the marker the panel polls, so external writes show without a reload. */
const touch = (data) => {
  data.updated = String(Date.now());
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

const token = () => {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN.trim();
  try {
    return JSON.parse(readFileSync(AUTH, "utf8"))?.guests?.["clickup-tasks"]?.accessToken ?? null;
  } catch {
    return null;
  }
};

const api = async (path, query) => {
  const auth = token();
  if (!auth) throw new Error("No ClickUp token. Connect the extension, or set CLICKUP_TOKEN.");
  const url = new URL(`https://api.clickup.com${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.append(key, value);
  const response = await fetch(url, { headers: { Authorization: auth } });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickUp ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const resolveField = (task, name) => {
  const field = (task.custom_fields ?? []).find(
    (entry) => (entry.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  if (!field || field.value === null || field.value === undefined) return null;
  if (field.type === "drop_down") {
    const options = field.type_config?.options ?? [];
    const match =
      options.find((option) => String(option.orderindex) === String(field.value)) ??
      options.find((option) => String(option.id) === String(field.value));
    if (match?.name) return match.name;
  }
  if (Array.isArray(field.value)) {
    const text = field.value
      .map((entry) =>
        typeof entry === "string" ? entry : (entry?.username ?? entry?.name ?? ""),
      )
      .filter(Boolean)
      .join(", ");
    return text || null;
  }
  return String(field.value);
};

const compact = (task) => ({
  id: task.id,
  customId: task.custom_id ?? null,
  name: task.name ?? "",
  status: task.status?.status ?? null,
  priority: task.priority?.priority ?? null,
  sprint: resolveField(task, "Sprints"),
  list: task.list?.name ?? null,
  folder: task.project?.name ?? task.folder?.name ?? null,
  dueDate: task.due_date ? new Date(Number(task.due_date)).toISOString().slice(0, 10) : null,
  parent: task.parent ?? null,
  url: task.url ?? null,
});

const writeNoteBody = (task, text) => {
  ensureNotesDir();
  const trimmed = String(text ?? "").trim();
  const meta = [task.customId ?? task.id, task.sprint, task.status, task.list]
    .filter(Boolean)
    .join(" · ");
  const header =
    `# ${task.name || task.customId || task.id}\n\n` +
    `[${task.customId || task.id}](${task.url ?? `https://app.clickup.com/t/${task.id}`})` +
    `${meta ? ` · ${meta}` : ""}`;
  writeFileSync(noteFile(task.id), `${header}${HEADER_SEP}${trimmed}\n`, { mode: 0o600 });
  return trimmed;
};

/** Best-effort task lookup for note headers; falls back to the bare id. */
const describeTask = async (taskId) => {
  try {
    const isCustom = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(taskId);
    const { teamIds } = await findUserAndTeams();
    const attempts = isCustom
      ? teamIds.map((teamId) => ({ custom_task_ids: "true", team_id: teamId }))
      : [{}];
    for (const query of attempts) {
      try {
        return compact(await api(`/api/v2/task/${encodeURIComponent(taskId)}`, query));
      } catch {
        // Try the next workspace, then give up.
      }
    }
  } catch {
    // Header falls back to the id below.
  }
  return { id: taskId, customId: null, name: "", status: null, sprint: null, list: null, url: null };
};

/** Launch Obsidian on a note file through the OS-registered URI handler. */
const openInObsidian = (taskId) =>
  new Promise((resolve, reject) => {
    const uri = `obsidian://open?path=${encodeURIComponent(noteFile(taskId))}`;
    const child = spawn("xdg-open", [uri], { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve(uri);
  });

const findUserAndTeams = async () => {
  const me = await api("/api/v2/user");
  const teams = await api("/api/v2/team");
  return {
    userId: String(me.user.id),
    username: me.user.username ?? null,
    teamIds: (teams.teams ?? []).map((team) => String(team.id)),
  };
};

const tools = [
  {
    name: "tasks_list",
    description:
      "List ClickUp tasks assigned to the connected user (compact fields). Open tasks only unless includeClosed is true.",
    inputSchema: {
      type: "object",
      properties: {
        includeClosed: { type: "boolean", description: "Include closed/done tasks (default false)" },
        limit: { type: "number", description: "Max tasks to return (default 100)" },
      },
    },
  },
  {
    name: "task_get",
    description: "Get one ClickUp task by id or custom id (e.g. ABC-12) with its compact fields.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id or custom id" } },
      required: ["id"],
    },
  },
  {
    name: "notes_list",
    description:
      "List local notes (one markdown file per task in the Obsidian vault). Returns task id and body text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "note_get",
    description: "Read the local note body for one task (without the file header).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "note_set",
    description:
      "Create or replace the local note body for a task. Written to the Obsidian vault file; never sent to ClickUp.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, text: { type: "string" } },
      required: ["taskId", "text"],
    },
  },
  {
    name: "note_delete",
    description: "Delete the local note file for a task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "note_open",
    description:
      "Open the task's note in Obsidian (creates the vault file first when missing).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "done_list",
    description: "List the task ids ticked as done on a date (default today, local time).",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } } },
  },
  {
    name: "done_add",
    description: "Tick a task as done for a date in the extension (local only).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["taskId"],
    },
  },
  {
    name: "done_remove",
    description: "Untick a task for a date in the extension (local only).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["taskId"],
    },
  },
  {
    name: "events_list",
    description:
      "Timestamped history of local note and done changes (newest last). Optionally filter by taskId or type (note-set, note-delete, done-add, done-remove).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        type: { type: "string" },
        limit: { type: "number", description: "Max events to return (default 50, newest first)" },
      },
    },
  },
];

const callTool = async (name, args = {}) => {
  switch (name) {
    case "tasks_list": {
      const { userId, teamIds } = await findUserAndTeams();
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : 100;
      const includeClosed = Boolean(args.includeClosed);
      const collected = [];
      for (const teamId of teamIds) {
        const body = await api(`/api/v2/team/${encodeURIComponent(teamId)}/task`, {
          "assignees[]": userId,
          subtasks: "true",
          include_closed: includeClosed ? "true" : "false",
          order_by: "updated",
          page: "0",
        });
        collected.push(...(body.tasks ?? []));
        if (collected.length >= limit) break;
      }
      // structuredContent must be an object, so wrap list results.
      return { tasks: collected.slice(0, limit).map(compact) };
    }
    case "task_get": {
      const id = String(args.id ?? "").trim();
      if (!id) throw new Error("id is required");
      const isCustom = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id);
      const { teamIds } = await findUserAndTeams();
      const attempts = isCustom ? teamIds.map((teamId) => ({ custom_task_ids: "true", team_id: teamId })) : [{}];
      let lastError;
      for (const query of attempts) {
        try {
          return compact(await api(`/api/v2/task/${encodeURIComponent(id)}`, query));
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error(`Task ${id} not found`);
    }
    case "notes_list": {
      ensureNotesDir();
      const files = readdirSync(notesDir()).filter((name) => name.endsWith(".md"));
      return {
        notes: files.map((name) => {
          const taskId = basename(name, ".md");
          return { taskId, text: readNoteBody(taskId) ?? "" };
        }),
      };
    }
    case "note_get": {
      const taskId = safeId(args.taskId);
      return { taskId, text: readNoteBody(taskId) };
    }
    case "note_set": {
      const taskId = safeId(args.taskId);
      const raw = String(args.text ?? "").trim();
      if (!raw) throw new Error("text is required");
      const text = writeNoteBody(await describeTask(taskId), raw);
      const data = readState();
      pushEvent(data, "note-set", taskId);
      touch(data);
      writeState(data);
      return { taskId, text, path: noteFile(taskId), saved: true };
    }
    case "note_delete": {
      const taskId = safeId(args.taskId);
      try {
        unlinkSync(noteFile(taskId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const data = readState();
      pushEvent(data, "note-delete", taskId);
      touch(data);
      writeState(data);
      return { taskId, deleted: true };
    }
    case "note_open": {
      const taskId = safeId(args.taskId);
      if (readNoteBody(taskId) === null) writeNoteBody(await describeTask(taskId), "");
      const uri = await openInObsidian(taskId);
      return { taskId, path: noteFile(taskId), uri, opened: true };
    }
    case "done_list": {
      const data = readState();
      const date = args.date ? String(args.date) : today();
      return { date, taskIds: data.done?.[date] ?? [] };
    }
    case "done_add":
    case "done_remove": {
      const taskId = String(args.taskId ?? "").trim();
      if (!taskId) throw new Error("taskId is required");
      const date = args.date ? String(args.date) : today();
      const data = readState();
      const done = data.done && typeof data.done === "object" ? data.done : {};
      const set = new Set(Array.isArray(done[date]) ? done[date] : []);
      if (name === "done_add") set.add(taskId);
      else set.delete(taskId);
      done[date] = [...set];
      data.done = done;
      pushEvent(data, name === "done_add" ? "done-add" : "done-remove", taskId, date);
      touch(data);
      writeState(data);
      return { date, taskId, checked: name === "done_add" };
    }
    case "events_list": {
      const data = readState();
      const all = Array.isArray(data.events) ? data.events : [];
      const limit = Number.isFinite(args.limit) ? Math.max(1, Number(args.limit)) : 50;
      const filtered = all.filter(
        (event) =>
          (!args.taskId || event?.taskId === args.taskId) && (!args.type || event?.type === args.type),
      );
      return { events: filtered.slice(-limit) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (request.id === undefined) return; // notification
  try {
    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "openchamber-clickup", version: "1.0.0" },
        },
      });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    } else if (request.method === "ping") {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      const result = await callTool(name, request.params?.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      },
    });
  }
});

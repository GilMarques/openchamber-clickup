#!/usr/bin/env node
// MCP server for the ClickUp Tasks OpenChamber extension.
//
// Gives an agent typed tools to manipulate the extension's local state (notes,
// done ticks) and to read ClickUp itself. Local state is the same guest-storage
// file the panel uses, so changes show after the panel refreshes (or within its
// live poll).
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio).
// Configure as a local MCP server, e.g. in opencode.json:
//   "mcp": { "clickup": { "type": "local", "command": ["node", "…/mcp/server.mjs"], "enabled": true } }
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const STORAGE =
  process.env.OPENCHAMBER_GUEST_STORAGE ??
  join(homedir(), ".config", "openchamber", "guest-storage", "clickup-tasks.json");
const AUTH = join(homedir(), ".config", "openchamber", "guest-auth.json");

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
    description: "List the extension's local notes (task id -> text). Notes never leave OpenChamber.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "note_get",
    description: "Read the local note for one task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "note_set",
    description:
      "Create or replace the local note for a task. Stored in OpenChamber only; not sent to ClickUp.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, text: { type: "string" } },
      required: ["taskId", "text"],
    },
  },
  {
    name: "note_delete",
    description: "Delete the local note for a task.",
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
      const data = readState();
      return {
        notes: Object.entries(data)
          .filter(([key]) => key.startsWith("note:"))
          .map(([key, value]) => ({ taskId: key.slice("note:".length), text: String(value) })),
      };
    }
    case "note_get": {
      const data = readState();
      return { taskId: String(args.taskId ?? ""), text: data[`note:${args.taskId}`] ?? null };
    }
    case "note_set": {
      const taskId = String(args.taskId ?? "").trim();
      const text = String(args.text ?? "").trim();
      if (!taskId || !text) throw new Error("taskId and text are required");
      const data = readState();
      data[`note:${taskId}`] = text;
      pushEvent(data, "note-set", taskId);
      touch(data);
      writeState(data);
      return { taskId, text, saved: true };
    }
    case "note_delete": {
      const taskId = String(args.taskId ?? "").trim();
      if (!taskId) throw new Error("taskId is required");
      const data = readState();
      delete data[`note:${taskId}`];
      pushEvent(data, "note-delete", taskId);
      touch(data);
      writeState(data);
      return { taskId, deleted: true };
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

---
name: ClickUp Tasks extension
description: Read and manipulate the OpenChamber "ClickUp Tasks" extension locally - add or read per-task notes, tick tasks as done for a day, list assigned ClickUp tasks, and read the connected ClickUp data. Use when the user references a ClickUp task, asks to add a local note, asks what was done on a day, or wants the panel state changed without touching ClickUp.
---

# ClickUp Tasks extension

The OpenChamber extension lives at `/home/gil/clickup-tasks` (panel, page,
`/clickup` command, MCP tool styling). Its **local state** (notes + done ticks)
is plain JSON on the OpenChamber server and can be read or written by an agent.
Nothing here writes to ClickUp unless you explicitly call the ClickUp API.

## Preferred: the `clickup` MCP server

Registered as a local MCP server (`mcp/server.mjs`). Tools:

| Tool | Does |
| --- | --- |
| `tasks_list` | Compact assigned tasks (`includeClosed`, `limit`) |
| `task_get` | One task by id / custom id |
| `notes_list` | All local notes |
| `note_get` / `note_set` / `note_delete` | Local note for one task |
| `done_list` | Task ids ticked on a date (default today) |
| `done_add` / `done_remove` | Tick / untick a task for a date |
| `events_list` | Timestamped history of note/done changes (`taskId`, `type`, `limit`) |

If the tools are not loaded (session started before the server was added),
restart OpenChamber/OpenCode or fall back to the CLI.

## Fallback: the CLI

```bash
node /home/gil/clickup-tasks/scripts/state.mjs notes
node /home/gil/clickup-tasks/scripts/state.mjs note-set <taskId> "text"
node /home/gil/clickup-tasks/scripts/state.mjs note-del <taskId>
node /home/gil/clickup-tasks/scripts/state.mjs done-add <taskId> [YYYY-MM-DD]
node /home/gil/clickup-tasks/scripts/state.mjs done-remove <taskId> [YYYY-MM-DD]
node /home/gil/clickup-tasks/scripts/state.mjs done-list [YYYY-MM-DD]
node /home/gil/clickup-tasks/scripts/state.mjs events [taskId]
```

## Storage contract

```
~/.config/openchamber/guest-storage/clickup-tasks.json
{ "done": { "YYYY-MM-DD": ["<taskId>"] },
  "note:<taskId>": "text",
  "events": [ { "at": "2026-10-04T21:44:03.604Z", "type": "done-add", "taskId": "…", "date": "2026-10-04" } ],
  "updated": "<epoch ms>" }
```

- `note:<taskId>` is one key per task; text is plain (may contain newlines).
- `done` keeps the last 60 days, one entry per date.
- `events` is an append-only timestamped history of every note/done change
  (`done-add`, `done-remove`, `note-set`, `note-delete`), newest last, capped at
  500. It is storage only — the panel does not render it. Use it to answer "when
  did I tick this / save that note?".
- `updated` is the change marker the panel polls every 10s. **Bump it**
  (`String(Date.now())`) whenever you write, or the panel will not re-read.
  `scripts/state.mjs` and the MCP server do this for you.
- Always write atomically (temp file + rename, mode 600) so a concurrent panel
  write cannot interleave. Prefer the CLI/MCP over hand-editing.

The panel also re-reads on a forced refresh (the refresh icon).

## Task ids and ClickUp

- A task's id is the last path segment of its URL, e.g.
  `https://app.clickup.com/t/869dwcrhb` → `869dwcrhb`. Custom ids look like
  `ABC-12`. Storage keys always use the plain task id.
- The connected ClickUp token is in
  `~/.config/openchamber/guest-auth.json` →
  `guests["clickup-tasks"].accessToken` (or `CLICKUP_TOKEN`). Use it only for
  the user's own ClickUp; notes and ticks stay local by design so AI text never
  lands in ClickUp.

## Notes

- Notes are **markdown**, rendered and editable on the **ClickUp Notes** page
  (main area → **Extension pages**) with CodeMirror highlighting; Ctrl/Cmd+S
  saves. Keep agent-written notes markdown so they render.
- The panel groups by frente, orders by sprint, shows a workflow-status dot, a
  priority badge, expandable subtasks, a done checkbox, and a note icon that
  turns solid when a note exists. Clicking the note icon hands the note to the
  **ClickUp Notes** page (the panel has no API to open that page itself, so it
  leaves an `open-note` handoff in storage and the page picks it up); there is
  no inline editor in the rail anymore.
- The Files panel cannot be driven: the guest API has no "open file" call in
  OpenChamber 2.0.2, and `contributes.fileEditors` only exists from 2.0.4. Use
  the ClickUp Notes page.
- Source, docs, and the same CLI/MCP live in the repo
  `github.com/GilMarques/openchamber-clickup`.

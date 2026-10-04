# ClickUp Tasks — an OpenChamber extension

Your assigned ClickUp tasks in a simple table on the OpenChamber rail, so you can
see what is on your plate and drop a task into the chat without opening ClickUp.

It reads your tasks from the **ClickUp Public API v2**, using a personal API
token you paste once. The token is stored on the OpenChamber server and never
reaches the extension page. No OpenChamber capabilities are requested, so the
install prompt has nothing to approve.

> MCP and extensions are different things. This extension uses ClickUp's REST
> API for the reliable, always-on table. The `tools` block in `package.json` also
> restyles `mcp.clickup.*` agent tool calls as tables in chat. See
> [Using it with the ClickUp MCP server](#using-it-with-the-clickup-mcp-server).

## What you get

- A **panel** on the right-hand rail listing your assigned tasks, **grouped by
  frente** (the list under your Frentes folder) with the sprint shown on each
  row. Tasks that have no frente sit under a `<folder> (no frente)` heading.
- A **caret** on each task that has subtasks. Subtasks are **expanded by
  default**; click the caret (▾) to collapse them and (▸) to expand again.
  Deeper levels nest too. Click a row to attach that task to the chat. A task
  without subtasks keeps the caret space empty so titles line up.
- **Open / All** tabs in the header next to a refresh icon. A **Frentes filter
  row** sits under the search field: `All` plus one tab per frente (with task
  counts). Pick a frente to show only its tasks; the tabs update with the
  Open/All and search filters.
- A **local checkbox** on each row to tick off what you did that day. It is
  stored on the OpenChamber server in the extension's own storage (key `done`)
  and **does not change anything in ClickUp**. Checked rows get a struck-through
  title. Ticks are per calendar day in your local time; the last 60 days are
  kept, so a new day starts unticked.
- A **local note** on each task: click the note icon on a row and the note opens
  as a tab in the **ClickUp Notes** page (main area → Extension pages). Notes
  live in the extension's own storage (key `note:<taskId>`) and are **never sent
  to ClickUp**, so pasted AI text stays out of your workspace. A saved note is
  not shown in the list — the row's note icon turns **solid** so you can tell one
  exists. (The rail panel cannot open the Notes page itself — no guest API for
  it — so the icon leaves the note ready in that tab and points you there.)
- The row's sub-label is the **sprint followed by the priority badge** (for
  example `Sprint 07` `urgent`). The **workflow status** is a small dot in the
  status's own ClickUp colour — no text (the status name is the dot's accessible
  label). The due date stays on the right.
- **Open / All** tabs and a **filter** box.
- A rail **badge** with your open-task count (clears when you open the panel).
- Click a task to **attach it to the chat** as a chip, with status, list, due
  date, and URL as context for the agent.
- A `/clickup ABC-12` **slash command** to attach a task by id.
- A **ClickUp Notes** full-screen page from the Extension pages menu in the main
  area: every local note rendered as **markdown**, newest first, with the task
  title, sprint, status, list, and the time the note was last saved. Links open
  in the browser; raw HTML in a note is stripped before it renders.
- A **full-screen panel page** is the same rail panel, opened from the Extension
  pages menu.

## Install

This is a **folder install**, so it runs straight from this directory and you can
edit, rebuild, and reload.

1. Open **Settings → Extensions**.
2. Paste the absolute path of this folder into the field and choose **Add**:

   ```
   /home/gil/clickup-tasks
   ```

3. The extension adds no permissions, so it enables immediately and its icon
   appears on the rail.

For a Git install (which can self-update), commit `package.json`,
`panel/index.html`, and the built `panel/main.js`, then add the repository URL.

## Connect your ClickUp account

1. Open **Settings → Integrations → ClickUp**.
2. Paste a **personal API token** (starts with `pk_`). Get one at
   <https://app.clickup.com/settings/apps> → **API Token** → Generate.
3. Click **Connect**. The card shows the connected ClickUp username.

The `Workspace (team) ID` field is optional. Leave it empty to auto-detect every
workspace your token can see; set it to pin the table to one workspace.

Two more optional fields tune the grouping: **Folder that holds your frentes**
(default `Frentes`) and **Task custom field that holds the sprint** (default
`Sprints`). Change them if you rename that folder or use a different field.

## Using it

- The table loads **all** your assigned tasks. OpenChamber caps each extension
  request at 256 KB and one ClickUp page is far larger, so the panel splits the
  query by `date_updated` ranges and fetches each piece, merging by task id
  instead of parsing one truncated response. Rows are **ordered by sprint**
  (Sprint 01, 02, …; unnumbered sprints and tasks with no sprint come last, then
  by due date and name).
- Rows are **grouped by frente**. A task is treated as a frente task when its
  folder is the one named by the `frente-folder` setting (default `Frentes`);
  then the group is its list (for example `Solibri Rules`) and the sub-label is
  the task's `sprint-field` custom field (default `Sprints`). Everything else
  groups under `<folder> (no frente)`, so sprint-folder or backlog tasks stay
  separate from your frentes. Frente groups come first, then the rest.
- **Open** hides closed/done tasks; **All** includes them.
- **Click a row** to attach that task to the chat composer. Send it to have the
  agent work on it, or use the task's **Open in ClickUp** link on the chip.
- **Click a caret** (▸) to expand a task's subtasks; (▾) collapses them. Subtasks
  nest under their parent; a subtask whose parent isn't assigned to you appears
  as a top-level row so nothing is hidden.
- Type `/clickup ABC-12` in the chat to attach a task by its custom id.

## Using it with the ClickUp MCP server

The extension panel and the MCP server are independent and complementary:

1. Add the agent tools in **Settings → MCP** as a **remote** server with URL
   `https://mcp.clickup.com/mcp` and complete the OAuth sign-in. Your agents can
   then search, create, and update ClickUp tasks in chat.
2. The extension's `tools` block already matches `mcp.clickup.*` and renders
   those tool results as a table — no code. If OpenChamber reports the ClickUp
   tools under a different prefix, edit `contributes.tools[].match` in
   `package.json` accordingly.

ClickUp's MCP server is OAuth-only and rate-limited (50 calls/24h on Free, 300
on Unlimited+ without the Everything AI add-on), which is why the panel uses the
REST API rather than MCP for its reads.

## Agent / script access

The panel's local state is a plain JSON file on the OpenChamber server:

```
~/.config/openchamber/guest-storage/clickup-tasks.json
{ "done": { "YYYY-MM-DD": ["<taskId>"] },
  "note:<taskId>": "text",
  "events": [ { "at": "ISO", "type": "done-add", "taskId": "…", "date": "YYYY-MM-DD" } ],
  "updated": "<epoch ms>" }
```

Every write records a timestamped event — `done-add`, `done-remove`, `note-set`,
`note-delete` — in the `events` array (last 500 kept). Nothing renders it; it is
storage only, so you can tell when a task was ticked or a note saved. Query it
with the MCP `events_list` tool, the CLI, or by reading the file.

### MCP server (`mcp/server.mjs`)

A local MCP server exposes the extension to an agent with typed tools:

| Tool | Does |
| --- | --- |
| `tasks_list` | Compact assigned tasks (`includeClosed`, `limit`) |
| `task_get` | One task by id / custom id |
| `notes_list` / `note_get` | Read local notes |
| `note_set` / `note_delete` | Write/remove a local note |
| `done_list` | Task ids ticked on a date (default today) |
| `done_add` / `done_remove` | Tick / untick a task for a date |
| `events_list` | Timestamped history of note and done changes |

Add it to OpenCode/OpenChamber (this repo already added it to
`~/.config/opencode/opencode.json`):

```json
"mcp": {
  "clickup": {
    "type": "local",
    "command": ["node", "/home/gil/clickup-tasks/mcp/server.mjs"],
    "enabled": true
  }
}
```

Restart OpenChamber/OpenCode after changing the server file so the MCP process
is respawned.

### CLI

`scripts/state.mjs` edits the same file safely (atomic temp-file + rename, keeps
other keys):

```bash
node scripts/state.mjs list
node scripts/state.mjs notes
node scripts/state.mjs note-set <taskId> "some text"
node scripts/state.mjs note-del <taskId>
node scripts/state.mjs done-add <taskId> [YYYY-MM-DD]
node scripts/state.mjs done-remove <taskId> [YYYY-MM-DD]
node scripts/state.mjs events [taskId]
```

### Live updates

The panel polls the `updated` marker every 10 seconds while it is visible, and a
forced refresh (the refresh icon) re-reads storage. Every writer — the panel,
`scripts/state.mjs`, and the MCP server — bumps `updated`, so an agent change
appears in the panel within ~10s without touching ClickUp. Write atomically, or
the panel's own write can interleave.

The ClickUp token the extension connected is in
`~/.config/openchamber/guest-auth.json`; scripts can call the ClickUp API with it
without re-pasting. Prefer local notes/ticks so AI text never lands in ClickUp.

### Skill

`skills/clickup-tasks/SKILL.md` documents this contract for agent sessions; it is
symlinked into `~/.config/opencode/skills/clickup-tasks`.

### Notes are markdown, and editable in the notes tab

Notes are plain-text markdown. The **ClickUp Notes** page (Extension pages menu)
renders them — headings, lists, code, quotes, links, tables — and edits them in
place with CodeMirror: markdown highlighting, line numbers, undo/redo, and
`Ctrl/Cmd+S` to save. Saving writes back to extension storage and appends a
`note-set` event. No extra permission is needed.

The editor bundles CodeMirror (`@codemirror/state|view|commands|language` plus
`@lezer/markdown`; minified ~400 KB, loaded only on this page). It uses the bare
markdown parser rather than `@codemirror/lang-markdown`, which would also pull in
the HTML/CSS/JS grammars for embedded code blocks (~1 MB).

### Why not the Files panel

There is no API for an extension to make OpenChamber open a file, and
`contributes.fileEditors` only exists from OpenChamber 2.0.4 (this app is 2.0.2).
So the markdown tab is ours. It needs no files, no companion extension, and no
grant outside the project. (The MIT companion
[openchamber-files-ext](https://github.com/PylotLight/openchamber-files-ext)
could still be installed for general file browsing; it is a standalone extension,
not a viewer library, so it is not submoduled here.)

## Develop

Requires Node 22+ (this project was built on Node 24) and matches
`@openchamber/sdk@2.0.2` (the SDK version equals the OpenChamber release).

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run check          # validate the manifest with the SDK parser
npm run build          # esbuild panel/main.ts -> panel/main.js (IIFE)
```

`panel/main.js` is committed because OpenChamber does not build extensions at
install time. Bump `version` in `package.json`, rebuild, and reload after a
change. A folder install only needs a reload to pick up a rebuilt `main.js`.

## Limits and notes

- Extensions load in OpenChamber **web and desktop**; VS Code and mobile do not
  load them yet.
- Every extension request is capped at 256 KB, so the panel fetches
  `date_updated` sub-ranges (bisection) and merges by task id instead of parsing
  one huge, truncated response.
- The panel reads the API on open, on connection, on workspace-setting change,
  and when you press **Refresh**; it does not poll in the background.
- No OpenChamber capability is requested: the extension can draw its panel, read
  the current session, and attach chips, but cannot send prompts, read files, or
  start sessions on its own.

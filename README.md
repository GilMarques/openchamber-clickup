# ClickUp Tasks — an OpenChamber extension

Your assigned ClickUp tasks in a simple table on the OpenChamber rail, so you can
see what is on your plate and drop a task into the chat without opening ClickUp.

It reads your tasks from the **ClickUp Public API v2**, using a personal API
token you paste once. The token is stored on the OpenChamber server and never
reaches the extension page. The only OpenChamber capability it requests is the
`filesystem` grant for its Obsidian notes folder, approved once on install.

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
- A **local note** on each task, kept as a markdown file in your Obsidian vault
  (`~/Documents/obsidian/ClickUp/<taskId>.md`). Click the note icon and the note
  opens **directly in Obsidian** — the extension runs a tiny local service that
  launches it (created if missing). The icon turns **solid** once a note exists.
  Notes are **never sent to ClickUp**, so pasted AI text stays out of your
  workspace.
- The row's sub-label is the **sprint followed by the priority badge** (for
  example `Sprint 07` `urgent`). The **workflow status** is a small dot in the
  status's own ClickUp colour — no text (the status name is the dot's accessible
  label). The due date stays on the right.
- **Open / All** tabs and a **filter** box.
- A rail **badge** with your open-task count (clears when you open the panel).
- Click a task to **attach it to the chat** as a chip, with status, list, due
  date, and URL as context for the agent.
- A `/clickup ABC-12` **slash command** to attach a task by id.

## Install

This is a **folder install**, so it runs straight from this directory and you can
edit, rebuild, and reload.

1. Open **Settings → Extensions**.
2. Paste the absolute path of this folder into the field and choose **Add**:

   ```
   /home/gil/clickup-tasks
   ```

3. The extension asks for one permission — read/write files under
   `~/Documents/obsidian/ClickUp/` (its `filesystem` grant) — so it enables
   after you approve it, and its icon appears on the rail.

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

The **Notes folder** field sets where note files live inside your Obsidian vault
(default `~/Documents/obsidian/ClickUp`). It must stay under
`~/Documents/obsidian/` to match the approved grant; the folder is created on
first use.

## Notes live in Obsidian

Each task's note is a plain markdown file, `<taskId>.md`, in the notes folder —
open it in Obsidian, edit it there, and the panel picks it up on its next
refresh. The file starts with a header (task title, link, sprint, status, list)
followed by your text; agent-written notes keep the same shape.

- **Click the note icon** on a row: the file is created from a template when
  missing, then opened **directly in Obsidian** through the extension's local
  service (approve it once in Settings → Extensions — it runs unsandboxed with
  your user rights, like every OpenChamber service, and only launches note files
  inside your home folder). If the service isn't approved yet, the toast carries
  a Copy button with the vault path instead.
- **To open it in Obsidian**, click the note icon (local service launches it),
  ask the agent (`note_open` tool), or run `node scripts/state.mjs note-open
  <taskId>`.

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

Done ticks and the event log live in a plain JSON file on the OpenChamber server:

```
~/.config/openchamber/guest-storage/clickup-tasks.json
{ "done": { "YYYY-MM-DD": ["<taskId>"] },
  "events": [ { "at": "ISO", "type": "done-add", "taskId": "…", "date": "YYYY-MM-DD" } ],
  "updated": "<epoch ms>" }
```

Notes live as files instead: `~/Documents/obsidian/ClickUp/<taskId>.md`
(override with `$CLICKUP_NOTES_DIR` for scripts, or the extension's `notes-dir`
setting for the panel).

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
| `notes_list` / `note_get` | Read note bodies from the vault |
| `note_set` / `note_delete` | Write/remove a vault note file |
| `note_open` | Ensure the note file, then open it in Obsidian |
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

`scripts/state.mjs` works on the same files and storage (notes go to the vault,
everything else stays atomic in JSON):

```bash
node scripts/state.mjs list
node scripts/state.mjs notes
node scripts/state.mjs note-set <taskId> "some text"
node scripts/state.mjs note-del <taskId>
node scripts/state.mjs note-open <taskId>
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

### Notes open directly in Obsidian

There is deliberately no editor in the extension anymore: no CodeMirror, no
markdown renderer, no notes tab. A note is `<taskId>.md` in the notes folder,
with a header (title, link, sprint, status, list) and your markdown below it.
The panel only ensures the file exists and shows whether it does; Obsidian does
the editing. The extension requests exactly one outside-project grant for this:
`filesystem: ["~/Documents/obsidian/ClickUp/**"]`.

Opening works through a **local service** (`service/main.js`, plain Node, no
dependencies): the panel calls it via `host.serviceRequest`, and it runs
`xdg-open obsidian://open?path=…`. The sandboxed panel cannot launch apps
itself — guest `open-url` is `http(s)`-only and its iframe has no
top-navigation — so the service (unsandboxed, approved once, scoped to files
inside your home folder) is the piece that makes one click open Obsidian.

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
- Only two OpenChamber capabilities are requested: `filesystem` for
  `~/Documents/obsidian/ClickUp/**`, so note files live in your Obsidian vault,
  and `service` for the local Obsidian launcher (approved once; it runs
  unsandboxed with your user rights and only opens note files inside your home
  folder). The extension can draw its panel, read the current session, attach
  chips, and read/write those files — but it cannot send prompts on its own.

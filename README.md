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
- A **Frentes filter row** under the Open/All tabs: `All` plus one tab per
  frente (with task counts). Pick a frente to show only its tasks; the tabs
  update with the Open/All and search filters.
- A **local checkbox** on each row to tick off what you did that day. It is
  stored on the OpenChamber server in the extension's own storage (key `done`)
  and **does not change anything in ClickUp**. Checked rows get a struck-through
  title. Ticks are per calendar day in your local time; the last 60 days are
  kept, so a new day starts unticked.
- A **local note** on each task: click the note icon on a row to write one. Notes
  live in the extension's own storage (key `note:<taskId>`) and are **never sent
  to ClickUp**, so pasted AI text stays out of your workspace. A saved note is
  not shown in the list — the row's note icon turns **solid** so you can tell one
  exists; click it to open, edit, or Delete.
- The row's sub-label is the **sprint followed by the priority badge** (for
  example `Sprint 07` `urgent`). The **workflow status** is a small dot in the
  status's own ClickUp colour — no text (the status name is the dot's accessible
  label). The due date stays on the right.
- **Open / All** tabs and a **filter** box.
- A rail **badge** with your open-task count (clears when you open the panel).
- Click a task to **attach it to the chat** as a chip, with status, list, due
  date, and URL as context for the agent.
- A `/clickup ABC-12` **slash command** to attach a task by id.
- A **full-screen page** ("My ClickUp Tasks") from the Extension pages menu.

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

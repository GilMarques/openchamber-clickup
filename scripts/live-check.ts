// Live check for the ClickUp Tasks extension.
//
// Imports the SAME code the panel uses (panel/clickup.ts) and runs it against
// the real ClickUp API, emulating OpenChamber's 256 KB response cap. It proves
// the bisection fetches every assigned task, then prints the frente groups.
//
// Run:  bun scripts/live-check.ts      (reads CLICKUP_TOKEN from .env)
import { readFileSync } from "node:fs";
import {
  buildGroups,
  buildTree,
  fetchAssignedTasks,
  isClosed,
  RESPONSE_MAX,
  type ClickUpRequest,
  type TreeNode,
} from "../panel/clickup.ts";

const readToken = (): string | undefined => {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN.trim();
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split("\n")
      .find((entry) => entry.trim().startsWith("CLICKUP_TOKEN="));
    return line?.slice(line.indexOf("=") + 1).trim();
  } catch {
    return undefined;
  }
};

const token = readToken();
if (!token) {
  console.error("CLICKUP_TOKEN is not set (put it in .env or the environment).");
  process.exit(1);
}

let calls = 0;
const makeRequest =
  (cap: number | null): ClickUpRequest =>
  async (path, query) => {
    calls += 1;
    const url = new URL(`https://api.clickup.com${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.append(key, value);
    const response = await fetch(url, { headers: { Authorization: token } });
    const text = await response.text();
    const body = cap !== null && text.length > cap ? text.slice(0, cap) : text;
    return { status: response.status, body };
  };

const readJson = async <T,>(request: ClickUpRequest, path: string): Promise<T> => {
  const result = await request(path);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${path} answered ${result.status}`);
  }
  return JSON.parse(result.body) as T;
};

const me = await readJson<{ user: { id: number; username?: string } }>(makeRequest(null), "/api/v2/user");
const teams = await readJson<{ teams: Array<{ id: string | number; name?: string }> }>(
  makeRequest(null),
  "/api/v2/team",
);
const userId = String(me.user.id);
const teamIds = (teams.teams ?? []).map((team) => String(team.id));
console.log(`user: ${me.user.username ?? userId} · workspaces: ${teamIds.join(", ")}`);

const capped = makeRequest(RESPONSE_MAX);
calls = 0;
const viaPanel = await fetchAssignedTasks(capped, teamIds, userId, false);
const panelCalls = calls;

calls = 0;
const expected = await fetchAssignedTasks(makeRequest(null), teamIds, userId, false);
const fullCalls = calls;

console.log(`\nvia panel code (256 KB cap): ${viaPanel.length} open tasks in ${panelCalls} calls`);
console.log(`uncapped reference:         ${expected.length} open tasks in ${fullCalls} calls`);
console.log(`open (not closed):          ${viaPanel.filter((task) => !isClosed(task)).length}`);

const missing = expected.filter((task) => !viaPanel.some((task2) => task2.id === task.id));
const ok = viaPanel.length === expected.length && missing.length === 0;
console.log(`\ncomplete: ${ok ? "PASS" : `FAIL (${missing.length} missing)`}`);
if (!ok) for (const task of missing.slice(0, 10)) console.log(`  missing: ${task.custom_id ?? task.id} ${task.name}`);

console.log("\n=== groups (frente folder: Frentes, sprint field: Sprints) ===");
for (const group of buildGroups(viaPanel, "Frentes")) {
  console.log(`  ${group.label} (${group.tasks.length})`);
}

const countNodes = (nodes: TreeNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
const tree = buildTree(viaPanel);
const rows = countNodes(tree);
const nested = viaPanel.length - tree.length;
console.log(`\ntree: ${tree.length} top-level rows, ${nested} nested subtasks, ${rows} total nodes`);

process.exit(ok ? 0 : 2);

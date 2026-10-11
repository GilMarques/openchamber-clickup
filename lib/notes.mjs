// Shared note-file helpers for the ClickUp Tasks extension.
//
// One implementation used three ways: bundled into panel/main.js by esbuild
// (see notes.d.ts so `tsc --noEmit` stays green), imported directly by
// mcp/server.mjs and scripts/state.mjs under plain node. No dependencies,
// no DOM, no host calls — callers supply storage and transport.
//
// Vault layout (mirrors the panel tree):
//   <notesDir>/<Frente>/<id> - <taskname>.md
//   <notesDir>/ClickUp.base
// Every note carries YAML frontmatter so Obsidian Bases can group by frente
// and order by sprint; the link line + `---` + body format is unchanged.

export const HEADER_SEP = "\n---\n\n";
export const BASE_FILENAME = "ClickUp.base";

/** Sprint rank mirroring the panel order: numbered first, unnumbered last.
 * YAML-safe (no Infinity): unnumbered `Sprint…` sorts before anything else. */
export const sprintRank = (label) => {
  const text = String(label ?? "");
  const numbered = /^sprint\s*0*(\d+)/i.exec(text);
  if (numbered) return Number(numbered[1]);
  if (/^sprint\b/i.test(text)) return 999998;
  return 999999;
};

/** Sanitize one path segment (filenames and folder names alike). */
export const safeSegment = (name, max = 100) =>
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
    .slice(0, max);

/** Task ids are ClickUp identifiers; anything else is rejected, never a path. */
export const isSafeId = (value) =>
  /^[A-Za-z0-9_-]+$/.test(String(value ?? "").trim());

/** `<id> - <taskname>.md`, or bare `<id>.md` when the name is empty. */
export const noteFileName = (taskId, taskName) => {
  const clean = safeSegment(taskName);
  return clean ? `${taskId} - ${clean}.md` : `${taskId}.md`;
};

/** Extract a task id from a vault filename (`<id>.md` or `<id> - ….md`). */
export const fileIdOf = (fileName) => {
  if (typeof fileName !== "string" || !fileName.endsWith(".md")) return null;
  const base = fileName.slice(0, -".md".length);
  if (/^[A-Za-z0-9_-]+$/.test(base)) return base;
  const sep = base.indexOf(" - ");
  if (sep > 0) {
    const id = base.slice(0, sep);
    if (/^[A-Za-z0-9_-]+$/.test(id)) return id;
  }
  return null;
};

/** Frente group label, mirroring the panel's buildGroups. */
export const groupLabel = ({ listName, folderName, frenteFolderName }) => {
  const folder = folderName ?? "";
  if (folder.toLowerCase() === String(frenteFolderName ?? "").toLowerCase()) {
    return listName || "Unnamed frente";
  }
  return `${folder || "Other"} (no frente)`;
};

/** Canonical vault-relative path for a task's note. */
export const canonicalRelPath = ({ taskId, taskName, listName, folderName, frenteFolderName }) => {
  const group = safeSegment(groupLabel({ listName, folderName, frenteFolderName }), 80);
  return `${group}/${noteFileName(taskId, taskName)}`;
};

const yamlScalar = (value) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value).replace(/[\r\n]+/g, " "));
};

export const NOTE_KEYS = [
  "taskId",
  "customId",
  "title",
  "frente",
  "sprint",
  "sprintOrder",
  "status",
  "priority",
  "list",
  "url",
  "parent",
  "clickupNote",
];

/** Full frontmatter block (with trailing newline) for a note file. */
export const serializeFrontmatter = (meta) => {
  const lines = ["---"];
  for (const key of NOTE_KEYS) lines.push(`${key}: ${yamlScalar(meta[key])}`);
  lines.push("---");
  return lines.join("\n") + "\n";
};

const parseScalar = (raw) => {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through to the raw string.
    }
  }
  return raw;
};

/** Split leading YAML frontmatter off; tolerant — unknown shapes pass through. */
export const stripFrontmatter = (content) => {
  const text = String(content ?? "");
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return { meta: {}, rest: text };
  let end = -1;
  for (let i = 1; i < lines.length && i <= 60; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      end = i;
      break;
    }
    if (trimmed !== "" && !/^[A-Za-z0-9_-]+:/.test(trimmed)) return { meta: {}, rest: text };
  }
  if (end < 0) return { meta: {}, rest: text };
  const meta = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    meta[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1).trim());
  }
  return { meta, rest: lines.slice(end + 1).join("\n") };
};

/** Note body: frontmatter stripped first, then everything after the header. */
export const splitBody = (content) => {
  const { rest } = stripFrontmatter(content);
  const at = rest.indexOf(HEADER_SEP);
  return at < 0 ? rest : rest.slice(at + HEADER_SEP.length);
};

/** Full note file: frontmatter, link line, separator, body. */
export const serializeNote = (meta, linkLine, body) =>
  `${serializeFrontmatter(meta)}\n${linkLine}${HEADER_SEP}${String(body ?? "").trim()}\n`;

/** Recursively collect vault-relative .md paths (posix separators, sorted).
 * `listDir` maps a directory path to `[{ name, kind }]` and may throw per
 * directory; unreadable subtrees are skipped, never fatal. */
export const walkMarkdown = async (listDir, root) => {
  const out = [];
  const walk = async (dir, rel) => {
    let entries;
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries ?? []) {
      if (!entry || typeof entry.name !== "string") continue;
      if (entry.kind === "directory") {
        await walk(`${dir}/${entry.name}`, rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.kind === "file" && entry.name.endsWith(".md")) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  };
  await walk(root, "");
  return out.sort();
};

/** Best match for a task id among vault-relative paths: exact `<id>.md`
 * anywhere wins, else the first `<id> - ….md` in sort order. */
export const findBestMatch = (relPaths, taskId) => {
  const exact = relPaths.filter((p) => p === `${taskId}.md` || p.endsWith(`/${taskId}.md`));
  if (exact.length > 0) return exact.sort()[0];
  const dashed = relPaths.filter(
    (p) => fileIdOf(p.split("/").pop() ?? "") === taskId,
  );
  return dashed.length > 0 ? dashed.sort()[0] : null;
};

/** Static Bases view: table of ClickUp notes grouped by frente, sprint first. */
export const baseFileContent = () =>
  `filters:
  and:
    - clickupNote == true
views:
  - type: table
    name: By frente
    groupBy:
      property: frente
      direction: ASC
    order:
      - sprintOrder
      - title
      - status
      - priority
      - url
`;

/** Full frontmatter meta for a task's note. Unknown fields stay null so every
 * file keeps the same shape. */
export const buildNoteMeta = ({
  taskId,
  customId = null,
  title = "",
  listName = null,
  folderName = null,
  frenteFolderName = "Frentes",
  sprint = null,
  status = null,
  priority = null,
  url = null,
  parent = null,
}) => ({
  taskId,
  customId: customId ?? null,
  title: title ?? "",
  frente: groupLabel({ listName, folderName, frenteFolderName }),
  sprint: sprint ?? null,
  sprintOrder: sprintRank(sprint),
  status: status ?? null,
  priority: priority ?? null,
  list: listName ?? null,
  url: url ?? null,
  parent: parent ?? null,
  clickupNote: true,
});

/** Index vault-relative paths by task id with the exact-wins rule, so stale
 * renames never shadow the file. */
export const indexNotes = (relPaths) => {
  const map = new Map();
  const sorted = [...relPaths].sort();
  for (const pass of [false, true]) {
    for (const rel of sorted) {
      const base = rel.split("/").pop() ?? "";
      const id = fileIdOf(base);
      if (!id || map.has(id)) continue;
      if (!pass && base !== `${id}.md`) continue;
      map.set(id, rel);
    }
  }
  return map;
};

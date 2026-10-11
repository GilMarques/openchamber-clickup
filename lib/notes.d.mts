// Types for lib/notes.mjs (plain JS shared by panel, MCP server, and CLI).
// tsc resolves this for `import ... from "../lib/notes.mjs"`; esbuild bundles
// the .mjs itself.

export const HEADER_SEP: string;
export const BASE_FILENAME: string;

export interface NoteMeta {
  taskId: string;
  customId: string | null;
  title: string;
  frente: string;
  sprint: string;
  sprintOrder: number;
  status: string | null;
  priority: string | null;
  list: string | null;
  url: string | null;
  parent: string | null;
  clickupNote: boolean;
}

export interface GroupRef {
  listName?: string | null;
  folderName?: string | null;
  frenteFolderName?: string | null;
}

export interface CanonicalRef extends GroupRef {
  taskId: string;
  taskName?: string | null;
}

export interface DirEntry {
  name: string;
  kind: string;
}

export declare const sprintRank: (label: unknown) => number;
export declare const safeSegment: (name: unknown, max?: number) => string;
export declare const isSafeId: (value: unknown) => boolean;
export declare const noteFileName: (taskId: string, taskName: unknown) => string;
export declare const fileIdOf: (fileName: unknown) => string | null;
export declare const groupLabel: (ref: GroupRef) => string;
export declare const canonicalRelPath: (ref: CanonicalRef) => string;
export declare const NOTE_KEYS: string[];
export declare const serializeFrontmatter: (meta: Partial<NoteMeta>) => string;
export declare const stripFrontmatter: (content: unknown) => { meta: Partial<NoteMeta>; rest: string };
export declare const splitBody: (content: unknown) => string;
export declare const serializeNote: (
  meta: Partial<NoteMeta>,
  linkLine: string,
  body: unknown,
) => string;
export declare const walkMarkdown: (
  listDir: (dir: string) => Promise<DirEntry[] | undefined | null>,
  root: string,
) => Promise<string[]>;
export declare const findBestMatch: (relPaths: string[], taskId: string) => string | null;
export declare const buildNoteMeta: (ref: {
  taskId: string;
  customId?: string | null;
  title?: string | null;
  listName?: string | null;
  folderName?: string | null;
  frenteFolderName?: string | null;
  sprint?: string | null;
  status?: string | null;
  priority?: string | null;
  url?: string | null;
  parent?: string | null;
}) => NoteMeta;
export declare const indexNotes: (relPaths: string[]) => Map<string, string>;
export declare const baseFileContent: () => string;

/**
 * A company's gadget storage, for the local storage export (FAC-162).
 *
 * A gadget runs as a Durable Object facet of its workspace's Overseer, and its storage is that
 * facet's. A parent object can't read a facet's storage without running the gadget's code, so this
 * reads what local Miniflare persisted instead: workerd keeps each Overseer's facets in
 * `<id>.facets` (an index of names) and `<id>.<n>.sqlite` (facet n's storage). It reads copies,
 * after the runtime has stopped, and never opens the company's own files for writing.
 *
 * What leaves is decided as the kernel's workspace record export does (#345):
 * - only keys a blueprint's allow-list names, exactly, with a value matching the key's rule;
 * - actor ids as per-export salted hashes, never in clear;
 * - every other key by name only, and a name that looks personal or secret only as a salted hash;
 * - a gadget's SQL tables by name and row count; gatekeeper facets by name, never read.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";

/** What a key's value must be for it to be exported, and how it's written. */
export type GadgetValueRule =
  | "number" | "boolean" | "timestamp" | "uuid" | "issueKey" | "revision"
  /** An identifier of a person or account: written only as a per-export salted hash. */
  | "actorId"
  /** Free text, exported in clear. Allow-list it only for text no person writes into. */
  | "text";

export const GADGET_VALUE_RULES: readonly GadgetValueRule[] =
  ["number", "boolean", "timestamp", "uuid", "issueKey", "revision", "actorId", "text"];

/** Per blueprint, the storage keys that may be exported and the rule each value must meet. */
export type GadgetStateAllowList = readonly { blueprintId: string; keys: Readonly<Record<string, GadgetValueRule>> }[];

/** A workspace's gadgets, as the kernel lists them (`exportWorkspaceRecords().gadgets`). */
export type WorkspaceGadgets = ReadonlyMap<string, readonly { id: number | string; facet: string; blueprintId: string | null }[]>;

export interface GadgetStateExport {
  salt: "per-export";
  workspaces: {
    id: string;
    gadgets: {
      id: number | string;
      blueprintId: string | null;
      entries: { key: string; value: unknown }[];
      withheldKeys: { key: string; reason: string }[];
      sqlTables: { name: string; rows: number; reason: string }[];
    }[];
    otherFacets: { facet: string; reason: string }[];
  }[];
}

export interface FacetIndexEntry { number: number; parent: number; name: string }

const FACET_INDEX_MAGIC = Buffer.from("57efb0c55bcecdc4", "hex");
const MAX_TEXT_LENGTH = 2000;
const MAX_KEY_NAME_LENGTH = 128;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,15}-[0-9]+$/;
const REVISION = /^(0|[1-9][0-9]*)$/;
// Names (keys and tables) that could identify a person or carry a secret are hashed, not shown.
const PERSONAL_OR_SECRET = /[^\s@]+@[^\s@]+\.[^\s@]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s|\btoken\b|password|secret/i;

/** Whether a name holds a control character (U+0000 to U+001F), which no plain name has. */
function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) < 0x20) return true;
  return false;
}

/**
 * Parses workerd's facet index: an 8-byte magic, then one entry per facet in creation order, each
 * a little-endian u16 parent (0 for a top-level facet) and u16 name length, then the name. Facet n
 * (1-based) is stored as `<id>.<n>.sqlite`. Anything else is refused, never guessed at.
 */
export function parseFacetIndex(bytes: Buffer): FacetIndexEntry[] {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(FACET_INDEX_MAGIC)) {
    throw new Error("Not a workerd facet index (unknown header)");
  }
  const entries: FacetIndexEntry[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("Truncated workerd facet index entry");
    const parent = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (length === 0 || offset + length > bytes.length) throw new Error("Malformed workerd facet index name");
    const name = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
    if (parent > entries.length) throw new Error("Malformed workerd facet index parent");
    entries.push({ number: entries.length + 1, parent, name });
  }
  return entries;
}

function salted(salt: string, value: string): string {
  return `sha256:${createHash("sha256").update(`${salt}:${value}`).digest("hex")}`;
}

/** A key or table name as the export may show it: in clear, or hashed when it looks personal. */
function reportedName(name: string, salt: string): { name: string; hashed: boolean } {
  return name.length > MAX_KEY_NAME_LENGTH || PERSONAL_OR_SECRET.test(name) || hasControlCharacter(name)
    ? { name: salted(salt, name), hashed: true } : { name, hashed: false };
}

/** The exported form of a value under its rule, or undefined when it doesn't match. */
function applyRule(rule: GadgetValueRule, value: unknown, salt: string): unknown {
  switch (rule) {
    case "number": return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "timestamp":
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
      return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
    case "uuid": return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
    case "issueKey": return typeof value === "string" && ISSUE_KEY.test(value) ? value : undefined;
    case "revision": return typeof value === "string" && REVISION.test(value) ? value : undefined;
    case "actorId":
      return typeof value === "string" && value.length > 0 && value.length <= 256 ? salted(salt, value) : undefined;
    case "text": return typeof value === "string" && value.length <= MAX_TEXT_LENGTH ? value : undefined;
  }
}

/** Opens a copy of one facet's persisted storage (database, WAL and shared memory) read-only. */
function withFacetCopy<T>(directory: string, base: string, scratchDirectory: string, read: (db: DatabaseSync) => T): T {
  const copy = mkdtempSync(join(scratchDirectory, "facet-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = join(directory, `${base}${suffix}`);
      if (existsSync(source)) copyFileSync(source, join(copy, `${base}${suffix}`));
    }
    const db = new DatabaseSync(join(copy, base), { readOnly: true });
    try { return read(db); } finally { db.close(); }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function readFacet(db: DatabaseSync): { kv: [string, unknown][]; tables: { name: string; rows: number }[] } {
  const tableNames = (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[])
    .map(row => row.name);
  const kv: [string, unknown][] = [];
  if (tableNames.includes("_cf_KV")) {
    for (const row of db.prepare("select key, value from _cf_KV order by key").all() as { key: string; value: Uint8Array }[]) {
      let value: unknown;
      // An undecodable value is reported by its key, like any value that can't be shown.
      try { value = deserialize(Buffer.from(row.value)); } catch { value = undefined; }
      kv.push([row.key, value]);
    }
  }
  const tables = tableNames
    .filter(name => !name.startsWith("_cf_") && !name.startsWith("sqlite_"))
    .toSorted()
    .map(name => ({ name, rows: Number((db.prepare(`select count(*) as rows from "${name.replaceAll('"', '""')}"`).get() as { rows: number }).rows) }));
  return { kv, tables };
}

/**
 * Exports the gadget storage of the workspaces the kernel listed, from one company's persisted
 * Overseer state. `durableObjectDirectory` is that company's `<state>/do/<worker>-OverseerDurableObject`;
 * a workspace with no persisted state there is refused, so another company's id can't be named in.
 */
export async function exportGadgetState({ durableObjectDirectory, workspaces, allowList, salt, scratchDirectory }: {
  durableObjectDirectory: string;
  workspaces: WorkspaceGadgets;
  allowList: GadgetStateAllowList;
  salt: string;
  scratchDirectory: string;
}): Promise<GadgetStateExport> {
  const rulesByBlueprint = new Map(allowList.map(({ blueprintId, keys }) => [blueprintId, keys]));
  const result: GadgetStateExport = { salt: "per-export", workspaces: [] };
  for (const [workspaceId, gadgets] of [...workspaces].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!/^[0-9a-f]{64}$/.test(workspaceId)) throw new Error(`Workspace id ${JSON.stringify(workspaceId)} isn't a Durable Object id`);
    const objectFile = join(durableObjectDirectory, `${workspaceId}.sqlite`);
    if (!existsSync(objectFile)) throw new Error(`Workspace ${workspaceId} has no persisted state in this company's directory`);
    const indexFile = join(durableObjectDirectory, `${workspaceId}.facets`);
    const facets = existsSync(indexFile) ? parseFacetIndex(readFileSync(indexFile)) : [];
    const byName = new Map(facets.filter(facet => facet.parent === 0).map(facet => [facet.name, facet]));
    const gadgetFacets = new Set(gadgets.map(gadget => gadget.facet));

    const exportedGadgets: GadgetStateExport["workspaces"][number]["gadgets"] = [];
    for (const gadget of [...gadgets].toSorted((a, b) => Number(a.id) - Number(b.id))) {
      const facet = byName.get(gadget.facet);
      const rules = gadget.blueprintId === null ? undefined : rulesByBlueprint.get(gadget.blueprintId);
      const entry = { id: gadget.id, blueprintId: gadget.blueprintId,
        entries: [] as { key: string; value: unknown }[], withheldKeys: [] as { key: string; reason: string }[],
        sqlTables: [] as { name: string; rows: number; reason: string }[] };
      if (facet) {
        const base = `${workspaceId}.${facet.number}.sqlite`;
        if (!existsSync(join(durableObjectDirectory, base))) throw new Error(`Facet ${gadget.facet} of ${workspaceId} has no storage file`);
        const { kv, tables } = withFacetCopy(durableObjectDirectory, base, scratchDirectory, readFacet);
        for (const [key, value] of kv) {
          const rule = rules && Object.hasOwn(rules, key) ? rules[key] : undefined;
          const exported = rule === undefined ? undefined : applyRule(rule, value, salt);
          if (rule !== undefined && exported !== undefined) {
            entry.entries.push({ key, value: exported });
            continue;
          }
          const shown = reportedName(key, salt);
          const reason = gadget.blueprintId === null
            ? "the gadget has no blueprint, so nothing of it is on the export allow-list"
            : rule === undefined ? "not on the export allow-list" : `its value doesn't match its allow-list rule (${rule})`;
          entry.withheldKeys.push({ key: shown.name, reason: shown.hashed ? `${reason}; its name looks personal, so it's hashed` : reason });
        }
        for (const table of tables) {
          entry.sqlTables.push({ name: reportedName(table.name, salt).name, rows: table.rows, reason: "a gadget's SQL tables aren't exported" });
        }
      }
      exportedGadgets.push(entry);
    }
    const otherFacets = facets
      .filter(facet => facet.parent !== 0 || !gadgetFacets.has(facet.name))
      .map(facet => ({ facet: reportedName(facet.name, salt).name,
        reason: facet.parent !== 0 ? "a nested facet; not exported"
          : /^gatekeeper[0-9]*$/.test(facet.name) ? "gatekeeper state may hold credentials; not exported"
          : "not a gadget the kernel lists; not exported" }));
    result.workspaces.push({ id: workspaceId, gadgets: exportedGadgets, otherFacets });
  }
  return result;
}

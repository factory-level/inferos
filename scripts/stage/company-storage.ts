/**
 * Local export and purge for one company wrapper. A real stage is always plan-only; local apply
 * removes only that wrapper's disposable Miniflare state directory after an authoritative
 * InferOps offboarding check.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { exportGadgetState, type GadgetStateAllowList, type WorkspaceGadgets } from "./gadget-state.ts";

export interface OffboardingStatus {
  tenantId: string;
  protected: boolean;
  state: "offboarded" | "restored" | "purged" | null;
  offboardedAt: string | null;
  purgeAfter: string | null;
}

export interface KeyValueStore {
  list(options?: { cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export interface ObjectStore {
  list(options?: { cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: unknown; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
}

export interface CompanyStorageBindings {
  kv: ReadonlyMap<string, KeyValueStore>;
  r2: ReadonlyMap<string, ObjectStore>;
  /** Workspace ids map to the Overseer RPC client, never raw DO storage. */
  workspaces: ReadonlyMap<string, { exportWorkspaceRecords(): Promise<unknown> }>;
  /**
   * Durable Object ids of every class but the Overseer: platform and gatekeeper objects, inventory
   * only. Gadget state isn't here: a gadget is a facet of its workspace's Overseer (see gadgetState).
   */
  gadgetDurableObjects: { namespace: string; ids: readonly string[] }[];
  /**
   * Where the company's persisted Overseer state is, and the gadget allow-list. Read after
   * `closeRuntime`, through `exportGadgetState`. Omitted means gadget state isn't exported.
   */
  gadgetState?: {
    durableObjectDirectory: string; allowList: GadgetStateAllowList; scratchDirectory: string;
    /** Runs right before gadget storage is read, after the runtime stops; throws to refuse the read. */
    verifyPaths?: () => void;
  };
  /** Stops the local runtime, so its persisted state is complete before gadget state is read. */
  closeRuntime?: () => Promise<void>;
}

export interface StorageResourceNames {
  kv: readonly string[];
  r2: readonly string[];
  /** Explicitly approved for export. Omitted means none; every other resource is name-only. */
  exportKv?: readonly string[];
  /** Explicitly approved for export. Omitted means none; every other resource is name-only. */
  exportR2?: readonly string[];
}

export type StatusReader = (tenantId: string) => Promise<OffboardingStatus>;

const CREDENTIAL_NAME = /credential|secret|auth|token|session|keyring|private[-_]?key/i;
const SECRET_TEXT = /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

export function credentialResource(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

function asBase64(data: ArrayBuffer): string {
  return Buffer.from(data).toString("base64");
}

async function listKv(store: KeyValueStore): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ cursor, limit: 1000 });
    names.push(...page.keys.map(({ name }) => name));
    cursor = page.list_complete ? undefined : page.cursor;
    if (!page.list_complete && !cursor) throw new Error("KV listing returned an incomplete page without a cursor");
  } while (cursor);
  return names.toSorted();
}

async function listR2(store: ObjectStore): Promise<{ key: string; size: number; uploaded: Date }[]> {
  const objects: { key: string; size: number; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) throw new Error("R2 listing returned a truncated page without a cursor");
  } while (cursor);
  return objects.toSorted((a, b) => a.key.localeCompare(b.key));
}

/** Read all company-prefixed KV/R2 objects, then invoke the allow-listed kernel export per workspace. */
export async function exportCompanyStorage({
  tenantId, prefix, resources, bindings, outputDirectory, salt = randomBytes(16).toString("hex"),
}: {
  tenantId: string;
  prefix: string;
  resources: StorageResourceNames;
  bindings: CompanyStorageBindings;
  outputDirectory: string;
  /** Salts this export's hashes; random by default, so two exports can't be correlated. */
  salt?: string;
}): Promise<Record<string, unknown>> {
  if (!/[/:_-]$/.test(prefix)) throw new Error("Company resource prefix must end with a namespace delimiter (:, /, _, or -)");
  const exportKv = new Set(resources.exportKv ?? []);
  const exportR2 = new Set(resources.exportR2 ?? []);
  for (const name of exportKv) if (!resources.kv.includes(name)) throw new Error(`Export KV ${name} is not a listed local resource`);
  for (const name of exportR2) if (!resources.r2.includes(name)) throw new Error(`Export R2 ${name} is not a listed local resource`);

  const kvExports: Record<string, unknown>[] = [];
  const withheld: { kind: "kv" | "r2"; name: string; reason: string }[] = [];
  for (const name of resources.kv) {
    const store = bindings.kv.get(name);
    if (!store) throw new Error(`Missing local KV binding ${name}`);
    if (!exportKv.has(name) || credentialResource(name)) {
      withheld.push({ kind: "kv", name, reason: credentialResource(name) ? "credential store" : "not on export allow-list" });
      continue;
    }
    for (const key of await listKv(store)) {
      if (!key.startsWith(prefix)) continue;
      const value = await store.get(key, "arrayBuffer");
      if (value) kvExports.push({ namespace: name, key, valueBase64: asBase64(value) });
    }
  }

  const r2Exports: Record<string, unknown>[] = [];
  for (const name of resources.r2) {
    const store = bindings.r2.get(name);
    if (!store) throw new Error(`Missing local R2 binding ${name}`);
    if (!exportR2.has(name) || credentialResource(name)) {
      withheld.push({ kind: "r2", name, reason: credentialResource(name) ? "credential store" : "not on export allow-list" });
      continue;
    }
    for (const object of await listR2(store)) {
      if (!object.key.startsWith(prefix)) continue;
      const body = await store.get(object.key);
      if (body) r2Exports.push({ bucket: name, key: object.key, size: object.size,
        uploaded: object.uploaded.toISOString(), valueBase64: asBase64(await body.arrayBuffer()) });
    }
  }

  const workspaces: Record<string, unknown>[] = [];
  const workspaceGadgets = new Map<string, { id: number | string; facet: string; blueprintId: string | null }[]>();
  for (const [id, workspace] of [...bindings.workspaces].toSorted(([a], [b]) => a.localeCompare(b))) {
    const records = await workspace.exportWorkspaceRecords();
    workspaces.push({ id, records });
    workspaceGadgets.set(id, listedGadgets(id, records));
  }
  const gadgetDurableObjects = bindings.gadgetDurableObjects.map(({ namespace, ids }) => ({
    namespace, ids: ids.toSorted(), note: "not exported: platform and gatekeeper objects, not gadget state",
  }));
  await bindings.closeRuntime?.();
  let gadgetState: Awaited<ReturnType<typeof exportGadgetState>> | null = null;
  if (bindings.gadgetState) {
    const { verifyPaths, ...location } = bindings.gadgetState;
    verifyPaths?.();
    gadgetState = await exportGadgetState({ ...location, workspaces: workspaceGadgets as WorkspaceGadgets, salt });
  }

  const document = {
    format: "inferos-company-storage-export-v1",
    tenantId,
    createdAt: new Date().toISOString(),
    kv: kvExports,
    r2: r2Exports,
    withheld,
    workspaces,
    gadgetDurableObjects,
    gadgetState,
  };
  const withDigest = { ...document, structureDigest: structureDigest(document) };
  const serialized = JSON.stringify(withDigest, null, 2) + "\n";
  if (SECRET_TEXT.test(serialized)) throw new Error("Export contains a credential-shaped value; refusing to write it");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, `company-${tenantId}-export.json`), serialized, { flag: "wx", mode: 0o600 });
  return withDigest;
}

/** The gadgets the kernel listed for a workspace, checked strictly: a malformed list exports nothing. */
function listedGadgets(workspaceId: string, records: unknown): { id: number | string; facet: string; blueprintId: string | null }[] {
  const gadgets = (records as { gadgets?: unknown } | null)?.gadgets;
  if (gadgets === undefined) return [];
  if (!Array.isArray(gadgets) || gadgets.some(gadget => !gadget || typeof gadget !== "object" ||
      !(typeof gadget.id === "number" || typeof gadget.id === "string") ||
      typeof gadget.facet !== "string" || !/^gadget[0-9]*$/.test(gadget.facet) ||
      !(gadget.blueprintId === null || typeof gadget.blueprintId === "string"))) {
    throw new Error(`Workspace ${workspaceId} returned a malformed gadget list`);
  }
  return gadgets;
}

/**
 * A digest of the export's structure and data that's stable across reruns: the creation time is
 * left out, and every salted hash is replaced by its order of first appearance, so the same data
 * gives the same digest though each export salts afresh, and which entries share an actor still
 * counts. Keys are sorted, so field order doesn't matter.
 */
export function structureDigest(document: Record<string, unknown>): string {
  const { createdAt: _createdAt, structureDigest: _digest, ...rest } = document;
  const ordinals = new Map<string, number>();
  const canonical = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/sha256:[0-9a-f]{64}/g, hash => {
        if (!ordinals.has(hash)) ordinals.set(hash, ordinals.size + 1);
        return `sha256:#${ordinals.get(hash)}`;
      });
    }
    if (Array.isArray(value)) return value.map(canonical);
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex")}`;
}

/**
 * The real path of `candidate`, refusing anything not really inside `root`. It's refused when it's
 * relative, holds a `..`, doesn't exist, resolves outside the root (or to the root itself), or passes
 * through a symbolic link anywhere between the root and itself, even one that stays inside: a
 * manifest names one wrapper's own files, so a link is never needed, and refusing them all means a
 * path can't be made to lead into another wrapper's state. The root itself may be a link.
 */
export function containedRealPath(root: string, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  if (candidate.split(/[\\/]/).includes("..")) throw new Error(`${label} must not contain ..`);
  const realRoot = realpathSync(root);
  let real: string;
  try { real = realpathSync(candidate); }
  catch { throw new Error(`${label} doesn't exist: ${candidate}`); }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} must be inside the wrapper root`);
  // With no link on the way, the path as written, taken from the real root, is the real path.
  if (resolve(realRoot, relative(resolve(root), resolve(candidate))) !== real) {
    throw new Error(`${label} passes through a symbolic link; name the real path inside the wrapper`);
  }
  return real;
}

/** A manifest path checked by `containedRealPath`, with the identity of every part of it at that moment. */
export interface PinnedPath {
  readonly label: string;
  /** The wrapper root's real path. */
  readonly root: string;
  /** The checked real path: the only form of it used afterwards. */
  readonly path: string;
  /** `dev:ino` of the root and of each component down to the path, from `lstat`. */
  readonly chain: readonly { readonly path: string; readonly id: string }[];
}

function identity(path: string): string | undefined {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stats && !stats.isSymbolicLink() ? `${stats.dev}:${stats.ino}` : undefined;
}

/** Checks `candidate` as `containedRealPath` does, and records what each part of it is. */
export function pinContainedPath(root: string, candidate: string, label: string): PinnedPath {
  const path = containedRealPath(root, candidate, label);
  const realRoot = realpathSync(root);
  const chain: { path: string; id: string }[] = [];
  let at = realRoot;
  for (const part of ["", ...relative(realRoot, path).split(sep)]) {
    at = part ? join(at, part) : at;
    const id = identity(at);
    if (!id) throw new Error(`${label} changed while it was checked (${at})`);
    chain.push({ path: at, id });
  }
  return { label, root: realRoot, path, chain };
}

/**
 * Re-checks a pinned path right before it's used, and returns it. It's refused, before anything
 * starts, if it no longer resolves to itself inside the root or any part of it is now a different
 * file or a symbolic link. Node can't hold a directory open across a child's own open (no
 * `openat`/`O_NOFOLLOW` pinning), so a writer racing the moments after this check is out of scope.
 */
export function verifyPinnedPath(pin: PinnedPath): string {
  const refuse = (detail: string): never => {
    throw new Error(`${pin.label} changed since it was checked (${detail}); nothing was started`);
  };
  let path: string;
  try { path = containedRealPath(pin.root, pin.path, pin.label); }
  catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
  if (path !== pin.path) refuse(path);
  for (const part of pin.chain) if (identity(part.path) !== part.id) refuse(part.path);
  return pin.path;
}

/** Authoritative gate used by the CLI and its injectable local proof. */
export async function assertPurgeAllowed(tenantId: string, readStatus: StatusReader, now = new Date()): Promise<OffboardingStatus> {
  const status = await readStatus(tenantId);
  if (status.tenantId !== tenantId) throw new Error("Offboarding status tenant does not match the selected company");
  if (status.protected) throw new Error("Purge refused: company is protected");
  if (status.state !== "offboarded") throw new Error("Purge refused: company is not currently offboarded");
  if (!status.purgeAfter || !Number.isFinite(Date.parse(status.purgeAfter))) throw new Error("Purge refused: InferOps returned no valid purgeAfter deadline");
  if (Date.parse(status.purgeAfter) > now.getTime()) throw new Error("Purge refused: company is still inside its restore window");
  return status;
}

/** Strict production reader for InferOps' internal company.offboarding_status capability. */
export function httpStatusReader(baseUrl: string, bearer: string, fetcher: typeof fetch = fetch): StatusReader {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
    throw new Error("Offboarding status URL must be HTTPS or loopback HTTP");
  }
  if (!bearer.trim()) throw new Error("INFEROPS_OFFBOARDING_TOKEN is required for purge authorization");
  return async (tenantId) => {
    const response = await fetcher(new URL(`/internal/companies/${encodeURIComponent(tenantId)}/offboarding-status`, origin), {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`InferOps offboarding status returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("InferOps returned invalid offboarding status");
    const status = value as Record<string, unknown>;
    if (status.tenantId !== tenantId || typeof status.protected !== "boolean" ||
        !(["offboarded", "restored", "purged", null] as unknown[]).includes(status.state) ||
        !(status.offboardedAt === null || typeof status.offboardedAt === "string") ||
        !(status.purgeAfter === null || typeof status.purgeAfter === "string")) {
      throw new Error("InferOps returned a malformed offboarding status");
    }
    return status as unknown as OffboardingStatus;
  };
}

/** Purging deletes one isolated local Miniflare state directory; remote stages are never accepted. */
export async function purgeLocalCompany({
  tenantId, stateDirectory, wrapperRoot, apply, readStatus, now, beforeDelete,
}: {
  tenantId: string;
  stateDirectory: string;
  wrapperRoot: string;
  apply: boolean;
  readStatus: StatusReader;
  now?: Date;
  beforeDelete?: () => Promise<void>;
}): Promise<{ tenantId: string; stateDirectory: string; applied: boolean; status?: OffboardingStatus }> {
  const root = realpathSync(wrapperRoot);
  const state = resolve(stateDirectory);
  if (!isAbsolute(stateDirectory)) throw new Error("Local state directory must be an absolute path");
  let checkedState = state;
  if (apply) {
    checkedState = realpathSync(state);
    const realRel = relative(root, checkedState);
    if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
      throw new Error("Refusing purge: real path must stay inside this wrapper's .wrangler/state tree");
    }
  }
  const rel = relative(root, checkedState);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.split(/[\\/]/).includes(".wrangler") || !rel.split(/[\\/]/).includes("state")) {
    throw new Error("Refusing purge: state directory must be inside this wrapper's .wrangler/state tree");
  }
  if (!apply) return { tenantId, stateDirectory: state, applied: false };
  const status = await assertPurgeAllowed(tenantId, readStatus, now);
  await beforeDelete?.();
  rmSync(checkedState, { recursive: true, force: false });
  return { tenantId, stateDirectory: checkedState, applied: true, status };
}

/**
 * Local export and purge for one company wrapper. A real stage is always plan-only; local apply
 * removes only that wrapper's disposable Miniflare state directory after an authoritative
 * InferOps offboarding check.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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
  /** Other DO ids are inventory only; arbitrary gadget state is intentionally omitted. */
  gadgetDurableObjects: { namespace: string; ids: readonly string[] }[];
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
  return names.sort();
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
  return objects.sort((a, b) => a.key.localeCompare(b.key));
}

/** Read all company-prefixed KV/R2 objects, then invoke the allow-listed kernel export per workspace. */
export async function exportCompanyStorage({
  tenantId, prefix, resources, bindings, outputDirectory,
}: {
  tenantId: string;
  prefix: string;
  resources: StorageResourceNames;
  bindings: CompanyStorageBindings;
  outputDirectory: string;
}): Promise<Record<string, unknown>> {
  if (!/[\/:_-]$/.test(prefix)) throw new Error("Company resource prefix must end with a namespace delimiter (:, /, _, or -)");
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
  for (const [id, workspace] of [...bindings.workspaces].sort(([a], [b]) => a.localeCompare(b))) {
    workspaces.push({ id, records: await workspace.exportWorkspaceRecords() });
  }
  const gadgetDurableObjects = bindings.gadgetDurableObjects.map(({ namespace, ids }) => ({
    namespace, ids: [...ids].sort(), note: "not exported: arbitrary gadget state",
  }));

  const document = {
    format: "inferos-company-storage-export-v1",
    tenantId,
    createdAt: new Date().toISOString(),
    kv: kvExports,
    r2: r2Exports,
    withheld,
    workspaces,
    gadgetDurableObjects,
  };
  const serialized = JSON.stringify(document, null, 2) + "\n";
  if (SECRET_TEXT.test(serialized)) throw new Error("Export contains a credential-shaped value; refusing to write it");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, `company-${tenantId}-export.json`), serialized, { flag: "wx", mode: 0o600 });
  return document;
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

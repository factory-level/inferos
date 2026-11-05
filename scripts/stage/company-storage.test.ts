import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Miniflare } from "miniflare";
import {
  assertPurgeAllowed, exportCompanyStorage, purgeLocalCompany, type CompanyStorageBindings,
  type KeyValueStore, type ObjectStore, type OffboardingStatus, type StorageResourceNames,
} from "./company-storage.ts";

const scratch = mkdtempSync(join(tmpdir(), "inferos-fac162-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function status(tenantId: string, changes: Partial<OffboardingStatus> = {}): OffboardingStatus {
  return { tenantId, protected: false, state: "offboarded", offboardedAt: "2026-01-01T00:00:00.000Z",
    purgeAfter: "2026-02-01T00:00:00.000Z", ...changes };
}

async function snapshot(mf: Miniflare, binding: string): Promise<string> {
  const kv = await mf.getKVNamespace(binding);
  const keys = await kv.list();
  const values: [string, string | null][] = [];
  for (const { name } of keys.keys) {
    const value = await kv.get(name, "arrayBuffer");
    values.push([name, value ? Buffer.from(value).toString("base64") : null]);
  }
  return JSON.stringify(values.toSorted(([a], [b]) => a.localeCompare(b)));
}

async function r2Snapshot(mf: Miniflare): Promise<string> {
  const bucket = await mf.getR2Bucket("OBJECTS");
  const objects = await bucket.list();
  const values = await Promise.all(objects.objects.map(async object => {
    const stored = await bucket.get(object.key);
    return [object.key, stored ? Buffer.from(await stored.arrayBuffer()).toString("base64") : null] as const;
  }));
  return JSON.stringify(values.toSorted(([a], [b]) => a.localeCompare(b)));
}

test("Miniflare export is allow-listed and delimiter-bounded; purge is gated and isolates company B", async () => {
  const dirA = join(scratch, "a", ".wrangler", "state");
  const dirB = join(scratch, "b", ".wrangler", "state");
  const config = (name: string, persist: string) => new Miniflare({
    workers: [{ config: { name, compatibilityDate: "2026-09-04", env: {
        DATA: { type: "kv", id: `${name}-data` }, ARCHIVE: { type: "kv", id: `${name}-archive` },
        OBJECTS: { type: "r2", name: `${name}-objects` },
      }, manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: "export default { fetch(){ return new Response('ok') } }" } } } } }],
    resourcePersistencePath: persist,
  });
  const a = config("company-a", dirA);
  const b = config("company-b", dirB);
  let aDisposed = false;
  try {
    const aData = await a.getKVNamespace("DATA");
    const aArchive = await a.getKVNamespace("ARCHIVE");
    const aObjects = await a.getR2Bucket("OBJECTS");
    await aData.put("inferos-acme-record", "safe value");
    await aData.put("inferos-acme2-record", "neighbor company");
    await aArchive.put("inferos-acme-credential", "opaque credential value");
    await aObjects.put("inferos-acme-blob", "blob content");
    await aObjects.put("inferos-acme2-blob", "neighbor company object");
    const bData = await b.getKVNamespace("DATA");
    const bArchive = await b.getKVNamespace("ARCHIVE");
    const bObjects = await b.getR2Bucket("OBJECTS");
    await bData.put("inferos-acme2-record", "other company");
    await bArchive.put("inferos-acme2-credential", "other opaque credential");
    await bObjects.put("inferos-acme2-blob", "other blob");
    const beforeB = JSON.stringify([await snapshot(b, "DATA"), await snapshot(b, "ARCHIVE"), await r2Snapshot(b)]);

    const resources: StorageResourceNames = { kv: ["DATA", "ARCHIVE"], r2: ["OBJECTS"],
      exportKv: ["DATA"], exportR2: ["OBJECTS"] };
    const bindings: CompanyStorageBindings = {
      kv: new Map<string, KeyValueStore>([["DATA", aData as unknown as KeyValueStore], ["ARCHIVE", aArchive as unknown as KeyValueStore]]),
      r2: new Map<string, ObjectStore>([["OBJECTS", aObjects as unknown as ObjectStore]]),
      workspaces: new Map([["workspace-a", { exportWorkspaceRecords: async () => ({ canvases: [{ id: "canvas-a" }] }) }]]),
      gadgetDurableObjects: [{ namespace: "GadgetState", ids: ["opaque-do-id"] }],
    };
    const output = join(scratch, "export");
    const document = await exportCompanyStorage({ tenantId: "tenant-a", prefix: "inferos-acme-", resources, bindings, outputDirectory: output });
    const text = readFileSync(join(output, "company-tenant-a-export.json"), "utf8");
    assert.equal((document.kv as unknown[]).length, 1);
    assert.equal((document.r2 as unknown[]).length, 1);
    assert.match(text, /not on export allow-list/);
    assert.match(text, /ARCHIVE/);
    assert.match(text, /not exported: arbitrary gadget state/);
    assert.doesNotMatch(text, /opaque credential value/);
    assert.doesNotMatch(text, /acme2/);
    assert.match(text, /workspace-a/);

    const noAllowList = await exportCompanyStorage({ tenantId: "tenant-a-no-allow-list", prefix: "inferos-acme-",
      resources: { kv: ["DATA", "ARCHIVE"], r2: ["OBJECTS"] }, bindings,
      outputDirectory: join(scratch, "no-allow-list") });
    assert.deepEqual(noAllowList.kv, []);
    assert.deepEqual(noAllowList.r2, []);
    assert.deepEqual(noAllowList.withheld, [
      { kind: "kv", name: "DATA", reason: "not on export allow-list" },
      { kind: "kv", name: "ARCHIVE", reason: "not on export allow-list" },
      { kind: "r2", name: "OBJECTS", reason: "not on export allow-list" },
    ]);
    await assert.rejects(exportCompanyStorage({ tenantId: "tenant-invalid-prefix", prefix: "inferos-acme",
      resources, bindings, outputDirectory: join(scratch, "invalid-prefix") }), /must end with a namespace delimiter/);

    const now = new Date("2026-01-20T00:00:00.000Z");
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id), now), /inside its restore window/);
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id, { state: null }), new Date("2026-03-01")), /not currently offboarded/);
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id, { protected: true }), new Date("2026-03-01")), /protected/);

    const rootA = join(scratch, "a");
    await a.dispose();
    aDisposed = true;
    await assert.rejects(purgeLocalCompany({ tenantId: "tenant-a", stateDirectory: dirA, wrapperRoot: rootA,
      apply: true, readStatus: async id => status(id), now }), /inside its restore window/);
    const purged = await purgeLocalCompany({ tenantId: "tenant-a", stateDirectory: dirA, wrapperRoot: rootA,
      apply: true, readStatus: async id => status(id), now: new Date("2026-03-01T00:00:00.000Z") });
    assert.equal(purged.applied, true);
    assert.equal(existsSync(dirA), false);
    const afterB = JSON.stringify([await snapshot(b, "DATA"), await snapshot(b, "ARCHIVE"), await r2Snapshot(b)]);
    assert.equal(afterB, beforeB, "company B's local state is byte-for-byte unchanged");
  } finally {
    if (!aDisposed) await a.dispose();
    await b.dispose();
  }
});

test("purge refuses a .wrangler/state symlink that resolves outside its wrapper", async () => {
  const wrapper = join(scratch, "symlink-wrapper");
  const outside = join(scratch, "outside", ".wrangler", "state");
  const link = join(wrapper, ".wrangler", "state");
  mkdirSync(join(wrapper, ".wrangler"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, link, "dir");
  await assert.rejects(purgeLocalCompany({ tenantId: "tenant-a", stateDirectory: link, wrapperRoot: wrapper,
    apply: true, readStatus: async id => status(id), now: new Date("2026-03-01T00:00:00.000Z") }), /real path must stay inside this wrapper/);
  assert.equal(existsSync(outside), true);
});

test("offboarding status must belong to the selected company", async () => {
  await assert.rejects(assertPurgeAllowed("tenant-a", async () => status("tenant-b"), new Date("2026-03-01")), /does not match/);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  return JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)));
}

async function r2Snapshot(mf: Miniflare): Promise<string> {
  const bucket = await mf.getR2Bucket("OBJECTS");
  const objects = await bucket.list();
  const values = await Promise.all(objects.objects.map(async object => {
    const stored = await bucket.get(object.key);
    return [object.key, stored ? Buffer.from(await stored.arrayBuffer()).toString("base64") : null] as const;
  }));
  return JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)));
}

test("Miniflare export withholds credential stores; purge gate refuses early and isolates company B", async () => {
  const dirA = join(scratch, "a", ".wrangler", "state");
  const dirB = join(scratch, "b", ".wrangler", "state");
  const config = (name: string, persist: string) => new Miniflare({
    workers: [{ config: { name, compatibilityDate: "2026-09-04", env: {
        DATA: { type: "kv", id: `${name}-data` }, CREDENTIALS: { type: "kv", id: `${name}-credentials` },
        OBJECTS: { type: "r2", name: `${name}-objects` },
      }, manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: "export default { fetch(){ return new Response('ok') } }" } } } } }],
    resourcePersistencePath: persist,
  });
  const a = config("company-a", dirA);
  const b = config("company-b", dirB);
  try {
    const aData = await a.getKVNamespace("DATA");
    const aCredentials = await a.getKVNamespace("CREDENTIALS");
    const aObjects = await a.getR2Bucket("OBJECTS");
    await aData.put("company-a:record", "safe value");
    await aCredentials.put("company-a:token", "Bearer abcdefghijklmnopqrstuvwxyz");
    await aObjects.put("company-a:blob", "blob content");
    const bData = await b.getKVNamespace("DATA");
    const bCredentials = await b.getKVNamespace("CREDENTIALS");
    const bObjects = await b.getR2Bucket("OBJECTS");
    await bData.put("company-b:record", "other company");
    await bCredentials.put("company-b:token", "Bearer zyxwvutsrqponmlkjihgfedcba");
    await bObjects.put("company-b:blob", "other blob");
    const beforeB = JSON.stringify([await snapshot(b, "DATA"), await snapshot(b, "CREDENTIALS"), await r2Snapshot(b)]);

    const resources: StorageResourceNames = { kv: ["DATA", "CREDENTIALS"], r2: ["OBJECTS"] };
    const bindings: CompanyStorageBindings = {
      kv: new Map<string, KeyValueStore>([["DATA", aData as unknown as KeyValueStore], ["CREDENTIALS", aCredentials as unknown as KeyValueStore]]),
      r2: new Map<string, ObjectStore>([["OBJECTS", aObjects as unknown as ObjectStore]]),
      workspaces: new Map([["workspace-a", { exportWorkspaceRecords: async () => ({ canvases: [{ id: "canvas-a" }] }) }]]),
      gadgetDurableObjects: [{ namespace: "GadgetState", ids: ["opaque-do-id"] }],
    };
    const output = join(scratch, "export");
    const document = await exportCompanyStorage({ tenantId: "tenant-a", prefix: "company-a:", resources, bindings, outputDirectory: output });
    const text = readFileSync(join(output, "company-tenant-a-export.json"), "utf8");
    assert.equal((document.kv as unknown[]).length, 1);
    assert.equal((document.r2 as unknown[]).length, 1);
    assert.match(text, /credential store/);
    assert.match(text, /not exported: arbitrary gadget state/);
    assert.doesNotMatch(text, /Bearer abcdefghijklmnopqrstuvwxyz/);
    assert.match(text, /workspace-a/);

    const now = new Date("2026-01-20T00:00:00.000Z");
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id), now), /inside its restore window/);
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id, { state: null }), new Date("2026-03-01")), /not currently offboarded/);
    await assert.rejects(assertPurgeAllowed("tenant-a", async id => status(id, { protected: true }), new Date("2026-03-01")), /protected/);

    const rootA = join(scratch, "a");
    await a.dispose();
    await assert.rejects(purgeLocalCompany({ tenantId: "tenant-a", stateDirectory: dirA, wrapperRoot: rootA,
      apply: true, readStatus: async id => status(id), now }), /inside its restore window/);
    const purged = await purgeLocalCompany({ tenantId: "tenant-a", stateDirectory: dirA, wrapperRoot: rootA,
      apply: true, readStatus: async id => status(id), now: new Date("2026-03-01T00:00:00.000Z") });
    assert.equal(purged.applied, true);
    assert.equal(existsSync(dirA), false);
    const afterB = JSON.stringify([await snapshot(b, "DATA"), await snapshot(b, "CREDENTIALS"), await r2Snapshot(b)]);
    assert.equal(afterB, beforeB, "company B's local state is byte-for-byte unchanged");
  } finally {
    await b.dispose();
  }
});

test("offboarding status must belong to the selected company", async () => {
  await assert.rejects(assertPurgeAllowed("tenant-a", async () => status("tenant-b"), new Date("2026-03-01")), /does not match/);
});

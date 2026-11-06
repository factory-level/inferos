import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Miniflare } from "miniflare";
import {
  assertPurgeAllowed, containedRealPath, exportCompanyStorage, pinContainedPath, purgeLocalCompany, verifyPinnedPath,
  type CompanyStorageBindings,
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
    assert.match(text, /not exported: platform and gatekeeper objects, not gadget state/);
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

test("a manifest path must really be inside its wrapper: no symlink on the way, no .., no escape", () => {
  const wrapper = join(scratch, "contained", "wrapper-a");
  const sibling = join(scratch, "contained", "wrapper-b");
  const outside = join(scratch, "contained", "outside");
  for (const dir of [join(wrapper, ".wrangler", "state"), join(sibling, ".wrangler", "state"), outside, join(wrapper, "inner")]) {
    mkdirSync(dir, { recursive: true });
  }
  // A normal path passes, and comes back resolved.
  assert.equal(containedRealPath(wrapper, join(wrapper, ".wrangler", "state"), "stateDirectory"),
    realpathSync(join(wrapper, ".wrangler", "state")));
  // A symlink to a sibling wrapper's state is refused.
  const toSibling = join(wrapper, "state-link");
  symlinkSync(join(sibling, ".wrangler", "state"), toSibling, "dir");
  assert.throws(() => containedRealPath(wrapper, toSibling, "stateDirectory"), /stateDirectory must be inside the wrapper root/);
  // A symlink inside the root that resolves outside it is refused, even reached through a real directory.
  symlinkSync(outside, join(wrapper, "inner", "escape"), "dir");
  assert.throws(() => containedRealPath(wrapper, join(wrapper, "inner", "escape"), "stateDirectory"), /must be inside the wrapper root/);
  // A symlink that stays inside the root is refused too: no link anywhere between root and target.
  symlinkSync(join(wrapper, ".wrangler"), join(wrapper, "inner", "loop"), "dir");
  assert.throws(() => containedRealPath(wrapper, join(wrapper, "inner", "loop", "state"), "stateDirectory"), /passes through a symbolic link/);
  // .. is refused before anything is resolved, and so are relative paths and missing ones.
  assert.throws(() => containedRealPath(wrapper, join(wrapper, "inner") + "/../.wrangler/state", "stateDirectory"), /must not contain \.\./);
  assert.throws(() => containedRealPath(wrapper, ".wrangler/state", "stateDirectory"), /absolute path/);
  assert.throws(() => containedRealPath(wrapper, join(wrapper, "missing"), "stateDirectory"), /doesn't exist/);
  // The root itself isn't a path inside it.
  assert.throws(() => containedRealPath(wrapper, wrapper, "stateDirectory"), /must be inside the wrapper root/);
});

test("a pinned manifest path is refused if any part of it changes between the check and the use", () => {
  const base = join(scratch, "pinned");
  const fresh = (name: string) => {
    const wrapper = join(base, name);
    mkdirSync(join(wrapper, ".wrangler", "state"), { recursive: true });
    return wrapper;
  };
  const sibling = fresh("sibling");

  // Unchanged: the re-check passes and gives the canonical path, never the manifest's string.
  const steady = fresh("steady");
  const pin = pinContainedPath(steady, join(steady, ".wrangler", "state"), "stateDirectory");
  assert.equal(pin.path, realpathSync(join(steady, ".wrangler", "state")));
  assert.equal(verifyPinnedPath(pin), pin.path);

  // A checked component swapped for a symlink to a sibling wrapper's state.
  const linked = fresh("linked");
  const linkedPin = pinContainedPath(linked, join(linked, ".wrangler", "state"), "stateDirectory");
  renameSync(join(linked, ".wrangler"), join(linked, ".wrangler-checked"));
  mkdirSync(join(linked, ".wrangler"));
  symlinkSync(join(sibling, ".wrangler", "state"), join(linked, ".wrangler", "state"), "dir");
  assert.throws(() => verifyPinnedPath(linkedPin), /stateDirectory changed since it was checked.*nothing was started/s);

  // The final directory swapped for a symlink.
  const leaf = fresh("leaf");
  const leafPin = pinContainedPath(leaf, join(leaf, ".wrangler", "state"), "stateDirectory");
  renameSync(join(leaf, ".wrangler", "state"), join(leaf, ".wrangler", "state-checked"));
  symlinkSync(join(sibling, ".wrangler", "state"), join(leaf, ".wrangler", "state"), "dir");
  assert.throws(() => verifyPinnedPath(leafPin), /stateDirectory changed since it was checked/);

  // A component replaced by a different real directory: no link, so only its identity shows it.
  const moved = fresh("moved");
  const movedPin = pinContainedPath(moved, join(moved, ".wrangler", "state"), "stateDirectory");
  renameSync(join(moved, ".wrangler"), join(moved, ".wrangler-checked"));
  mkdirSync(join(moved, ".wrangler", "state"), { recursive: true });
  assert.throws(() => verifyPinnedPath(movedPin), new RegExp(`stateDirectory changed since it was checked \\(${join(realpathSync(moved), ".wrangler").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));

  // A file replaced by another file.
  const config = fresh("config");
  writeFileSync(join(config, "wrangler.jsonc"), "{}");
  const configPin = pinContainedPath(config, join(config, "wrangler.jsonc"), "workerConfig");
  writeFileSync(join(config, "wrangler.next"), "{}");
  renameSync(join(config, "wrangler.next"), join(config, "wrangler.jsonc"));
  assert.throws(() => verifyPinnedPath(configPin), /workerConfig changed since it was checked/);

  // The wrapper root itself replaced.
  const root = fresh("root");
  const rootPin = pinContainedPath(root, join(root, ".wrangler", "state"), "stateDirectory");
  renameSync(root, `${root}-checked`);
  mkdirSync(join(root, ".wrangler", "state"), { recursive: true });
  assert.throws(() => verifyPinnedPath(rootPin), /stateDirectory changed since it was checked/);

  // A removed path is refused, not resolved afresh.
  const gone = fresh("gone");
  const gonePin = pinContainedPath(gone, join(gone, ".wrangler", "state"), "stateDirectory");
  rmSync(join(gone, ".wrangler"), { recursive: true });
  assert.throws(() => verifyPinnedPath(gonePin), /stateDirectory changed since it was checked/);
});

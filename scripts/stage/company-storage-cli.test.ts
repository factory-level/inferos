// FAC-162: `stage:company-storage export-local` end to end, on throwaway local wrappers with
// fictional data: the real Wrangler dry-run bundle, the real Miniflare, an Overseer declared unbound
// (as the InferOS backend declares it, reached through ctx.exports) whose gadget facets a real
// Miniflare seeded, and a wrapper whose start hangs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const cli = fileURLToPath(new URL("./company-storage-cli.ts", import.meta.url));
// Inside the checkout, so `pnpm exec wrangler` resolves; .wrangler is gitignored.
const scratch = mkdtempSync(join(resolve(fileURLToPath(new URL("../..", import.meta.url))), ".wrangler", "fac162-cli-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TENANT = "6f1c2b3a-0000-4000-8000-00000000a001";
const WORKER = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  async write(entries) { for (const [k, v] of entries) await this.ctx.storage.put(k, v); return true; }
}
export class OverseerDurableObject extends DurableObject {
  async seed(facets) {
    for (const [name, entries] of facets) await this.ctx.facets.get(name, () => ({ class: this.ctx.exports.Facet })).write(entries);
    return true;
  }
  async exportWorkspaceRecords() {
    return { canvases: [], actionLog: [], exportedAt: new Date(0),
      gadgets: [{ id: 3, facet: "gadget3", blueprintId: "vote-tracker" }] };
  }
}
export default { async fetch(request, env, ctx) {
  const ns = ctx.exports.OverseerDurableObject;
  await ns.get(ns.idFromName("workspace-seeded")).seed(await request.json());
  return new Response("seeded");
} };`;

function wrapper(name: string, build?: string): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, ".wrangler", "state"), { recursive: true });
  writeFileSync(join(dir, "index.js"), WORKER);
  // No Durable Object bindings: the classes are declared by migration only, like the backend's.
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "company-backend", main: "index.js", compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    migrations: [{ tag: "v1", new_sqlite_classes: ["OverseerDurableObject"] }],
    ...(build ? { build: { command: build } } : {}),
  }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    tenantId: TENANT, resourcePrefix: "inferos-seeded-", inferopsBaseUrl: "http://localhost:18080",
    wrapperRoot: dir, stateDirectory: join(dir, ".wrangler", "state"), workerConfig: join(dir, "wrangler.jsonc"),
    outputDirectory: join(dir, "export"),
    resources: { kv: [], r2: [], exportGadgetState: [{ blueprintId: "vote-tracker", keys: { votes: "number", ownerId: "actorId" } }] },
  }));
  return dir;
}

function exportLocal(dir: string, outputName: string, timeoutMs = 120_000) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.outputDirectory = join(dir, outputName);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const started = Date.now();
  const run = spawnSync(process.execPath, [cli, "export-local", "--manifest", join(dir, "manifest.json"),
    "--timeout-ms", String(timeoutMs)], { encoding: "utf8", timeout: timeoutMs + 60_000 });
  return { ...run, elapsed: Date.now() - started, outputDirectory: manifest.outputDirectory as string };
}

test("exports a seeded company through the real bundle and runtime, and a rerun has the same digest", async () => {
  const dir = wrapper("seeded");
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "company-backend", modules: true, script: WORKER, compatibilityDate: "2026-09-04",
    compatibilityFlags: ["nodejs_compat"],
    additionalUnboundDurableObjects: [{ className: "OverseerDurableObject", useSQLite: true }],
    resourcePersistencePath: join(dir, ".wrangler", "state"),
  }));
  try {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify([
      ["gadget3", [["votes", 7], ["ownerId", "person-a@example.test"], ["note", "Meet Dana at the cafe"]]],
      ["gatekeeper1", [["token", "fictional-gatekeeper-credential"]]],
    ]) });
    assert.equal(await response.text(), "seeded");
  } finally {
    await mf.dispose();
  }

  const documents = ["export-1", "export-2"].map(name => {
    const run = exportLocal(dir, name);
    assert.equal(run.status, 0, run.stderr);
    const [file] = readdirSync(run.outputDirectory);
    return JSON.parse(readFileSync(join(run.outputDirectory, file), "utf8"));
  });
  const [first, second] = documents;
  assert.equal(first.workspaces.length, 1, "the unbound Overseer's workspace is found");
  const workspace = first.gadgetState.workspaces[0];
  assert.deepEqual(workspace.gadgets[0].entries.map((entry: { key: string }) => entry.key), ["ownerId", "votes"]);
  assert.match(workspace.gadgets[0].entries[0].value, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(workspace.gadgets[0].withheldKeys, [{ key: "note", reason: "not on the export allow-list" }]);
  assert.deepEqual(workspace.otherFacets, [{ facet: "gatekeeper1", reason: "gatekeeper state may hold credentials; not exported" }]);
  const text = JSON.stringify(documents);
  for (const forbidden of ["person-a@example.test", "Meet Dana", "fictional-gatekeeper-credential"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(first.structureDigest, second.structureDigest);
  assert.notEqual(first.gadgetState.workspaces[0].gadgets[0].entries[0].value,
    second.gadgetState.workspaces[0].gadgets[0].entries[0].value, "each export salts afresh");
});

test("a hung start fails within --timeout-ms and leaves nothing running", () => {
  // A build command no other test or stack runs, so finding it afterwards means it leaked.
  const marker = `fac162-hung-start-${process.pid}`;
  const dir = wrapper("hung", `node -e "setInterval(() => {}, 1000)" ${marker}`);
  const run = exportLocal(dir, "export", 4000);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /export-local did not finish within 4000ms; its process group was killed/);
  // The deadline starts once the CLI has loaded Wrangler and Miniflare, a few seconds at most.
  assert.ok(run.elapsed < 4000 + 15_000, `took ${run.elapsed}ms`);
  const left = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  assert.equal(left.stdout.trim(), "", "the hung build and its parents are gone");
  assert.ok(!existsSync(join(dir, "export")) || readdirSync(join(dir, "export")).length === 0, "nothing was written");
});

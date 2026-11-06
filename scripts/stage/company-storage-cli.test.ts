// FAC-162: `stage:company-storage export-local` end to end, on throwaway local wrappers with
// fictional data: the real Wrangler dry-run bundle, the real Miniflare, an Overseer declared unbound
// (as the InferOS backend declares it, reached through ctx.exports) whose gadget facets a real
// Miniflare seeded, and a wrapper whose start hangs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const cli = fileURLToPath(new URL("./company-storage-cli.ts", import.meta.url));
// Inside the checkout, so `pnpm exec wrangler` resolves; .wrangler is gitignored, and a clean clone
// (as in CI) doesn't have it yet.
const checkoutScratch = join(resolve(fileURLToPath(new URL("../..", import.meta.url))), ".wrangler");
mkdirSync(checkoutScratch, { recursive: true });
const scratch = mkdtempSync(join(checkoutScratch, "fac162-cli-"));
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
  // The unlisted key's name is hashed too: only a manifest-listed name is shown in clear.
  assert.equal(workspace.gadgets[0].withheldKeys.length, 1);
  assert.match(workspace.gadgets[0].withheldKeys[0].key, /^sha256:[0-9a-f]{64}$/);
  assert.equal(workspace.gadgets[0].withheldKeys[0].hashed, true);
  assert.deepEqual(workspace.otherFacets, [{ facet: "gatekeeper1", reason: "gatekeeper state may hold credentials; not exported" }]);
  const text = JSON.stringify(documents);
  for (const forbidden of ["person-a@example.test", "Meet Dana", "fictional-gatekeeper-credential"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(first.structureDigest, second.structureDigest);
  assert.notEqual(first.gadgetState.workspaces[0].gadgets[0].entries[0].value,
    second.gadgetState.workspaces[0].gadgets[0].entries[0].value, "each export salts afresh");
});

// The wrapper's own build runs after the manifest is checked and before the runtime opens its state,
// so a build that swaps a checked path is a writer racing the export, deterministically.
for (const { label, swap } of [
  { label: "stateDirectory", swap: (dir: string, sibling: string) =>
    `mv ${dir}/.wrangler/state ${dir}/.wrangler/state-checked && ln -s ${sibling}/.wrangler/state ${dir}/.wrangler/state` },
  { label: "workerConfig", swap: (dir: string, sibling: string) =>
    `mv ${dir}/wrangler.jsonc ${dir}/wrangler-checked.jsonc && ln -s ${sibling}/wrangler.jsonc ${dir}/wrangler.jsonc` },
]) {
  test(`a ${label} swapped for a symlink after the check is refused, and nothing starts`, () => {
    const sibling = wrapper(`sibling-of-${label}`);
    writeFileSync(join(sibling, ".wrangler", "state", "marker"), "sibling state");
    const dir = join(scratch, `swapped-${label}`);
    wrapper(`swapped-${label}`, swap(dir, sibling));
    const run = exportLocal(dir, "export");
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, new RegExp(`${label} changed since it was checked.*nothing was started`, "s"));
    assert.doesNotMatch(run.stdout, /"exported"/);
    assert.ok(!existsSync(run.outputDirectory), "nothing was written");
    // The runtime never opened the sibling's state: Miniflare would have created its directories there.
    assert.deepEqual(readdirSync(join(sibling, ".wrangler", "state")), ["marker"]);
  });
}

/**
 * Runs `purge-local --apply` against a local stand-in for InferOps' offboarding status that reports
 * the company purgeable, after running `duringStatus`: the status round-trip is the wait between
 * the CLI's checks and its delete.
 */
async function purgeLocal(dir: string, duringStatus: () => void) {
  const server = createServer((request, response) => {
    duringStatus();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ tenantId: TENANT, protected: false, state: "offboarded",
      offboardedAt: "2026-01-01T00:00:00.000Z", purgeAfter: "2026-02-01T00:00:00.000Z" }));
  });
  await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening));
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.inferopsBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const child = spawn(process.execPath, [cli, "purge-local", "--manifest", join(dir, "manifest.json"), "--apply"], {
      // A fictional bearer for the local stand-in; nothing real is reached.
      env: { ...process.env, INFEROPS_OFFBOARDING_TOKEN: "fictional-local-status-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [status] = await once(child, "exit") as [number | null];
    return { status, stdout, stderr };
  } finally {
    server.close();
  }
}

test("purge-local deletes its own wrapper's state once InferOps says the company is purgeable", async () => {
  const dir = wrapper("purge-own");
  writeFileSync(join(dir, ".wrangler", "state", "own"), "own state");
  const run = await purgeLocal(dir, () => {});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /local-purge-applied/);
  assert.ok(!existsSync(join(dir, ".wrangler", "state")));
});

test("purge-local refuses, deleting nothing, if a state path component is swapped during the status check", async () => {
  const sibling = wrapper("purge-sibling");
  writeFileSync(join(sibling, ".wrangler", "state", "marker"), "sibling state");
  const dir = wrapper("purge-swapped");
  writeFileSync(join(dir, ".wrangler", "state", "own"), "own state");
  const run = await purgeLocal(dir, () => {
    // After every check before the request: .wrangler now leads to the sibling's.
    renameSync(join(dir, ".wrangler"), join(dir, ".wrangler-checked"));
    symlinkSync(join(sibling, ".wrangler"), join(dir, ".wrangler"), "dir");
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /stateDirectory changed since it was checked.*nothing was started/s);
  assert.deepEqual(readdirSync(join(sibling, ".wrangler", "state")), ["marker"], "the sibling's state is untouched");
  assert.deepEqual(readdirSync(join(dir, ".wrangler-checked", "state")), ["own"], "nothing was deleted");
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

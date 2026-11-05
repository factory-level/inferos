// FAC-162: a company's gadget storage, read from the local Miniflare state it persisted, through
// the export allow-list. The fixtures are written by a real Miniflare, as facets of a Durable Object
// in the Overseer's layout, so the reader is proven against workerd's own on-disk format.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  exportGadgetState, parseFacetIndex, type GadgetStateAllowList, type WorkspaceGadgets,
} from "./gadget-state.ts";
import { exportCompanyStorage, structureDigest, type CompanyStorageBindings } from "./company-storage.ts";

const scratch = mkdtempSync(join(tmpdir(), "inferos-fac162-gadgets-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const WORKER = "company-backend";
const SCRIPT = `
import { DurableObject } from "cloudflare:workers";
export class Facet extends DurableObject {
  async write(entries) {
    for (const [key, value] of entries) await this.ctx.storage.put(key, value);
    if (entries.some(([key]) => key === "makeTable")) {
      this.ctx.storage.sql.exec("create table if not exists notes (body text)");
      this.ctx.storage.sql.exec("insert into notes values ('a note a person wrote')");
    }
    return true;
  }
}
export class OverseerDurableObject extends DurableObject {
  async seed(facets) {
    for (const [name, entries] of facets) {
      const facet = this.ctx.facets.get(name, () => ({ class: this.ctx.exports.Facet }));
      await facet.write(entries);
    }
    return this.ctx.id.toString();
  }
}
export default {
  async fetch(request, env) {
    const { workspace, facets } = await request.json();
    const ns = env.OVERSEER;
    return new Response(await ns.get(ns.idFromName(workspace)).seed(facets));
  },
};`;

/** Runs a real Miniflare that writes these facets into one workspace's Overseer, then stops it. */
async function seedCompany(state: string, workspace: string,
    facets: [string, [string, unknown][]][]): Promise<string> {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: WORKER, modules: true, script: SCRIPT, compatibilityDate: "2026-09-04",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { OVERSEER: { className: "OverseerDurableObject", useSQLite: true } },
    resourcePersistencePath: state,
  }));
  try {
    // Dates and values cross as structured clones, so they're stored as workerd stores them.
    const response = await mf.dispatchFetch("http://localhost/", {
      method: "POST", body: JSON.stringify({ workspace, facets: facets.map(([name, entries]) =>
        [name, entries.map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])]) }),
    });
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    await mf.dispose();
  }
}

const doDirectory = (state: string) => join(state, "do", `${WORKER}-OverseerDurableObject`);

const ALLOW_LIST: GadgetStateAllowList = [{
  blueprintId: "vote-tracker",
  keys: {
    votes: "number", open: "boolean", closesAt: "timestamp", ownerId: "actorId",
    issue: "issueKey", revision: "revision", runId: "uuid",
  },
  // Names a person checked aren't personal: shown in clear though their values are withheld.
  clearNames: ["unlistedNote", "notes"],
}];

// Names gadget code might choose that hold personal data or secrets. None is listed, so each must be
// hashed: hashing by default doesn't depend on recognising them.
const PERSONAL_NAMES = [
  "alice.smith", "+15551234567", "note: call mom", "api_token", "accessToken",
  "6b2d7c1e-4f3a-4b2c-9d1e-0a9b8c7d6e5f", "pat@example.test", "voter:Jane Doe", "member:123",
  "user:6b2d7c1e-4f3a-4b2c-9d1e-0a9b8c7d6e5f", "phone:+15551234567", "note:call her after the review",
  "bidi\u202eevil", "del\u007fname",
];

const A_ENTRIES: [string, unknown][] = [
  ["votes", 7], ["open", true], ["closesAt", "2026-11-05T00:00:00.000Z"],
  ["ownerId", "person-a@example.test"], ["issue", "GROK-12"], ["revision", "41"],
  ["runId", "0b7f3c1e-5d2a-4c1b-9a8e-3f6d2c1b0a99"],
  // On the allow-list, but not the rule's shape: withheld, by name.
  ["unlistedNote", "Meet Dana at the cafe"], ["contact:dana@example.test", "free text"],
  ["makeTable", 1],
  ...PERSONAL_NAMES.map((name): [string, unknown] => [name, 1]),
];

let companyA: { state: string; workspace: string } | undefined;
let companyB: { state: string; workspace: string } | undefined;

async function seeded() {
  if (companyA && companyB) return { a: companyA, b: companyB };
  const stateA = join(scratch, "company-a", ".wrangler", "state");
  const stateB = join(scratch, "company-b", ".wrangler", "state");
  const workspaceA = await seedCompany(stateA, "workspace-a", [
    ["gadget3", A_ENTRIES],
    ["gatekeeper1", [["token", "fictional-gatekeeper-credential"]]],
    ["gadget9", [["votes", 99]]],
  ]);
  // Company B uses the same blueprint and the same keys, with values that must never reach A's export.
  const workspaceB = await seedCompany(stateB, "workspace-b", [
    ["gadget3", [["votes", 555], ["ownerId", "person-b@example.test"], ["issue", "OTHER-999"]]],
  ]);
  companyA = { state: stateA, workspace: workspaceA };
  companyB = { state: stateB, workspace: workspaceB };
  return { a: companyA, b: companyB };
}

const gadgetsOfA = (workspace: string): WorkspaceGadgets => new Map([[workspace, [
  { id: 3, facet: "gadget3", blueprintId: "vote-tracker" },
  { id: 9, facet: "gadget9", blueprintId: null },
]]]);

test("reads workerd's facet index: names in creation order, facet n stored as <id>.n.sqlite", async () => {
  const { a } = await seeded();
  const index = readFileSync(join(doDirectory(a.state), `${a.workspace}.facets`));
  assert.deepEqual(parseFacetIndex(index), [
    { number: 1, parent: 0, name: "gadget3" },
    { number: 2, parent: 0, name: "gatekeeper1" },
    { number: 3, parent: 0, name: "gadget9" },
  ]);
  assert.throws(() => parseFacetIndex(Buffer.from("not a facet index")), /facet index/);
  assert.throws(() => parseFacetIndex(Buffer.concat([index.subarray(0, 8), Buffer.from([0, 0, 200, 0, 65])])), /facet index/);
});

test("exports a company's allow-listed gadget entries, hashing actor ids and withholding the rest by name", async () => {
  const { a } = await seeded();
  const exported = await exportGadgetState({ durableObjectDirectory: doDirectory(a.state),
    workspaces: gadgetsOfA(a.workspace), allowList: ALLOW_LIST, salt: "fixed-test-salt",
    scratchDirectory: scratch });
  const workspace = exported.workspaces[0];
  assert.equal(workspace.id, a.workspace);
  const tracker = workspace.gadgets.find(gadget => gadget.id === 3)!;
  assert.equal(tracker.blueprintId, "vote-tracker");
  assert.deepEqual(Object.fromEntries(tracker.entries.map(entry => [entry.key, entry.value])), {
    closesAt: "2026-11-05T00:00:00.000Z", issue: "GROK-12", open: true, revision: "41",
    runId: "0b7f3c1e-5d2a-4c1b-9a8e-3f6d2c1b0a99", votes: 7,
    ownerId: tracker.entries.find(entry => entry.key === "ownerId")!.value,
  });
  assert.match(String(tracker.entries.find(entry => entry.key === "ownerId")!.value), /^sha256:[0-9a-f]{64}$/);

  // Only a manifest-listed name is shown in clear; every other one is a salted hash, marked so.
  const clear = tracker.withheldKeys.filter(entry => !entry.hashed);
  assert.deepEqual(clear, [{ key: "unlistedNote", hashed: false, reason: "not on the export allow-list" }]);
  const hashed = tracker.withheldKeys.filter(entry => entry.hashed);
  // makeTable, contact:dana@…, and every personal name.
  assert.equal(hashed.length, 2 + PERSONAL_NAMES.length);
  for (const entry of hashed) {
    assert.match(entry.key, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.reason, "not on the export allow-list");
  }
  assert.deepEqual(tracker.sqlTables, [{ name: "notes", hashed: false, rows: 1, reason: "a gadget's SQL tables aren't exported" }]);

  // A gadget built from scratch has no allow-list: its keys appear hashed, and only as a count.
  const scratchGadget = workspace.gadgets.find(gadget => gadget.id === 9)!;
  assert.deepEqual(scratchGadget.entries, []);
  assert.equal(scratchGadget.withheldKeys.length, 1);
  assert.match(scratchGadget.withheldKeys[0].key, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual({ ...scratchGadget.withheldKeys[0], key: "…" },
    { key: "…", hashed: true, reason: "the gadget has no blueprint, so nothing of it is on the export allow-list" });
  // A gatekeeper's facet is named, never read.
  assert.deepEqual(workspace.otherFacets, [{ facet: "gatekeeper1", reason: "gatekeeper state may hold credentials; not exported" }]);

  const text = JSON.stringify(exported);
  for (const forbidden of [...PERSONAL_NAMES, "makeTable", "person-a@example.test", "dana@example.test", "Meet Dana", "free text",
    "fictional-gatekeeper-credential", "a note a person wrote", "token"]) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), forbidden);
  }
});

test("a value that doesn't match its rule is withheld by name, never shown", async () => {
  const { a } = await seeded();
  const exported = await exportGadgetState({ durableObjectDirectory: doDirectory(a.state),
    workspaces: gadgetsOfA(a.workspace),
    allowList: [{ blueprintId: "vote-tracker", keys: { votes: "boolean", issue: "uuid", unlistedNote: "number" } }],
    salt: "fixed-test-salt", scratchDirectory: scratch });
  const tracker = exported.workspaces[0].gadgets.find(gadget => gadget.id === 3)!;
  assert.deepEqual(tracker.entries, []);
  const reasons = Object.fromEntries(tracker.withheldKeys.map(entry => [entry.key, entry.reason]));
  assert.equal(reasons.votes, "its value doesn't match its allow-list rule (boolean)");
  assert.equal(reasons.issue, "its value doesn't match its allow-list rule (uuid)");
  assert.equal(reasons.unlistedNote, "its value doesn't match its allow-list rule (number)");
  assert.doesNotMatch(JSON.stringify(tracker), /GROK-12|Meet Dana/);
});

test("a second company's gadget entries never appear, though it has the same blueprint and keys", async () => {
  const { a, b } = await seeded();
  const exported = await exportGadgetState({ durableObjectDirectory: doDirectory(a.state),
    workspaces: gadgetsOfA(a.workspace), allowList: ALLOW_LIST, salt: "fixed-test-salt",
    scratchDirectory: scratch });
  const text = JSON.stringify(exported);
  assert.doesNotMatch(text, /555|OTHER-999|person-b/);
  assert.doesNotMatch(text, new RegExp(b.workspace));
  // A workspace the kernel didn't list is refused, so another company's id can't be named in.
  await assert.rejects(exportGadgetState({ durableObjectDirectory: doDirectory(a.state),
    workspaces: new Map([[b.workspace, [{ id: 3, facet: "gadget3", blueprintId: "vote-tracker" }]]]),
    allowList: ALLOW_LIST, salt: "fixed-test-salt", scratchDirectory: scratch }), /no persisted state/);
});

test("reading leaves the company's state byte-for-byte unchanged and cleans up its copies", async () => {
  const { a } = await seeded();
  const directory = doDirectory(a.state);
  const before = readdirSync(directory).toSorted().map(name => [name, readFileSync(join(directory, name)).toString("base64")]);
  const copies = mkdtempSync(join(scratch, "copies-"));
  await exportGadgetState({ durableObjectDirectory: directory, workspaces: gadgetsOfA(a.workspace),
    allowList: ALLOW_LIST, salt: "fixed-test-salt", scratchDirectory: copies });
  const afterRead = readdirSync(directory).toSorted().map(name => [name, readFileSync(join(directory, name)).toString("base64")]);
  assert.deepEqual(afterRead, before);
  assert.deepEqual(readdirSync(copies), []);
});

test("a rerun gives the same structure digest, though each export salts its hashes afresh", async () => {
  const { a } = await seeded();
  const run = async (salt?: string) => {
    const bindings: CompanyStorageBindings = {
      kv: new Map(), r2: new Map(), gadgetDurableObjects: [],
      workspaces: new Map([[a.workspace, { exportWorkspaceRecords: async () => ({
        actionLog: [{ id: 1, decidedBy: { type: "user", id: `sha256:${crypto.randomUUID().replaceAll("-", "").repeat(2)}` } }],
        gadgets: [{ id: 3, facet: "gadget3", blueprintId: "vote-tracker" }, { id: 9, facet: "gadget9", blueprintId: null }],
      }) }]]),
      gadgetState: { durableObjectDirectory: doDirectory(a.state), allowList: ALLOW_LIST, scratchDirectory: scratch },
    };
    return await exportCompanyStorage({ tenantId: "6f1c2b3a-0000-4000-8000-00000000a001", prefix: "inferos-acme-",
      resources: { kv: [], r2: [] }, bindings, outputDirectory: mkdtempSync(join(scratch, "out-")), salt });
  };
  const first = await run();
  const second = await run();
  const owner = (document: Record<string, unknown>) => JSON.stringify(document.gadgetState).match(/sha256:[0-9a-f]{64}/)?.[0];
  assert.notEqual(owner(first), owner(second), "each export salts its hashes afresh");
  assert.equal(first.structureDigest, second.structureDigest);
  assert.match(String(first.structureDigest), /^sha256:[0-9a-f]{64}$/);
  // With a fixed salt the gadget state itself is byte-identical.
  assert.equal(JSON.stringify((await run("fixed")).gadgetState), JSON.stringify((await run("fixed")).gadgetState));
  // The digest still moves when the data does.
  assert.notEqual(structureDigest({ ...first, gadgetState: { workspaces: [] } }), first.structureDigest);
});

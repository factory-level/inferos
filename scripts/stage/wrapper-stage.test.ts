import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStageConfigs, stageKvNamespaces, stagePackages, stageWorkerName } from "./stage-config.ts";
import { STAGES } from "./stages.ts";
import {
  claimMarkers, claimProblem, companyPrefix, conflictingInputs, inputSources, ownershipMarkers, ownershipProblem,
  createdNamespaceId, kvCreateOutcome, parseR2BucketList, type ClaimOps,
  parseWrapperDeployment, pinnedRevisionFromLsTree, readWrapperStage, workerProbe, wrapperStage,
  type WrapperDeployment,
} from "./wrapper-stage.ts";
import { readDeployablePackages } from "../release/manifest-lib.ts";
import { ROOT } from "../preview/staging-config.ts";

// A fictional company on reserved example names; nothing here is a real deployment.
const ACME = {
  schemaVersion: 1,
  company: "acme",
  hostname: "os.acme.example",
  inferops: {
    baseUrl: "https://api.inferlab.io",
    authOrigin: "https://auth.inferlab.io",
    // A fictional tenant id: the one InferLab company this deployment serves (FAC-160).
    tenantId: "00000000-0000-4000-8000-0000000000ac",
    resources: ["tables"],
  },
};

const parsed = (raw: unknown): WrapperDeployment => {
  const result = parseWrapperDeployment(raw);
  if ("problems" in result) throw new Error(result.problems.join("; "));
  return result.deployment;
};
const problemsOf = (raw: unknown): string[] => {
  const result = parseWrapperDeployment(raw);
  if ("deployment" in result) {
    const built = wrapperStage(result.deployment);
    return "problems" in built ? built.problems : [];
  }
  return result.problems;
};
const built = (raw: unknown) => {
  const result = wrapperStage(parsed(raw));
  if ("problems" in result) throw new Error(result.problems.join("; "));
  return result.stage;
};

test("a deploy file becomes a stage whose names all derive from the company", () => {
  const { name, company, stage } = built(ACME);
  assert.equal(name, "company-acme");
  assert.equal(company, "acme");
  assert.equal(stage.workerPrefix, "inferos-acme-");
  assert.equal(stage.resourcePrefix, "inferos-acme-");
  assert.equal(stage.requireCleanTree, true);
  assert.deepEqual(stage.auth, { mode: "inferlab" });
  assert.deepEqual(stage.inferops.resources, ["tables"]);
  // The same gatekeepers as the persistent stages, so the plan is the reviewed one.
  assert.deepEqual(stage.gatekeepers, STAGES.prod.gatekeepers);
  const packages = stagePackages(stage, readDeployablePackages(ROOT));
  for (const pkg of packages) assert.ok(stageWorkerName(stage, pkg.name).startsWith("inferos-acme-"), pkg.name);
  for (const ns of stageKvNamespaces(stage, packages)) assert.ok(ns.title.startsWith("inferos-acme-"), ns.title);
});

test("two companies' prefixes never overlap, and none overlaps a persistent stage's", () => {
  // No hyphen in a slug, so one company's prefix is never the start of another's.
  for (const [a, b] of [["acme", "acmeeu"], ["acme", "acm"], ["a1", "a10"]] as const) {
    assert.ok(!companyPrefix(b).startsWith(companyPrefix(a)) && !companyPrefix(a).startsWith(companyPrefix(b)), `${a}/${b}`);
  }
  assert.ok(problemsOf({ ...ACME, company: "acme-eu" }).some((p) => /no hyphens/.test(p)));
  for (const reserved of ["dev", "prod", "staging", "preview", "disposable"]) {
    assert.ok(problemsOf({ ...ACME, company: reserved }).some((p) => p.includes("is reserved")), reserved);
  }
});

test("a persistent stage's hostname is refused", () => {
  assert.ok(problemsOf({ ...ACME, hostname: STAGES.prod.hostname }).some((p) => p.includes('the "prod" stage')));
  assert.ok(problemsOf({ ...ACME, hostname: "auth.dev-os.factorylevel.dev" }).some((p) => p.includes('the "dev" stage')));
  // The sign-in proxy's hostname is a custom domain too, and is checked the same way.
  const proxied = { ...ACME, inferops: { ...ACME.inferops, authorizeOrigin: "https://auth.dev-os.factorylevel.dev" } };
  assert.ok(problemsOf(proxied).some((p) => p.includes("hostname auth.dev-os.factorylevel.dev is the \"dev\" stage's")));
  const ownProxy = { ...ACME, inferops: { ...ACME.inferops, authorizeOrigin: "https://auth.os.acme.example" } };
  assert.deepEqual(problemsOf(ownProxy), []);
});

test("the file is read strictly and every problem is named", () => {
  assert.deepEqual(problemsOf([]), ["the file must be a JSON object"]);
  const problems = problemsOf({ schemaVersion: 2, company: "A", hostname: "", inferops: { baseUrl: 1, extra: true, resources: ["nope"] }, other: 1 });
  for (const expected of [
    'unknown field "other"', "schemaVersion must be 1", "company must be", "hostname is required",
    'unknown field "inferops.extra"', "inferops.baseUrl is required", "inferops.authOrigin is required",
    "inferops.resources must list only",
  ]) assert.ok(problems.some((p) => p.includes(expected)), expected);
  assert.ok(problemsOf({ ...ACME, inferops: { ...ACME.inferops, resources: ["tables", "tables"] } })
    .some((p) => p.includes("twice")));
  // The persistent stages' own rules apply too: an origin that is not HTTPS is refused.
  assert.ok(problemsOf({ ...ACME, inferops: { ...ACME.inferops, baseUrl: "http://api.inferlab.io" } }).length > 0);
});

test("readWrapperStage reads the wrapper root's file and refuses an invalid one", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrapper-stage-"));
  try {
    assert.throws(() => readWrapperStage(dir), /cannot read inferos\.deploy\.json/);
    writeFileSync(join(dir, "inferos.deploy.json"), JSON.stringify({ ...ACME, company: "dev" }));
    assert.throws(() => readWrapperStage(dir), /is reserved/);
    writeFileSync(join(dir, "inferos.deploy.json"), JSON.stringify(ACME));
    assert.equal(readWrapperStage(dir).name, "company-acme");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const none = { kv: [] as string[], r2: [] as string[], workers: [] as string[] };

test("a deployment claims its prefix with one marker per hostname it serves", () => {
  assert.deepEqual(ownershipMarkers(built(ACME).stage), ["inferos-acme-owner.os.acme.example"]);
  const proxied = built({ ...ACME, inferops: { ...ACME.inferops, authorizeOrigin: "https://auth.os.acme.example" } }).stage;
  assert.deepEqual(ownershipMarkers(proxied), ["inferos-acme-owner.os.acme.example", "inferos-acme-owner.auth.os.acme.example"]);
});

test("the account check refuses rival claims, even beside this deployment's own", () => {
  const { stage } = built(ACME);
  const [mine] = ownershipMarkers(stage);
  // A fresh account, or one holding other companies only: free.
  assert.equal(ownershipProblem(none, stage), null);
  assert.equal(ownershipProblem({ ...none, kv: ["inferos-dev-kv", "inferos-acmeeu-owner.eu.example", "inferos-acmeeu-kv"] }, stage), null);
  // Already this deployment's: a redeploy.
  assert.equal(ownershipProblem({ kv: [mine!, "inferos-acme-x"], r2: ["inferos-acme-blueprint-content"], workers: ["inferos-acme-router"] }, stage), null);
  // The same slug claimed for another hostname: refused, and still refused beside our own marker.
  assert.match(ownershipProblem({ ...none, kv: ["inferos-acme-owner.os.other.example"] }, stage) ?? "", /claimed by another one \(inferos-acme-owner\.os\.other\.example\)/);
  assert.match(ownershipProblem({ ...none, kv: [mine!, "inferos-acme-owner.os.other.example"] }, stage) ?? "", /claimed by another one/);
  // This hostname claimed under another slug: refused.
  assert.match(ownershipProblem({ ...none, kv: ["inferos-beta-owner.os.acme.example"] }, stage) ?? "", /inferos-beta-owner\.os\.acme\.example/);
});

test("with no claim, any Worker, KV namespace or R2 bucket under the prefix refuses", () => {
  const { stage } = built(ACME);
  for (const [kind, resources] of [
    ["KV namespace", { ...none, kv: ["inferos-acme-workshop-backend-blueprints"] }],
    ["R2 bucket", { ...none, r2: ["inferos-acme-blueprint-content"] }],
    ["Worker", { ...none, workers: ["inferos-acme-router"] }],
  ] as const) {
    assert.match(ownershipProblem(resources, stage) ?? "", new RegExp(`no owner record \\(${kind} inferos-acme-`), kind);
  }
  // Other prefixes don't count.
  assert.equal(ownershipProblem({ kv: ["inferos-acmeeu-kv"], r2: ["inferos-dev-blueprint-content"], workers: [] }, stage), null);
});

test("after claiming, a rival claim that appeared meanwhile withdraws this one", () => {
  const { stage } = built(ACME);
  const [mine] = ownershipMarkers(stage);
  assert.equal(claimProblem([mine!, "inferos-acme-kv"], stage), null);
  assert.match(claimProblem(["inferos-acme-x"], stage) ?? "", /isn't listed/);
  assert.match(claimProblem([mine!, "inferos-acme-owner.os.other.example"], stage) ?? "", /at the same time/);
  assert.match(claimProblem([mine!, "inferos-beta-owner.os.acme.example"], stage) ?? "", /at the same time/);
});

test("Wrangler's answers are read strictly, and an unreadable one refuses", () => {
  assert.deepEqual(parseR2BucketList("Listing buckets...\nname:           inferos-acme-blueprint-content\ncreation_date:  2026-11-03T00:00:00Z\n\nname:           other\ncreation_date:  x\n"),
    ["inferos-acme-blueprint-content", "other"]);
  assert.deepEqual(parseR2BucketList("Listing buckets...\n"), []);
  assert.equal(parseR2BucketList("something else"), null);
  assert.equal(workerProbe(0, "[]", ""), true);
  assert.equal(workerProbe(1, "", "✘ [ERROR] A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]"), false);
  assert.equal(workerProbe(1, JSON.stringify({ errors: [{ code: 10007, message: "not found" }] }), ""), false);
  assert.equal(workerProbe(1, JSON.stringify({ code: 10007 }), ""), false);
  assert.throws(() => workerProbe(1, "", "Authentication error [code: 10000]"), /cannot tell whether the worker exists/);
  // A 10007 that isn't the error code (an id, a date) doesn't mean not found.
  assert.throws(() => workerProbe(1, "", "failed for script id 4410007a at 2026-10007"), /cannot tell/);
  assert.throws(() => workerProbe(1, JSON.stringify({ errors: [{ code: 10000, message: "see 10007" }] }), ""), /cannot tell/);
});

const MARKER = "inferos-acme-owner.os.acme.example";
const OURS = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const listed = (entries: [string, string][]) => ({
  status: 0,
  stdout: `Listing namespaces...\n${JSON.stringify(entries.map(([id, title]) => ({ id, title })))}`,
  stderr: "",
});
const cleanup = (error: Error) =>
  error.message.includes(`"${MARKER}" may have been created`) &&
  error.message.includes("wrangler kv namespace list") &&
  error.message.includes("wrangler kv namespace delete --namespace-id");

test("a create's own output is never read for an id", () => {
  // Whatever ids the create printed, the outcome is only "created": the id comes from the list.
  assert.deepEqual(
    kvCreateOutcome(MARKER, {
      status: 0,
      stdout: `warning "id": "${OTHER}"\n🌀 Creating namespace with title "${MARKER}"\n✨ Success!\nid = "${OTHER}"\n`,
      stderr: "",
    }),
    { created: true },
  );
  assert.deepEqual(
    kvCreateOutcome(MARKER, { status: 1, stdout: "", stderr: `A KV namespace with the title "${MARKER}" already exists.` }),
    { exists: true },
  );
  assert.throws(() => kvCreateOutcome(MARKER, { status: 1, stdout: "", stderr: "Authentication error" }), /failed:\nAuthentication error/);
});

test("the created namespace's id is the one listed under exactly its title", () => {
  assert.equal(
    createdNamespaceId(MARKER, listed([[OTHER, `${MARKER}-old`], [OURS, MARKER], [OTHER.replace("f", "e"), `x${MARKER}`]])),
    OURS,
  );
});

test("a created title missing from the list fails, naming the title and the cleanup", () => {
  assert.throws(() => createdNamespaceId(MARKER, listed([[OTHER, "inferos-beta-owner.os.beta.example"]])), cleanup);
  // A list that can't be read is the same: the namespace may exist, so say how to remove it.
  assert.throws(() => createdNamespaceId(MARKER, { status: 1, stdout: "", stderr: "Authentication error" }), cleanup);
  assert.throws(() => createdNamespaceId(MARKER, { status: 0, stdout: "not logged in", stderr: "" }), cleanup);
});

test("two namespaces with the created title fail, naming the title and the cleanup", () => {
  assert.throws(() => createdNamespaceId(MARKER, listed([[OURS, MARKER], [OTHER, MARKER]])), (error: Error) =>
    cleanup(error) && error.message.includes(`two KV namespaces are titled "${MARKER}"`));
});

/** A fake account: titles by id, with hooks to make things happen between steps. */
function fakeAccount(initial: Record<string, string>, hooks: { beforeCreate?: (title: string) => void; afterCreate?: () => void } = {}) {
  const namespaces = new Map(Object.entries(initial));
  const removed: string[] = [];
  let next = 0;
  const ops: ClaimOps = {
    list: async () => [...namespaces.values()],
    create: async (title) => {
      hooks.beforeCreate?.(title);
      if ([...namespaces.values()].includes(title)) return { exists: true };
      const id = `mine-${next++}`;
      namespaces.set(id, title);
      hooks.afterCreate?.();
      return { id };
    },
    remove: async (id) => { removed.push(id); namespaces.delete(id); },
  };
  return { ops, namespaces, removed, other: (id: string, title: string) => namespaces.set(id, title) };
}

test("claiming creates the missing markers and keeps them when no rival appears", async () => {
  const { stage } = built(ACME);
  const account = fakeAccount({});
  assert.deepEqual(await claimMarkers(stage, account.ops), ["inferos-acme-owner.os.acme.example"]);
  assert.deepEqual(account.removed, []);
  // A redeploy holds its claim already and creates nothing.
  assert.deepEqual(await claimMarkers(stage, account.ops), []);
});

test("a marker another run creates between the listings is never removed", async () => {
  const { stage } = built(ACME);
  const [marker] = ownershipMarkers(stage);
  // The other run's create lands after this run's first listing and before its own create.
  const account = fakeAccount({}, { beforeCreate: (title) => { if (title === marker) account.other("theirs", title); } });
  await assert.rejects(claimMarkers(stage, account.ops), /another run holds it/);
  assert.deepEqual(account.removed, []);
  assert.equal(account.namespaces.get("theirs"), marker);
});

test("on a rival claim, only the ids this run created are removed", async () => {
  const proxied = built({ ...ACME, inferops: { ...ACME.inferops, authorizeOrigin: "https://auth.os.acme.example" } }).stage;
  const [first, second] = ownershipMarkers(proxied);
  // A rival for another hostname appears after this run's creates: both of ours go, theirs stays.
  const rival = fakeAccount({}, { afterCreate: () => rival.other("theirs", "inferos-acme-owner.os.other.example") });
  await assert.rejects(claimMarkers(proxied, rival.ops), /at the same time/);
  assert.deepEqual(rival.removed.toSorted(), ["mine-0", "mine-1"]);
  assert.equal(rival.namespaces.get("theirs"), "inferos-acme-owner.os.other.example");
  // The second marker taken meanwhile: the first (ours) is withdrawn, the second (theirs) kept.
  const taken = fakeAccount({}, { beforeCreate: (title) => { if (title === second) taken.other("theirs", title); } });
  await assert.rejects(claimMarkers(proxied, taken.ops), /another run holds it/);
  assert.deepEqual(taken.removed, ["mine-0"]);
  assert.equal(taken.namespaces.get("theirs"), second);
  assert.equal([...taken.namespaces.values()].includes(first!), false);
});

test("a failed create withdraws what this run made and says so", async () => {
  const proxied = built({ ...ACME, inferops: { ...ACME.inferops, authorizeOrigin: "https://auth.os.acme.example" } }).stage;
  let calls = 0;
  const account = fakeAccount({});
  const failing: ClaimOps = { ...account.ops, create: async (title) => {
    if (calls++ === 1) throw new Error("network");
    return account.ops.create(title);
  } };
  await assert.rejects(claimMarkers(proxied, failing), /claiming failed: network/);
  assert.deepEqual(account.removed, ["mine-0"]);
});

test("the log names where each input came from, never its value", () => {
  assert.deepEqual(inputSources({ STAGE_ADMINS: "a@acme.example", OTHER: "x" }, { CLOUDFLARE_ACCOUNT_ID: "1", PATH: "/bin", INFEROPS_EDGE_SECRET: "s" }),
    ["CLOUDFLARE_ACCOUNT_ID (shell)", "INFEROPS_EDGE_SECRET (shell)", "STAGE_ADMINS (file)"]);
});

test("a vars file and the shell disagreeing on a name is reported, by name only", () => {
  assert.deepEqual(conflictingInputs({ STAGE_ADMINS: "a@acme.example", CLOUDFLARE_ACCOUNT_ID: "1" }, { STAGE_ADMINS: "a@acme.example", CLOUDFLARE_ACCOUNT_ID: "2" }), ["CLOUDFLARE_ACCOUNT_ID"]);
  assert.deepEqual(conflictingInputs({ INFEROPS_EDGE_SECRET: "x" }, {}), []);
});

test("the pinned revision is read from the wrapper's gitlink only", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(pinnedRevisionFromLsTree(`160000 commit ${sha}\tinferos\n`), sha);
  assert.equal(pinnedRevisionFromLsTree(`100644 blob ${sha}\tinferos\n`), null);
  assert.equal(pinnedRevisionFromLsTree(""), null);
});

test("a wrapper names its company's tenant id, and never internal", () => {
  const withTenant = (tenantId: unknown) => ({ ...ACME, inferops: { ...ACME.inferops, tenantId } });
  const { tenantId: _omitted, ...withoutTenant } = ACME.inferops;
  // Missing: refused, saying what it is for.
  assert.ok(problemsOf({ ...ACME, inferops: withoutTenant }).some((p) => p.includes("inferops.tenantId is required")));
  // `internal` admits every tenant: refused for a company's deployment.
  assert.ok(problemsOf(withTenant("internal")).some((p) => p.includes('can\'t be "internal"')));
  // Not a lowercase tenant id: refused, without echoing the value.
  for (const bad of ["acme", "00000000-0000-4000-8000-0000000000AC", "", 42]) {
    const problems = problemsOf(withTenant(bad));
    assert.ok(problems.some((p) => p.startsWith("inferops.tenantId")), String(bad));
    if (typeof bad === "string" && bad) assert.ok(problems.every((p) => !p.includes(bad)), String(bad));
  }
});

test("the company's tenant id becomes the stage's company and the gatekeeper's INFEROPS_COMPANY", () => {
  const result = wrapperStage(parsed(ACME));
  if ("problems" in result) throw new Error(result.problems.join("; "));
  assert.equal(result.stage.stage.inferops.company, ACME.inferops.tenantId);
  const packages = stagePackages(result.stage.stage, readDeployablePackages(ROOT));
  const kvIds = new Map(stageKvNamespaces(result.stage.stage, packages).map((ns, i) => [ns.title, `kv-${i}`]));
  const configs = buildStageConfigs({
    stageName: result.stage.name, stage: result.stage.stage, packages, accountId: "0".repeat(32), kvIds,
  });
  assert.equal(configs.get("gatekeeper-inferops")?.vars?.INFEROPS_COMPANY, ACME.inferops.tenantId);
});

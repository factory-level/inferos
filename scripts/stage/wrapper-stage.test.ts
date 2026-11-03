import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageKvNamespaces, stagePackages, stageWorkerName } from "./stage-config.ts";
import { STAGES } from "./stages.ts";
import {
  companyPrefix, ownershipMarker, ownershipProblem, parseWrapperDeployment, pinnedRevisionFromLsTree,
  readWrapperStage, wrapperStage, type WrapperDeployment,
} from "./wrapper-stage.ts";
import { readDeployablePackages } from "../release/manifest-lib.ts";
import { ROOT } from "../preview/staging-config.ts";

// A fictional company on reserved example names; nothing here is a real deployment.
const ACME = {
  schemaVersion: 1,
  company: "acme",
  hostname: "os.acme.example",
  inferops: { baseUrl: "https://api.inferlab.io", authOrigin: "https://auth.inferlab.io", resources: ["tables"] },
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
  for (const reserved of ["dev", "prod", "staging", "preview"]) {
    assert.ok(problemsOf({ ...ACME, company: reserved }).some((p) => p.includes("is reserved")), reserved);
  }
});

test("a persistent stage's hostname is refused", () => {
  assert.ok(problemsOf({ ...ACME, hostname: STAGES.prod.hostname }).some((p) => p.includes('the "prod" stage')));
  assert.ok(problemsOf({ ...ACME, hostname: "auth.dev-os.factorylevel.dev" }).some((p) => p.includes('the "dev" stage')));
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

test("the account check refuses another deployment's prefix and unowned resources", () => {
  const { stage } = built(ACME);
  const mine = ownershipMarker(stage);
  assert.equal(mine, "inferos-acme-owner.os.acme.example");
  // A fresh account, or one with other companies only: free.
  assert.equal(ownershipProblem([], stage), null);
  assert.equal(ownershipProblem(["inferos-dev-kv", "inferos-acmeeu-owner.eu.example", "inferos-acmeeu-kv"], stage), null);
  // Already this deployment's: a redeploy.
  assert.equal(ownershipProblem([mine, "inferos-acme-something"], stage), null);
  // The same slug claimed for another hostname: refused, naming it.
  assert.match(ownershipProblem(["inferos-acme-owner.os.other.example", "inferos-acme-kv"], stage) ?? "", /another deployment \(os\.other\.example\)/);
  // Resources under the prefix with no marker: not adopted.
  assert.match(ownershipProblem(["inferos-acme-kv"], stage) ?? "", /no owner record/);
});

test("the pinned revision is read from the wrapper's gitlink only", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(pinnedRevisionFromLsTree(`160000 commit ${sha}\tinferos\n`), sha);
  assert.equal(pinnedRevisionFromLsTree(`100644 blob ${sha}\tinferos\n`), null);
  assert.equal(pinnedRevisionFromLsTree(""), null);
});

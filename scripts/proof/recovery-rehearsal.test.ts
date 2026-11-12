// The recovery rehearsal's safety rails (recovery-rehearsal.ts, rehearsal-operator.ts): each is a
// refusal, so each test shows what it refuses and the one case that passes. Offline: nothing here
// starts a stack, a backend or a database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { databaseRefusal, manifestDifferences, rehearsalRefusal, stateManifest, type TargetFacts } from "./recovery-rehearsal.ts";
import { isLocalStackUrl, summarize } from "./rehearsal-operator.ts";

const ROOT = "/repo/inferOS";
const TARGET = `${ROOT}/.worktrees/rehearsal`;
const facts = (overrides: Partial<TargetFacts> = {}): TargetFacts => ({
  realPath: TARGET, repoRoot: ROOT, trackedChanges: "", stack: "not-running", backend: "not-running",
  env: { PATH: "/usr/bin", HOME: "/home/x" }, ...overrides,
});

test("a clean, idle worktree under .worktrees/ in a clean shell passes", () => {
  assert.equal(rehearsalRefusal(TARGET, facts()), null);
});

test("the main checkout, a path outside .worktrees/, a nested path, a relative or missing path are refused", () => {
  assert.match(rehearsalRefusal(ROOT, facts({ realPath: ROOT }))!, /main checkout/);
  assert.match(rehearsalRefusal("/elsewhere/wt", facts({ realPath: "/elsewhere/wt" }))!, /not a worktree directly under/);
  assert.match(rehearsalRefusal(`${TARGET}/packages`, facts({ realPath: `${TARGET}/packages` }))!, /not a worktree directly under/);
  // A symlink into .worktrees/ is judged by where it really points.
  assert.match(rehearsalRefusal("/tmp/link", facts({ realPath: ROOT }))!, /main checkout/);
  assert.match(rehearsalRefusal("relative/wt", facts())!, /absolute path/);
  assert.match(rehearsalRefusal(TARGET, facts({ realPath: null }))!, /does not exist/);
});

test("uncommitted changes, or a git that fails, are refused", () => {
  assert.match(rehearsalRefusal(TARGET, facts({ trackedChanges: " M scripts/local/stack.ts" }))!, /uncommitted changes/);
  assert.match(rehearsalRefusal(TARGET, facts({ trackedChanges: null }))!, /git status failed/);
});

test("a stack or a backend already running, or anyone else's on the port, is refused", () => {
  for (let stack of ["running", "port-in-use-by-other", "unknown"]) {
    assert.match(rehearsalRefusal(TARGET, facts({ stack }))!, /stop it first/, stack);
  }
  for (let backend of ["running", "starting", "port-in-use-by-other"]) {
    assert.match(rehearsalRefusal(TARGET, facts({ backend }))!, /inferops down first/, backend);
  }
});

test("a shell holding a cloud or model-provider credential is refused, by name only", () => {
  let refusal = rehearsalRefusal(TARGET, facts({ env: { CLOUDFLARE_API_TOKEN: "secret-value", ANTHROPIC_API_KEY: "sk-x" } }))!;
  assert.match(refusal, /CLOUDFLARE_API_TOKEN/);
  assert.match(refusal, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(refusal, /secret-value|sk-x/);
});

test("only localhost, and only this run's own inferos_<port> database", () => {
  let local = "postgres://postgres:postgres@localhost:5432/postgres";
  assert.equal(databaseRefusal(local, "inferos_8850", "inferos_8850"), null);
  assert.match(databaseRefusal("postgres://u:p@db.example.com/postgres", "inferos_8850", "inferos_8850")!, /only against localhost/);
  for (let name of ["inferlab", "inferlab_126", "inferos_8850; DROP DATABASE inferlab", "postgres"]) {
    assert.match(databaseRefusal(local, name, "inferos_8850")!, /only a backend's own/, name);
  }
  assert.match(databaseRefusal(local, "inferos_8860", "inferos_8850")!, /this run's backend uses inferos_8850/);
  assert.match(databaseRefusal("not a url", "inferos_8850", "inferos_8850")!, /does not parse/);
});

test("the state manifest hashes every file, so one changed byte or a missing file is a difference", () => {
  let dir = mkdtempSync(join(tmpdir(), "rehearsal-manifest-"));
  mkdirSync(join(dir, "v3", "do"), { recursive: true });
  writeFileSync(join(dir, "v3", "do", "a.sqlite"), "one");
  writeFileSync(join(dir, "v3", "kv"), "two");
  let before = stateManifest(dir);
  assert.deepEqual(Object.keys(before), ["v3/do/a.sqlite", "v3/kv"]);
  assert.deepEqual(manifestDifferences(before, stateManifest(dir)), []);
  writeFileSync(join(dir, "v3", "kv"), "twO");
  assert.deepEqual(manifestDifferences(before, stateManifest(dir)), ["v3/kv"]);
  assert.deepEqual(manifestDifferences(before, {}), ["v3/do/a.sqlite", "v3/kv"]);
  assert.deepEqual(stateManifest(join(dir, "absent")), {});
});

test("the operator signs in only to a local stack, and reports an action's code, never its message", () => {
  assert.equal(isLocalStackUrl("http://localhost:8850"), true);
  assert.equal(isLocalStackUrl("http://127.0.0.1:8850"), true);
  assert.equal(isLocalStackUrl("https://dev-os.example.com"), false);
  assert.equal(isLocalStackUrl("nonsense"), false);
  assert.deepEqual(summarize({ id: 4, state: "failed", type: "action", lastAttempt: { outcome: "notApplied", code: "STALE_REVISION" } }),
    { id: 4, state: "failed", type: "action", failure: "STALE_REVISION" });
  assert.deepEqual(summarize({ id: 5, state: "pending", type: "action" }), { id: 5, state: "pending", type: "action" });
});

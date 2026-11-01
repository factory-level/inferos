// The repeatable local proof of the test InferOps backend: up, status, verify, env, down against
// the real sibling inferops repository at the pinned revision. Opt-in, because it needs that
// repository, bun, psql and the shared local Postgres:
//
//   INFEROPS_BACKEND_LIVE=1 node --test scripts/local/inferops.live.test.ts
//
// It runs on its own stack port (INFEROPS_BACKEND_LIVE_PORT, default 8797, so the API is 18797 and
// the database inferos_8797), never on a developer's 8787 stack, and with a reduced environment
// (PATH, HOME, LANG and INFEROPS_REPO only), the way the skill tells an agent to run it.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { defaultDeps, EXIT_FAILED, EXIT_OK, runLifecycle } from "./lifecycle.ts";

const LIVE = process.env.INFEROPS_BACKEND_LIVE === "1";
const PORT = process.env.INFEROPS_BACKEND_LIVE_PORT ?? "8797";
const REPO = join(import.meta.dirname, "..", "..");

test("the pinned InferOps backend comes up, proves both wirings, exports the live variables and goes down", { skip: !LIVE && "set INFEROPS_BACKEND_LIVE=1 to run against the sibling inferops repository" }, async () => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8" };
  if (process.env.INFEROPS_REPO) env.INFEROPS_REPO = process.env.INFEROPS_REPO;
  const deps = { ...defaultDeps, root: REPO, env };
  const run = (argv: string[]) => runLifecycle(["inferops", ...argv, "--json", "--port", PORT], deps);

  const up = await run(["up", "--timeout", "600"]);
  assert.equal(up.exitCode, EXIT_OK, JSON.stringify(up.report));
  assert.equal(up.report.apiUrl, `http://localhost:${Number(PORT) + 10_000}`);
  assert.equal(up.report.database, `inferos_${PORT}`);
  assert.match(String(up.report.revision), /^[0-9a-f]{40}$/);
  try {
    const status = await run(["status"]);
    assert.equal(status.exitCode, EXIT_OK, JSON.stringify(status.report));
    assert.equal(status.report.backend, "running");
    assert.equal(status.report.healthy, true);

    const again = await run(["up"]);
    assert.equal(again.report.reused, true, "a second up adopts the running backend");

    const verify = await run(["verify"]);
    assert.equal(verify.exitCode, EXIT_OK, JSON.stringify(verify.report));
    const stopgap = verify.report.stopgap as { ok: boolean; project: string; states: number; issues: number };
    const signIn = verify.report.signIn as { ok: boolean; project?: string; skipped?: string };
    assert.equal(stopgap.ok, true);
    assert.equal(stopgap.project, "ENG");
    assert.ok(stopgap.states > 0 && stopgap.issues > 0, JSON.stringify(stopgap));
    assert.equal(signIn.ok, true, JSON.stringify(signIn));
    assert.equal(signIn.project, "GROK");
    assert.ok(!JSON.stringify(verify.report).toLowerCase().includes("bearer "), "no bearer in the report");

    const exported = await run(["env", "--stopgap"]);
    assert.equal(exported.exitCode, EXIT_OK, JSON.stringify({ ...exported.report, shell: "<omitted>" }));
    const names = exported.report.exports as string[];
    for (const name of ["INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG", "INFEROPS_LIVE_BASE_URL", "INFEROPS_LIVE_TOKEN", "INFEROPS_LIVE_TENANT", "INFEROPS_LIVE_PROJECT"]) {
      assert.ok(names.includes(name), name);
    }
  } finally {
    const down = await run(["down"]);
    assert.equal(down.exitCode, EXIT_OK, JSON.stringify(down.report));
  }
  const gone = await run(["status"]);
  assert.equal(gone.exitCode, EXIT_FAILED);
  assert.equal(gone.report.backend, "not-running");
});

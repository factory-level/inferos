// `pnpm local seed` and `pnpm local verify` against a real Workshop with the real InferOps
// gatekeeper (mock data), driven exactly as the lifecycle CLI drives them: the operator scripts run
// as Node subprocesses. Proves readiness is an authenticated RPC plus a board read through the
// gatekeeper connection, that seeding twice changes nothing, and that an offline fixture run makes
// no external request -- the interceptor would have thrown, and the escape list is asserted empty.

import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const OPERATORS = resolve(import.meta.dirname, "../../workshop-backend/scripts");
const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const DEMO_BOARD = "inferops://demo.local/project/board/DEMO";
const USER = "lifecycleverify";

type Report = {
  ok: boolean; step?: string; error?: string; connectionCreated?: boolean;
  workspace?: { id: string; title: string };
  agentView?: {
    inferops: { connected: boolean; mode: string; displayName?: string };
    board: { readable: boolean; connectionId: number; bindingName: string; tsType: string; project: string; states: number; issues: number; host: string };
    approvalQueue: { reachable: boolean; pending: number; proposed?: string };
  };
};

const network = new NetworkInterceptor();
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      // `build:inferops-gatekeeper` validated the Worker before this file started, the same way the
      // Workshop's own build is skipped under WORKSHOP_INTEGRATION_PREBUILT (see harness.ts).
      patch: config => { if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build; },
    }],
  });
});

afterAll(async () => {
  await harness.server.close();
  network.uninstall();
  expect(network.getUnmockedCalls()).toEqual([]);
});

/** Run an operator script as the CLI does, returning its JSON report and exit code. */
async function operator(script: string, ...args: string[]): Promise<{ code: number; report: Report; output: string }> {
  const base = ["--url", harness.url.origin, "--user", USER, "--password", "verify-password"];
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [resolve(OPERATORS, script), ...base, ...args], { timeout: 60_000 });
    return { code: 0, report: JSON.parse(stdout), output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, report: failed.stdout ? JSON.parse(failed.stdout) : { ok: false },
      output: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

it("verify fails closed before seeding, naming the step, and never creates anything", async () => {
  const noAccount = await operator("dev-verify.ts");
  expect(noAccount.code).toBe(1);
  expect(noAccount.report).toMatchObject({ ok: false, step: "signIn" });
  expect(noAccount.report.error).toMatch(/pnpm local seed/);

  // dev-setup.ts without --inferops: the account exists but the gatekeeper is not opted into.
  const setup = await operator("dev-setup.ts");
  expect(setup.report).toMatchObject({ ok: true, accountCreated: true });
  const noInferOps = await operator("dev-verify.ts");
  expect(noInferOps.report).toMatchObject({ ok: false, step: "inferops" });

  const opted = await operator("dev-setup.ts", "--inferops");
  expect(opted.report).toMatchObject({ ok: true, accountCreated: false, inferops: "provisioned" });
  const noWorkspace = await operator("dev-verify.ts");
  expect(noWorkspace.report).toMatchObject({ ok: false, step: "workspace" });
});

it("seeding is idempotent: the board connection and the pending move are found again, not recreated", async () => {
  const first = await operator("dev-verify.ts", "--ensure-board", "--approval-scenario");
  expect(first.code).toBe(0);
  expect(first.report.connectionCreated).toBe(true);
  const view = first.report.agentView!;
  expect(view.inferops).toMatchObject({ connected: true, mode: "mock", displayName: "InferOps (demo data)" });
  expect(view.board).toMatchObject({ readable: true, project: "DEMO", host: "demo.local", bindingName: "INFEROPS_BOARD", tsType: "InferOpsProjectSession" });
  expect(view.board.issues).toBeGreaterThan(0);
  expect(view.approvalQueue).toMatchObject({ reachable: true, pending: 1 });
  expect(view.approvalQueue.proposed).toMatch(/^Move DEMO-\d+ to /);

  const second = await operator("dev-verify.ts", "--ensure-board", "--approval-scenario");
  expect(second.code).toBe(0);
  expect(second.report.connectionCreated).toBe(false);
  expect(second.report.workspace).toEqual(first.report.workspace);
  expect(second.report.agentView!.board.connectionId).toBe(view.board.connectionId);
  expect(second.report.agentView!.approvalQueue).toEqual({ reachable: true, pending: 1 });

  // A plain verify (what `pnpm local verify` runs) now passes and still proposes nothing.
  const plain = await operator("dev-verify.ts");
  expect(plain.code).toBe(0);
  expect(plain.report.agentView!.approvalQueue).toEqual({ reachable: true, pending: 1 });
  expect(plain.report.agentView!.board.connectionId).toBe(view.board.connectionId);

  // The session token never appears in a lifecycle report, and the password is not echoed either.
  for (const run of [first, second, plain]) {
    expect(run.output).not.toContain("authToken");
    expect(run.output).not.toContain("verify-password");
  }
});

it("rejects a board URL that is not an InferOps project board as a usage error", async () => {
  const bad = await operator("dev-verify.ts", "--board", "https://example.com/board");
  expect(bad.code).toBe(2);
  expect(bad.output).toContain(DEMO_BOARD);
});

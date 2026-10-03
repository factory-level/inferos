// MOCKED end-to-end of local coding (#72): dispatch through the real InferOps gatekeeper in the real
// Workshop, approval, the local lifecycle starting the runner, the runner claiming the run, a patch
// with test evidence, and the result read back through the gatekeeper's `getRun`.
//
// What is real: the Workshop, the gatekeeper Worker and its approval flow, `pnpm local runner
// start|status|stop` and `pnpm local coding doctor` (scripts/local/lifecycle.ts, run as a process),
// git, and the test command the runner executes. What is MOCKED: InferOps and InferLab
// (src/inferops-fake.ts, served on loopback for the runner), the `inferops` binary
// (scripts/local/testdata/stub-inferops-cli.ts, a stand-in for `inferops runner codex --result
// patch`) and `codex` (scripts/local/testdata/stub-codex.ts, which writes one file and calls no
// model). Nothing here is evidence of a live run, a real Codex sign-in or the InferOps runner.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { InferOpsDispatchSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, PROJECTS, REPOS, WORKSPACES, type FakePerson,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const INFEROPS_GATEKEEPER_DIR = join(REPO_ROOT, "custom-gatekeepers/gatekeeper-inferops");
const LIFECYCLE = join(REPO_ROOT, "scripts/local/lifecycle.ts");
const STUB_CLI = join(REPO_ROOT, "scripts/local/testdata/stub-inferops-cli.ts");
const STUB_CODEX = join(REPO_ROOT, "scripts/local/testdata/stub-codex.ts");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const BASE_URL = "http://workshop.test/gatekeeper/inferops";
const ENG_DISPATCH = "inferops://acme.operations/project/dispatch/ENG";
const DONE = PROJECTS.ENG.states[2]!;

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;
let served: { url: string; close: () => Promise<void> };
let scratch: string;

beforeAll(async () => {
  network.install();
  served = await fake.serve();
  scratch = mkdtempSync(join(tmpdir(), "inferos-coding-e2e-"));
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars,
          INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
          INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL,
          CODING_WORKBENCH_ENABLED: "true",
          CODING_WORKBENCH_REPOS: REPOS.webApp.id,
        };
      },
    }],
  });
});

afterAll(async () => {
  try {
    if (scratch) await lifecycle(["runner", "stop", "--consumer-root", join(scratch, "wrapper")]);
    await harness?.server.close();
    await served?.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

/** The parent environment `pnpm local` runs in: provider keys a careless launcher would forward. */
const PARENT_ENV = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
  OPENAI_API_KEY: "sk-mocked-parent-openai", ANTHROPIC_API_KEY: "sk-ant-mocked-parent", CODEX_API_KEY: "codex-mocked-parent",
};

/**
 * Run `pnpm local …` as the operator would, and parse its `--json` report. Asynchronously: the fake
 * InferOps the runner talks to is served from this process, which must keep answering meanwhile.
 */
async function lifecycle(args: string[]): Promise<{ status: number; report: Record<string, unknown>; stdout: string }> {
  const child = spawn(process.execPath, [LIFECYCLE, ...args, "--json"], { cwd: REPO_ROOT, env: PARENT_ENV });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise<number>(settle => child.on("close", code => settle(code ?? 1)));
  let report: Record<string, unknown> = {};
  try {
    report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    report = { unparsed: stdout, stderr };
  }
  return { status, report, stdout: stdout + stderr };
}

/** A local git repository for web-app, and a wrapper allowlisting it for the runner. */
function makeWrapper(apiKey: string): { root: string; repo: string; codexHome: string } {
  const repo = join(scratch, "web-app");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "# web-app\n");
  writeFileSync(join(repo, "check.mjs"), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('STUB_CHANGE.md') ? 0 : 1);\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init");

  const codexHome = join(scratch, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "stub.json"), JSON.stringify({ auth: "chatgpt", turn: "edit" }));

  const root = join(scratch, "wrapper");
  mkdirSync(root);
  const capabilities = {
    INFEROPS_ENABLED: true, INFEROPS_CANVAS_STATE_MACHINE: false, HARNESS_HG_ENABLED: false, INFEROPS_AUTH: false,
    PUBLISH_CLOUDFLAREOS_WIDGET: false, PUBLISH_CLOUDFLAREOS_APP: false, AGENT_DEPLOYMENTS: false,
    CODING_WORKBENCH_ENABLED: true,
  };
  writeFileSync(join(root, "inferos.config.json"), JSON.stringify({
    schemaVersion: 2,
    upstream: { repository: "https://github.com/factory-level/inferos.git", revision: "0".repeat(40) },
    profile: "inferops-operations", features: {}, styling: {}, local: { port: 8787 },
    inferops: { mode: "fixture", fixture: "fixtures/project-board.json", targetRef: "inferops://demo.local/project/board/DEMO" },
    capabilities,
    codingWorkbench: { repos: [{ repoId: REPOS.webApp.id, path: repo, testCommands: ["node check.mjs"], baseRef: "main" }] },
  }, null, 2));
  writeFileSync(join(root, ".dev.vars"), [
    `INFEROPS_CLI=${STUB_CLI}`, `CODEX_PATH=${STUB_CODEX}`, `CODEX_HOME=${codexHome}`,
    `INFEROPS_ENDPOINT=${served.url}`, `INFEROPS_WORKSPACE_ID=${WORKSPACES.operations.id}`, `INFEROPS_API_KEY=${apiKey}`,
  ].join("\n") + "\n");
  return { root, repo, codexHome };
}

async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  const callback = fake.authorize(start.headers.get("location")!, person);
  const html = await (await harness.fetchWorker(GATEKEEPER_WORKER, callback)).text();
  const literal = /var ticket = (".*?");\n/.exec(html);
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

describe("MOCKED local coding end to end (stub runner, stub Codex, fake InferOps)", () => {
  it("dispatch → approve → runner claims → patch and test evidence → status through getRun", async () => {
    // A person with InferOps' dispatch permission connects and binds ENG's dispatch resource.
    const [username] = nextUsernames("coder");
    const api = await signUp(connect(harness.url), username!);
    const person = fake.addPerson(username!, ["operations"]);
    fake.grantDelegate(person);
    const { url, nonce } = await api.connectAccount("inferops");
    await api.completeConnectHandoff(await signInTicket(url, person), nonce);
    const account = await waitFor("the InferOps account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === "inferops") ?? null);
    const ws = await api.newGadget();
    const connection = await ws.newGatekeeper(account.id, ENG_DISPATCH);
    if (!connection) throw new Error("no dispatch connection");
    const session = await connection.openSession() as RpcStub<InferOpsDispatchSession>;

    // The runner's service key and wrapper; the doctor says it may start (on MOCK sign-in).
    const apiKey = fake.runnerKey("operations");
    const wrapper = makeWrapper(apiKey);
    const doctor = await lifecycle(["coding", "doctor", "--consumer-root", wrapper.root]);
    expect(doctor.status, doctor.stdout).toBe(0);
    expect(doctor.stdout).not.toContain(apiKey);

    // Dispatch is proposed, queued only on approval.
    const issue = fake.issuesOf("ENG").find(i => i.stateId !== DONE.id)!;
    const before = new Set((await ws.listActions({ filter: "pending" })).entries.map(a => a.id));
    await session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision);
    const action = (await ws.listActions({ filter: "pending" })).entries.find(a => !before.has(a.id))!;
    expect(fake.runsOf(issue.identifier)).toHaveLength(0);
    await ws.approveAction(action.id);
    const [queued] = fake.runsOf(issue.identifier);
    expect(queued).toMatchObject({ status: "queued", repoId: REPOS.webApp.id });

    // The lifecycle starts the runner; it claims the run with the service key, not the person's token.
    const started = await lifecycle(["runner", "start", "--consumer-root", wrapper.root]);
    expect(started.status, started.stdout).toBe(0);
    expect(started.stdout).not.toContain(apiKey);
    const finished = await waitFor("the run to finish", async () => {
      const run = fake.run(queued!.id);
      return run.status === "succeeded" || run.status === "failed" ? run : null;
    }, 30_000);
    expect(finished.status).toBe("succeeded");
    const runnerCalls = fake.requests.filter(r => r.token === apiKey).map(r => `${r.method} ${r.path.split("?")[0]}`);
    expect(runnerCalls).toEqual(expect.arrayContaining([
      `POST /project/runs/${queued!.id}/start`, `POST /project/runs/${queued!.id}/heartbeat`, `POST /project/runs/${queued!.id}/finish`,
    ]));
    expect(fake.run(queued!.id).externalRunId).toMatch(/^stub-thread-/);

    // No provider key reached the runner or the coding child.
    const runnerEnv: string[] = JSON.parse(readFileSync(join(wrapper.root, ".inferos/state/runner/runs/.stub-runner-env.json"), "utf8"));
    const codexEnv: string[] = JSON.parse(readFileSync(join(wrapper.codexHome, "stub-env.json"), "utf8"));
    for (const name of Object.keys(PARENT_ENV).filter(name => name.endsWith("_KEY"))) {
      expect(runnerEnv).not.toContain(name);
      expect(codexEnv).not.toContain(name);
    }
    expect(codexEnv).not.toContain("INFEROPS_API_KEY");

    // The result as the agent sees it, through the gatekeeper: a patch and test evidence.
    const run = await session.getRun(queued!.id);
    expect(run.status).toBe("succeeded");
    expect(run.result?.testSummary).toBe("1 of 1 test commands passed.");
    const patch = run.result!.patch!;
    expect(existsSync(patch.path)).toBe(true);
    expect(createHash("sha256").update(readFileSync(patch.path)).digest("hex")).toBe(patch.sha256);
    expect(patch).toMatchObject({ files: 1, insertions: 3, deletions: 0 });
    // The evidence is the executed command's own record, not model text.
    const record = JSON.parse(readFileSync(join(wrapper.root, ".inferos/state/runner/runs", queued!.id, ".inferops-artifacts/test-1.json"), "utf8"));
    expect(record).toMatchObject({ argv: ["node", "check.mjs"], exitCode: 0 });
    // The patch applies to the operator's repository, and nothing was committed there.
    execFileSync("git", ["-C", wrapper.repo, "apply", "--check", patch.path]);
    expect(execFileSync("git", ["-C", wrapper.repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe("1");

    // Status shows the run directory; stop ends the runner.
    const status = await lifecycle(["runner", "status", "--consumer-root", wrapper.root]);
    expect(status.status, status.stdout).toBe(0);
    const recent = status.report.recentRuns as { runId: string; tests: { passed: number; failed: number } }[];
    expect(recent[0]).toMatchObject({ runId: queued!.id, tests: { passed: 1, failed: 0 } });
    const stopped = await lifecycle(["runner", "stop", "--consumer-root", wrapper.root]);
    expect(stopped.report).toMatchObject({ ok: true, stopped: true });
  });

  it("a quota-blocked turn finishes failed with QUOTA_BLOCKED, pauses the runner, and start is refused until the pause file goes", async () => {
    const root = join(scratch, "wrapper");
    const codexHome = join(scratch, "codex-home");
    writeFileSync(join(codexHome, "stub.json"), JSON.stringify({ auth: "chatgpt", turn: "quota" }));
    const [username] = nextUsernames("coderq");
    const api = await signUp(connect(harness.url), username!);
    const person = fake.addPerson(username!, ["operations"]);
    fake.grantDelegate(person);
    const { url, nonce } = await api.connectAccount("inferops");
    await api.completeConnectHandoff(await signInTicket(url, person), nonce);
    const account = await waitFor("the InferOps account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === "inferops") ?? null);
    const ws = await api.newGadget();
    const session = await (await ws.newGatekeeper(account.id, ENG_DISPATCH))!.openSession() as RpcStub<InferOpsDispatchSession>;
    // The runner is already up and idle when the dispatch arrives.
    expect((await lifecycle(["runner", "start", "--consumer-root", root])).status).toBe(0);
    const issue = fake.issuesOf("ENG").find(i => i.stateId !== DONE.id && fake.runsOf(i.identifier).length === 0)!;
    const before = new Set((await ws.listActions({ filter: "pending" })).entries.map(a => a.id));
    await session.dispatch(issue.identifier, { repoId: REPOS.webApp.id }, issue.revision);
    await ws.approveAction((await ws.listActions({ filter: "pending" })).entries.find(a => !before.has(a.id))!.id);
    const [queued] = fake.runsOf(issue.identifier);

    const failed = await waitFor("the blocked run", async () => fake.run(queued!.id).status === "failed" ? fake.run(queued!.id) : null,
      30_000);
    expect(failed.error).toMatch(/^QUOTA_BLOCKED: /);
    const run = await session.getRun(queued!.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^QUOTA_BLOCKED/);

    // Paused: status says so, and a restart is refused rather than failing the next run.
    const status = await lifecycle(["runner", "status", "--consumer-root", root]);
    expect(status.status).toBe(1);
    expect(status.report.paused).toMatchObject({ reasonCode: "QUOTA_BLOCKED", runId: queued!.id });
    await lifecycle(["runner", "stop", "--consumer-root", root]);
    const restart = await lifecycle(["runner", "start", "--consumer-root", root]);
    expect(restart.status).toBe(1);
    expect(restart.report.refused).toBe(true);
  });
});

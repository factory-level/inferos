// Coding dispatch (#69, #70): a separate resource kind, bound and served only while
// CODING_WORKBENCH_ENABLED is on, dispatching only allowlisted repositories, every dispatch and
// cancel an approved action that InferOps (here the mock) rechecks at apply.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codingRepoAllowlist, codingWorkbenchEnabled } from "../src/coding-workbench";
import {
  parseProjectDispatchUrl, projectDispatchUrl, projectResourceKind,
} from "../src/resources";
import type { BindingProps } from "./worker";

const DEMO_APP = "40000000-0000-4000-8000-000000000001";
const LEGACY_APP = "40000000-0000-4000-8000-000000000002";
const UNLISTED = "40000000-0000-4000-8000-0000000000ff";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const WORKING = "20000000-0000-4000-8000-000000000002";
const DISPATCH_URL = "inferops://demo.local/project/dispatch/DEMO";
const BOARD_URL = "inferops://demo.local/project/board/DEMO";
const BOARD_PATTERN = "inferops://*/project/board/*";
const DISPATCH_PATTERN = "inferops://*/project/dispatch/*";
const WIKI_PATTERN = "inferops://*/knowledge/wiki";

// Deployment vars, flipped as a redeploy with changed vars would (one env object per isolate).
type Vars = { INFEROPS_ENABLED?: string; CODING_WORKBENCH_ENABLED?: string; CODING_WORKBENCH_REPOS?: string };
const vars = env as unknown as Vars;
function set(name: keyof Vars, value: string | undefined) {
  if (value === undefined) delete vars[name];
  else vars[name] = value;
}
beforeEach(() => {
  set("CODING_WORKBENCH_ENABLED", "true");
  set("CODING_WORKBENCH_REPOS", `${DEMO_APP},${LEGACY_APP}`);
});
afterEach(() => {
  set("INFEROPS_ENABLED", undefined);
  set("CODING_WORKBENCH_ENABLED", undefined);
  set("CODING_WORKBENCH_REPOS", undefined);
});

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** A fresh demo account's dispatch binding on DEMO (or `projectKey`). */
function setup(projectKey = "DEMO", accountId: string = crypto.randomUUID()) {
  const props: BindingProps = { accountId, host: "demo.local", projectKey };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
  return { props, hooks, mock, session: hooks.startDispatchSession(props) };
}

describe("the dispatch resource kind", () => {
  it("parses its own grammar, separately from the board's", () => {
    expect(parseProjectDispatchUrl("inferops://acme.operations/project/dispatch/ENG")).toEqual({
      host: "acme.operations", tenant: "acme", workspace: "operations", projectKey: "ENG",
    });
    expect(projectDispatchUrl({ host: "demo.local", projectKey: "DEMO" })).toBe(DISPATCH_URL);
    expect(projectResourceKind(DISPATCH_URL)).toBe("dispatch");
    expect(projectResourceKind(BOARD_URL)).toBe("board");
    expect(() => parseProjectDispatchUrl(BOARD_URL)).toThrow(/project\/dispatch\/<KEY>/);
    expect(() => parseProjectDispatchUrl("inferops://acme.ops:1/project/dispatch/ENG")).toThrow();
  });

  it("is offered only while coding dispatch is on", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.supportedPatterns(account))
      .toEqual([BOARD_PATTERN, DISPATCH_PATTERN, WIKI_PATTERN]);
    expect(await hooks.configuratorFor(account, DISPATCH_PATTERN)).toBeNull();

    set("CODING_WORKBENCH_ENABLED", undefined);
    expect(await hooks.supportedPatterns(account)).toEqual([BOARD_PATTERN, WIKI_PATTERN]);
    expect(await hooks.configuratorFor(account, DISPATCH_PATTERN)).toContain("Unsupported");
  });

  it("binds a dispatch URL to the dispatch gatekeeper and a board URL to the board's", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };

    expect(await hooks.bindAccount("dispatch", account, DISPATCH_URL)).toBeNull();
    expect(await hooks.bindAccount("board", account, BOARD_URL)).toBeNull();

    expect(await hooks.describeBound("dispatch")).toMatchObject({
      url: DISPATCH_URL, tsType: "InferOpsDispatchSession", suggestedBindingName: "INFEROPS_DISPATCH",
    });
    expect(await hooks.describeBound("board")).toMatchObject({ tsType: "InferOpsProjectSession" });
  });

  it("gives a board-only binding no way to dispatch", async () => {
    const { hooks } = setup();
    expect(await hooks.bindAccount("board-only", { accountId: crypto.randomUUID() }, BOARD_URL)).toBeNull();
    const board = hooks.startBoundSession("board-only") as unknown as {
      dispatch(key: string, target: object, revision: string): Promise<void>;
      listRuns(): Promise<unknown>;
    };

    expect(await failure(board.dispatch("DEMO-1", { repoId: DEMO_APP }, "1"))).not.toBe("");
    expect(await failure(board.listRuns())).not.toBe("");
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses another project, host or workspace like a missing project", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };

    expect(await hooks.bindAccount("x", account, "inferops://demo.local/project/dispatch/NOPE"))
      .toContain("No InferOps project NOPE is available on demo.local.");
    // A demo account holds no workspace: any other host is refused the same way.
    expect(await hooks.bindAccount("y", account, "inferops://acme.operations/project/dispatch/DEMO"))
      .toContain("No InferOps project DEMO is available on acme.operations.");
    expect(await hooks.bindAccount("z", account, "inferops://globex.local/project/dispatch/DEMO"))
      .toContain("No InferOps project DEMO is available on globex.local.");
  });
});

describe("dispatch", () => {
  it("lists repositories with their allowlist status, as an observation", async () => {
    set("CODING_WORKBENCH_REPOS", DEMO_APP);
    const { hooks, session } = setup();

    const repos = await session.listRepos();

    expect(repos.map(r => [r.slug, r.enabled, r.allowed])).toEqual([
      ["demo-app", true, true], ["legacy-app", false, false],
    ]);
    expect((await hooks.log()).observations).toEqual(["List InferOps repositories"]);
  });

  it("queues an approval, shows a provisional run, and dispatches only on approval", async () => {
    const { props, hooks, mock, session } = setup();

    await session.dispatch("DEMO-1", { repoId: DEMO_APP, baseRef: "feature/x" }, "1");

    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({
      title: "Dispatch DEMO-1 to demo-app", kind: "inferops.code-dispatch", implementsRevert: false,
    });
    expect(action!.fields).toMatchObject({
      Issue: "DEMO-1", Repository: "demo-app", "Base ref": "feature/x", "Expected revision": "1",
    });
    expect(await mock.listRuns("DEMO")).toEqual([]);
    const provisional = await session.listRuns();
    expect(provisional).toEqual([expect.objectContaining({
      id: `pending-${action!.id}`, issueIdentifier: "DEMO-1", status: "queued", pending: "dispatch",
      baseRef: "feature/x", repoId: DEMO_APP,
    })]);
    expect(await failure(session.getRun(provisional[0]!.id))).toContain("NOT_FOUND");

    expect(await hooks.applyDispatch(props, action!.id)).toBeNull();

    const [run] = await mock.listRuns("DEMO");
    expect(run).toMatchObject({ issueId: DEMO_1, repoId: DEMO_APP, status: "queued", baseRef: "feature/x" });
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ revision: "2" });
    expect(await session.listRuns()).toEqual([expect.objectContaining({ id: run!.id, status: "queued" })]);
    expect((await session.getRun(run!.id)).pending).toBeUndefined();
    expect(await hooks.getDispatchRaw(props, `action:${action!.id}`))
      .toMatchObject({ status: "applied", runId: run!.id });
  });

  it("refuses a repository outside the allowlist before reading anything", async () => {
    const { hooks, mock, session } = setup();

    const refused = await failure(session.dispatch("DEMO-1", { repoId: UNLISTED }, "1"));

    expect(refused).toContain(`FORBIDDEN: Repository ${UNLISTED} is not on this deployment's coding allowlist.`);
    expect((await hooks.log()).actions).toEqual([]);
    expect(await mock.listRuns("DEMO")).toEqual([]);
  });

  it("refuses with no allowlist at all", async () => {
    set("CODING_WORKBENCH_REPOS", undefined);
    const { session } = setup();

    expect(await failure(session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1"))).toContain("FORBIDDEN");
  });

  it.each([
    ["an issue of another project", "ENG-41", DEMO_APP, "1", "NOT_FOUND: No such issue in this project."],
    ["a content issue", "DEMO-9", DEMO_APP, "2", "WORKFLOW_MISMATCH"],
    ["a done issue", "DEMO-7", DEMO_APP, "6", "CONFLICT"],
    ["a cancelled issue", "DEMO-6", DEMO_APP, "4", "CONFLICT"],
    ["a stale revision", "DEMO-1", DEMO_APP, "0", "STALE_REVISION"],
    ["a disabled repository", "DEMO-1", LEGACY_APP, "1", "INVALID_REQUEST"],
    ["a malformed key", "demo-1", DEMO_APP, "1", "INVALID_REQUEST"],
    ["a malformed revision", "DEMO-1", DEMO_APP, "r1", "INVALID_REQUEST"],
    ["a malformed repository id", "DEMO-1", "demo-app", "1", "INVALID_REQUEST"],
  ])("refuses %s without proposing anything", async (_name, key, repoId, revision, code) => {
    const { hooks, session } = setup();

    expect(await failure(session.dispatch(key, { repoId }, revision))).toContain(code);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses a base ref that is not a ref name", async () => {
    const { session } = setup();

    for (const baseRef of ["--upload-pack=x", "a..b", "a b", "refs/heads/x.lock"]) {
      expect(await failure(session.dispatch("DEMO-1", { repoId: DEMO_APP, baseRef }, "1")))
        .toContain("INVALID_REQUEST");
    }
  });

  it("refuses a second dispatch while one is pending, and while the run is active", async () => {
    const { props, hooks, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");

    expect(await failure(session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1"))).toContain("RUN_ACTIVE");

    const [action] = (await hooks.log()).actions;
    expect(await hooks.applyDispatch(props, action!.id)).toBeNull();
    expect(await failure(session.dispatch("DEMO-1", { repoId: DEMO_APP }, "2"))).toContain("RUN_ACTIVE");
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("applies a dispatch once however often it is approved", async () => {
    const { props, hooks, mock, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;

    expect(await hooks.applyDispatch(props, action!.id)).toBeNull();
    expect(await hooks.applyDispatch(props, action!.id)).toBeNull();

    expect(await mock.listRuns("DEMO")).toHaveLength(1);
  });

  it("replays a lost response under its key, and refuses the key with another payload", async () => {
    const { mock } = setup();
    const request = { repoId: DEMO_APP, expectedRevision: "1" };

    const first = await mock.dispatchIssue("DEMO", DEMO_1, request, "k:1");
    expect(await mock.dispatchIssue("DEMO", DEMO_1, request, "k:1")).toEqual(first);

    expect(await failure(mock.dispatchIssue("DEMO", DEMO_1, { ...request, baseRef: "other" }, "k:1")))
      .toContain("IDEMPOTENCY_CONFLICT");
    expect(await mock.listRuns("DEMO")).toHaveLength(1);
  });

  it("refuses to send a stored dispatch that no longer matches what was approved", async () => {
    const { props, hooks, mock, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;
    const key = `action:${action!.id}`;
    const stored = await hooks.getDispatchRaw(props, key) as Record<string, unknown>;
    await hooks.putDispatchRaw(props, key, { ...stored, repoId: LEGACY_APP });

    expect(await hooks.applyDispatch(props, action!.id)).toContain("no longer matches the one proposed");
    expect(await mock.listRuns("DEMO")).toEqual([]);
  });

  it("refuses at apply when the issue changed after the dispatch was proposed", async () => {
    const { props, hooks, mock, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;
    await mock.transition("DEMO", DEMO_1, WORKING, "1", "elsewhere:1");

    const refused = await hooks.applyDispatch(props, action!.id);

    expect(refused).toContain("the issue changed in InferOps after this dispatch was proposed");
    expect(await mock.listRuns("DEMO")).toEqual([]);
    expect(await hooks.getDispatchRaw(props, `action:${action!.id}`)).toMatchObject({ status: "pending" });
  });

  it("refuses at apply a repository taken off the allowlist since the proposal", async () => {
    const { props, hooks, mock, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;
    set("CODING_WORKBENCH_REPOS", LEGACY_APP);

    expect(await hooks.applyDispatch(props, action!.id))
      .toContain("the repository is no longer on this deployment's coding allowlist");
    expect(await mock.listRuns("DEMO")).toEqual([]);
  });

  it("rejecting a dispatch ends its provisional run; it cannot be reverted", async () => {
    const { props, hooks, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;

    await hooks.rejectDispatch(props, action!.id);

    expect(await session.listRuns()).toEqual([]);
    expect(await hooks.revertDispatch(props, action!.id)).toContain("Dispatch the issue again");
  });
});

describe("runs", () => {
  async function dispatched() {
    const context = setup();
    await context.session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await context.hooks.log()).actions;
    expect(await context.hooks.applyDispatch(context.props, action!.id)).toBeNull();
    const [run] = await context.mock.listRuns("DEMO");
    return { ...context, run: run! };
  }

  it("reads a run and its result as observations", async () => {
    const { hooks, mock, session, run } = await dispatched();
    const patch = { path: "/work/run/result.patch", sha256: "ab".repeat(32), files: 2, insertions: 10, deletions: 3 };
    await mock.setRunStatus(run.id, "succeeded", { summary: "Done", testSummary: "12 passed", patch });

    expect(await session.getRun(run.id)).toMatchObject({
      status: "succeeded", issueIdentifier: "DEMO-1", result: { summary: "Done", testSummary: "12 passed", patch },
    });
    expect((await hooks.log()).observations).toEqual(["Read InferOps coding run of DEMO-1"]);
  });

  it("refuses a run of another project exactly as an unknown one", async () => {
    const accountId = crypto.randomUUID();
    const eng = setup("ENG", accountId);
    await eng.session.dispatch("ENG-41", { repoId: DEMO_APP }, "1");
    const [action] = (await eng.hooks.log()).actions;
    expect(await eng.hooks.applyDispatch(eng.props, action!.id)).toBeNull();
    const [engRun] = await eng.mock.listRuns("ENG");
    const demo = setup("DEMO", accountId);

    const otherProject = await failure(demo.session.getRun(engRun!.id));
    const unknown = await failure(demo.session.getRun(crypto.randomUUID()));

    expect(otherProject).toContain("NOT_FOUND: No such run in this project.");
    expect(unknown.replace(/^.*NOT_FOUND/, "")).toBe(otherProject.replace(/^.*NOT_FOUND/, ""));
    expect(await demo.session.listRuns()).toEqual([]);
    expect(await failure(demo.session.cancel(engRun!.id))).toContain("NOT_FOUND");
  });

  it("cancels a run only on approval, and marks it pending until then", async () => {
    const { props, hooks, mock, session, run } = await dispatched();

    await session.cancel(run.id);
    await session.cancel(run.id);

    const cancels = (await hooks.log()).actions.filter(a => a.kind === "inferops.run-cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.title).toBe("Cancel the queued run of DEMO-1");
    expect(await session.getRun(run.id)).toMatchObject({ status: "queued", pending: "cancel" });

    expect(await hooks.applyDispatch(props, cancels[0]!.id)).toBeNull();
    expect(await mock.readRun("DEMO", run.id)).toMatchObject({ status: "cancelled" });
    // Approved again: it is already applied, so nothing more is sent.
    expect(await hooks.applyDispatch(props, cancels[0]!.id)).toBeNull();
    expect(await failure(session.cancel(run.id))).toContain("CONFLICT");
  });

  it("ends a running run unknown, and accepts a retried cancel once it has stopped", async () => {
    const { props, hooks, mock, session, run } = await dispatched();
    await mock.setRunStatus(run.id, "running");
    await session.cancel(run.id);
    const cancel = (await hooks.log()).actions.at(-1)!;
    // Someone else stopped it before approval.
    await mock.cancelRun("DEMO", run.id, "elsewhere:cancel");

    expect(await hooks.applyDispatch(props, cancel.id)).toBeNull();
    expect(await mock.readRun("DEMO", run.id)).toMatchObject({ status: "unknown" });
  });
});

describe("CODING_WORKBENCH_ENABLED", () => {
  it("is off unless exactly \"true\", and only while InferOps is on", () => {
    expect(codingWorkbenchEnabled({})).toBe(false);
    expect(codingWorkbenchEnabled({ CODING_WORKBENCH_ENABLED: "true" })).toBe(true);
    expect(codingWorkbenchEnabled({ CODING_WORKBENCH_ENABLED: "TRUE" })).toBe(false);
    expect(codingWorkbenchEnabled({ CODING_WORKBENCH_ENABLED: "true", INFEROPS_ENABLED: "false" })).toBe(false);
  });

  it("reads the allowlist as lowercased UUIDs, ignoring anything else", () => {
    expect([...codingRepoAllowlist({ CODING_WORKBENCH_REPOS: ` ${DEMO_APP.toUpperCase()} ,nope,,` })])
      .toEqual([DEMO_APP]);
    expect(codingRepoAllowlist({}).size).toBe(0);
  });

  it("refuses a new dispatch binding while off, and while InferOps is off", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };

    set("CODING_WORKBENCH_ENABLED", "false");
    expect(await hooks.bindAccount("a", account, DISPATCH_URL))
      .toContain("DISABLED: Coding dispatch is turned off for this deployment.");
    // A board binding is unaffected by the coding switch.
    expect(await hooks.bindAccount("b", account, BOARD_URL)).toBeNull();

    set("CODING_WORKBENCH_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await hooks.bindAccount("c", account, DISPATCH_URL))
      .toContain("DISABLED: InferOps is turned off for this deployment.");
  });

  it("refuses every call of an existing session while off, and serves it again once on", async () => {
    const { hooks } = setup();
    expect(await hooks.bindAccount("kept", { accountId: crypto.randomUUID() }, DISPATCH_URL)).toBeNull();
    const session = hooks.startBoundDispatchSession("kept");
    expect(await session.listRuns()).toEqual([]);

    set("CODING_WORKBENCH_ENABLED", undefined);
    for (const call of [
      session.listRepos(), session.listRuns(), session.getRun(crypto.randomUUID()),
      session.cancel(crypto.randomUUID()), session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1"),
      // A session a stale client opens on the existing binding while off.
      hooks.startBoundDispatchSession("kept").listRuns(),
    ]) {
      expect(await failure(call)).toContain("DISABLED: Coding dispatch is turned off for this deployment.");
    }
    expect((await hooks.log()).actions).toEqual([]);

    set("CODING_WORKBENCH_ENABLED", "true");
    expect(await session.listRuns()).toEqual([]);
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("never applies a queued dispatch while off, and applies it once on again", async () => {
    const { props, hooks, mock, session } = setup();
    await session.dispatch("DEMO-1", { repoId: DEMO_APP }, "1");
    const [action] = (await hooks.log()).actions;

    set("CODING_WORKBENCH_ENABLED", "false");
    expect(await hooks.applyDispatch(props, action!.id)).toContain("coding dispatch is turned off");
    set("CODING_WORKBENCH_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await hooks.applyDispatch(props, action!.id)).toContain("coding dispatch is turned off");
    expect(await mock.listRuns("DEMO")).toEqual([]);

    set("INFEROPS_ENABLED", undefined);
    expect(await hooks.applyDispatch(props, action!.id)).toBeNull();
    expect(await mock.listRuns("DEMO")).toHaveLength(1);
  });
});

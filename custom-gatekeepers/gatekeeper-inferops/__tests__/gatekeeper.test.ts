// The gatekeeper's contract, driven the way the overseer drives it: a facet with baked-in props, a
// recording approval queue, and approve/reject decisions made after the session submitted them.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BindingProps } from "./worker";

const STATE = {
  backlog: "20000000-0000-4000-8000-000000000004",
  ideas: "20000000-0000-4000-8000-000000000007",
  ready: "20000000-0000-4000-8000-000000000001",
  working: "20000000-0000-4000-8000-000000000002",
  review: "20000000-0000-4000-8000-000000000005",
  drafting: "20000000-0000-4000-8000-000000000008",
  done: "20000000-0000-4000-8000-000000000003",
  published: "20000000-0000-4000-8000-000000000009",
  cancelled: "20000000-0000-4000-8000-000000000006",
  engTodo: "20000000-0000-4000-8000-000000000012",
};
const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const ENG_41 = "30000000-0000-4000-8000-000000000021";

/** A fresh account (so a fresh copy of the demo data) bound to the DEMO board. */
function setup(projectKey = "DEMO") {
  const props: BindingProps = { accountId: crypto.randomUUID(), host: "demo.local", projectKey };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
  return { props, hooks, mock, session: hooks.startSession(props) };
}

/**
 * The message an RPC call failed with, or "" when it succeeded. Awaited here rather than through
 * `expect(...).rejects`, which leaves the RPC promise's own rejection unhandled.
 */
async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

async function stateOf(board: { columns: Array<{ state: { id: string }; issues: Array<{ id: string; revision: string }> }> }, issueId: string) {
  for (const column of board.columns) {
    const issue = column.issues.find(i => i.id === issueId);
    if (issue) return { stateId: column.state.id, revision: issue.revision };
  }
  return null;
}

describe("board reads", () => {
  it("returns only the bound project, ordered by group then position, as an observation", async () => {
    const { hooks, session } = setup();

    const board = await session.readBoard();

    expect(board.project.identifier).toBe("DEMO");
    expect(board.columns.map(c => c.state.id)).toEqual([
      STATE.backlog, STATE.ideas, STATE.ready, STATE.working, STATE.review, STATE.drafting,
      STATE.done, STATE.published, STATE.cancelled,
    ]);
    const identifiers = board.columns.flatMap(c => c.issues.map(i => i.identifier));
    expect(identifiers).toHaveLength(11);
    expect(identifiers.every(id => id.startsWith("DEMO-"))).toBe(true);
    for (const column of board.columns) {
      for (const issue of column.issues) expect(issue.stateId).toBe(column.state.id);
    }
    expect((await hooks.log()).observations).toEqual(["Read InferOps board DEMO"]);
  });

  it("reads one issue as an observation", async () => {
    const { hooks, session } = setup();

    const issue = await session.openIssue(DEMO_1).read();

    expect(issue).toMatchObject({ identifier: "DEMO-1", stateId: STATE.ready, revision: "1" });
    expect((await hooks.log()).observations).toEqual(["Read InferOps issue DEMO-1"]);
  });
});

describe("scope", () => {
  it("refuses an issue of another project exactly as it refuses an unknown one", async () => {
    const { session } = setup();

    const otherProject = await failure(session.openIssue(ENG_41));
    const unknown = await failure(session.openIssue(crypto.randomUUID()));

    expect(otherProject).toContain("NOT_FOUND: No such issue in this project.");
    expect(unknown.replace(/^.*NOT_FOUND/, "")).toBe(otherProject.replace(/^.*NOT_FOUND/, ""));
  });

  it("reads another project only through a binding for that project", async () => {
    const { session } = setup("ENG");

    const board = await session.readBoard();

    expect(board.project.identifier).toBe("ENG");
    expect(board.columns.flatMap(c => c.issues).some(i => i.id === ENG_41)).toBe(true);
  });

  it("rejects a target state from another project", async () => {
    const { hooks, session } = setup();

    expect(await failure(session.openIssue(DEMO_1).transition(STATE.engTodo, "1"))).toMatch(/INVALID_STATE/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("rejects a state of the other workflow", async () => {
    const { hooks, session } = setup();

    expect(await failure(session.openIssue(DEMO_1).transition(STATE.drafting, "1"))).toMatch(/WORKFLOW_MISMATCH/);
    expect((await hooks.log()).actions).toEqual([]);
  });
});

describe("transitions", () => {
  it("shows a submitted move before it is applied, and writes it only on approval", async () => {
    const { props, hooks, mock, session } = setup();

    await session.openIssue(DEMO_1).transition(STATE.working, "1");

    const { actions } = await hooks.log();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toBe("Move DEMO-1 to Working");
    // Simulated: in its target column, at its unchanged revision (a move's result is not guessed).
    expect(await stateOf(await session.readBoard(), DEMO_1))
      .toEqual({ stateId: STATE.working, revision: "1" });
    expect(await session.openIssue(DEMO_1).read()).toMatchObject({ stateId: STATE.working });
    // ...but nothing has reached InferOps yet.
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.ready, revision: "1" });

    expect(await hooks.apply(props, actions[0]!.id)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.working, revision: "2" });
    expect(await stateOf(await session.readBoard(), DEMO_1))
      .toEqual({ stateId: STATE.working, revision: "2" });
  });

  it("refuses a second move of an issue until the first is decided", async () => {
    const { props, hooks, mock, session } = setup();
    const issue = session.openIssue(DEMO_1);

    await issue.transition(STATE.working, "1");
    const simulated = await issue.read();
    expect(simulated).toMatchObject({ stateId: STATE.working, revision: "1" });
    expect(await failure(issue.transition(STATE.review, simulated.revision))).toMatch(/CONFLICT/);
    // Proposing the pending move again is a no-op, not a conflict.
    await issue.transition(STATE.working, simulated.revision);
    expect((await hooks.log()).actions.map(a => a.title)).toEqual(["Move DEMO-1 to Working"]);

    // Once applied, the next move uses the revision InferOps actually reports.
    expect(await hooks.apply(props, 1)).toBeNull();
    const applied = await issue.read();
    await issue.transition(STATE.review, applied.revision);
    expect(await hooks.apply(props, 2)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.review });
  });

  it("allows a new move once a stale pending one no longer applies", async () => {
    const { hooks, mock, session } = setup();
    const issue = session.openIssue(DEMO_1);
    await issue.transition(STATE.working, "1");
    await mock.transition("DEMO", DEMO_1, STATE.done, "1", "someone-else");

    const current = await issue.read();
    await issue.transition(STATE.review, current.revision);

    expect((await hooks.log()).actions).toHaveLength(2);
  });

  it("refuses a stale revision when proposing", async () => {
    const { hooks, session } = setup();

    expect(await failure(session.openIssue(DEMO_1).transition(STATE.working, "7"))).toMatch(/STALE_REVISION/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses to apply a move whose issue changed after it was proposed", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(STATE.working, "1");
    // Someone else moves the issue in InferOps first.
    await mock.transition("DEMO", DEMO_1, STATE.done, "1", "someone-else");

    const applyError = await hooks.apply(props, (await hooks.log()).actions[0]!.id);

    expect(applyError).toContain("changed in InferOps after this move was proposed");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.done, revision: "2" });
    // The stale move no longer matches, so it is not simulated over the newer state.
    expect(await stateOf(await session.readBoard(), DEMO_1))
      .toEqual({ stateId: STATE.done, revision: "2" });
  });

  it("applies a move once even when approval is delivered twice", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(STATE.working, "1");
    const actionId = (await hooks.log()).actions[0]!.id;

    expect(await hooks.apply(props, actionId)).toBeNull();
    expect(await hooks.apply(props, actionId)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.working, revision: "2" });
  });

  it("clears the simulation when a move is rejected", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(STATE.working, "1");
    const actionId = (await hooks.log()).actions[0]!.id;

    await hooks.reject(props, actionId);

    expect(await stateOf(await session.readBoard(), DEMO_1))
      .toEqual({ stateId: STATE.ready, revision: "1" });
    expect(await hooks.apply(props, actionId)).toContain("Unknown InferOps action");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.ready, revision: "1" });
  });

  it("reverts an applied move unless the issue moved again", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).transition(STATE.working, "1");
    const actionId = (await hooks.log()).actions[0]!.id;
    await hooks.apply(props, actionId);

    expect(await hooks.revert(props, actionId)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.ready, revision: "3" });
  });
});

describe("mock data source", () => {
  it("replays an idempotency key and refuses its reuse for another change", async () => {
    const { mock } = setup();

    const first = await mock.transition("DEMO", DEMO_1, STATE.working, "1", "key-1");
    const replay = await mock.transition("DEMO", DEMO_1, STATE.working, "1", "key-1");

    expect(replay).toEqual(first);
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ revision: "2" });
    expect(await failure(mock.transition("DEMO", DEMO_1, STATE.done, "2", "key-1"))).toMatch(/IDEMPOTENCY_CONFLICT/);
  });
});

describe("observers", () => {
  it("admits a collaborator who can open the project and refuses one who cannot", async () => {
    const { props, hooks } = setup();

    expect(await hooks.addObserver(props, true)).toBeNull();
    expect(await hooks.addObserver(props, false)).toContain("cannot open InferOps project DEMO");
  });
});

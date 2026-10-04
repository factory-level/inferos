// The gatekeeper's contract, driven the way the overseer drives it: a facet with baked-in props, a
// recording approval queue, and approve/reject decisions made after the session submitted them.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Board } from "../src/types";
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

/** Every card of a board with the id of the column it sits in. */
function cards(board: Board) {
  return board.columns.flatMap(c => c.issues.map(i => ({ ...i, column: c.state.id })));
}

describe("creating issues", () => {
  it("queues a create for approval, shows a provisional card, and creates only on approval", async () => {
    const { props, hooks, mock, session } = setup();

    await session.createIssue({ title: "  Write the runbook  ", priority: "high" });

    const { actions } = await hooks.log();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: "Create issue: Write the runbook", implementsRevert: false,
      fields: { Project: "DEMO", Title: "Write the runbook", State: "Backlog", Priority: "high" },
    });
    // Simulated: a provisional card in the default (first software) column.
    const provisional = cards(await session.readBoard()).filter(c => c.pending === "create");
    expect(provisional).toEqual([expect.objectContaining({
      id: "pending-1", identifier: "DEMO-new", title: "Write the runbook", priority: "high",
      column: STATE.backlog, stateId: STATE.backlog, workflow: "software", revision: "0",
    })]);
    expect(await failure(session.openIssue("pending-1"))).toContain("NOT_FOUND");
    // ...but nothing exists in InferOps yet.
    expect((await mock.readProject("DEMO")).issues).toHaveLength(11);

    expect(await hooks.apply(props, actions[0]!.id)).toBeNull();

    const created = (await mock.readProject("DEMO")).issues.filter(i => i.title === "Write the runbook");
    expect(created).toEqual([expect.objectContaining({
      identifier: "DEMO-12", priority: "high", stateId: STATE.backlog, workflow: "software",
    })]);
    const after = cards(await session.readBoard());
    expect(after.some(c => c.pending)).toBe(false);
    expect(after.filter(c => c.title === "Write the runbook").map(c => c.id)).toEqual([created[0]!.id]);
  });

  it("creates in a named state, taking its workflow", async () => {
    const { props, hooks, mock, session } = setup();

    await session.createIssue({ title: "Launch post", stateId: STATE.drafting, description: "Body" });
    const action = (await hooks.log()).actions[0]!;
    expect(action.fields).toMatchObject({ State: "Drafting", Workflow: "content", Description: "Body" });
    expect(await hooks.apply(props, action.id)).toBeNull();

    expect((await mock.readProject("DEMO")).issues.find(i => i.title === "Launch post"))
      .toMatchObject({ stateId: STATE.drafting, workflow: "content" });
  });

  it("refuses a state outside the project, and empty or overlong fields, before proposing", async () => {
    const { hooks, session } = setup();

    expect(await failure(session.createIssue({ title: "x", stateId: STATE.engTodo }))).toMatch(/INVALID_STATE/);
    expect(await failure(session.createIssue({ title: "   " }))).toMatch(/INVALID_REQUEST/);
    expect(await failure(session.createIssue({ title: "x".repeat(501) }))).toMatch(/INVALID_REQUEST/);
    expect(await failure(session.createIssue({ title: "x", description: "d".repeat(20_001) })))
      .toMatch(/INVALID_REQUEST/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("leaves nothing behind when the create is denied", async () => {
    const { props, hooks, mock, session } = setup();
    await session.createIssue({ title: "Denied" });

    await hooks.reject(props, 1);

    expect(cards(await session.readBoard()).some(c => c.pending)).toBe(false);
    expect(await hooks.apply(props, 1)).toContain("Unknown InferOps action");
    expect((await mock.readProject("DEMO")).issues).toHaveLength(11);
  });

  it("creates one issue when approval is delivered twice", async () => {
    const { props, hooks, mock, session } = setup();
    await session.createIssue({ title: "Once" });

    expect(await hooks.apply(props, 1)).toBeNull();
    expect(await hooks.apply(props, 1)).toBeNull();

    expect((await mock.readProject("DEMO")).issues.filter(i => i.title === "Once")).toHaveLength(1);
  });

  it("queues one create for one intent: an identical proposal from another tab joins the pending one", async () => {
    const { props, hooks, mock, session } = setup();
    // Two tabs, two sessions on the one binding, both proposing the same new issue at once.
    const other = hooks.startSession(props);
    await Promise.all([
      session.createIssue({ title: "Same issue", priority: "high" }),
      other.createIssue({ title: " Same issue ", priority: "high" }),
    ]);
    // A different issue is its own proposal.
    await other.createIssue({ title: "Same issue", priority: "low" });

    const { actions } = await hooks.log();
    expect(actions.map(a => a.title)).toEqual(["Create issue: Same issue", "Create issue: Same issue"]);
    expect(cards(await session.readBoard()).filter(c => c.pending === "create").map(c => c.priority))
      .toEqual(["high", "low"]);

    expect(await hooks.apply(props, actions[0]!.id)).toBeNull();
    // Once applied, the same proposal is a new intent again.
    await session.createIssue({ title: "Same issue", priority: "high" });
    expect((await hooks.log()).actions).toHaveLength(3);
    expect((await mock.readProject("DEMO")).issues.filter(i => i.title === "Same issue")).toHaveLength(1);
  });

  it("is not revertible", async () => {
    const { props, hooks, session } = setup();
    await session.createIssue({ title: "Permanent" });
    await hooks.apply(props, 1);

    expect(await hooks.revert(props, 1)).toContain("cannot be undone here");
  });
});

describe("updating issues", () => {
  it("queues an update, overlays it on reads, and writes it only on approval", async () => {
    const { props, hooks, mock, session } = setup();
    const issue = session.openIssue(DEMO_1);

    await issue.update({ title: "Verify everything", priority: "urgent" }, "1");

    const { actions } = await hooks.log();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: "Update DEMO-1: title, priority", implementsRevert: true,
      fields: {
        Issue: "DEMO-1", "Current title": "Verify the local environment",
        "New title": "Verify everything", Priority: "medium → urgent", "Expected revision": "1",
      },
    });
    expect(await issue.read()).toMatchObject({
      title: "Verify everything", priority: "urgent", revision: "1", pending: "update",
    });
    expect(cards(await session.readBoard()).find(c => c.id === DEMO_1))
      .toMatchObject({ title: "Verify everything", pending: "update" });
    expect(await mock.readIssue("DEMO", DEMO_1))
      .toMatchObject({ title: "Verify the local environment", revision: "1" });

    expect(await hooks.apply(props, actions[0]!.id)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1))
      .toMatchObject({ title: "Verify everything", priority: "urgent", revision: "2" });
    const read = await issue.read();
    expect(read).toMatchObject({ title: "Verify everything", revision: "2" });
    expect(read.pending).toBeUndefined();
  });

  it("sends only changed fields, and a change of nothing proposes nothing", async () => {
    const { hooks, session } = setup();
    const issue = session.openIssue(DEMO_1);

    await issue.update({ title: "Verify the local environment", priority: "medium" }, "1");
    expect((await hooks.log()).actions).toEqual([]);

    await issue.update({ title: "Verify the local environment", priority: "low" }, "1");
    expect((await hooks.log()).actions.map(a => a.title)).toEqual(["Update DEMO-1: priority"]);
  });

  it("requires a decimal expected revision and refuses a stale one", async () => {
    const { hooks, session } = setup();
    const issue = session.openIssue(DEMO_1);

    expect(await failure(issue.update({ title: "x" }, "next"))).toMatch(/INVALID_REQUEST/);
    expect(await failure(issue.update({ title: "x" }, "7"))).toMatch(/STALE_REVISION/);
    expect(await failure(issue.update({ title: "" }, "1"))).toMatch(/INVALID_REQUEST/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses a second update or move of an issue until the first is decided", async () => {
    const { props, hooks, session } = setup();
    const issue = session.openIssue(DEMO_1);

    await issue.update({ priority: "urgent" }, "1");
    expect(await failure(issue.update({ priority: "low" }, "1"))).toMatch(/CONFLICT/);
    expect(await failure(issue.transition(STATE.working, "1"))).toMatch(/CONFLICT/);
    expect((await hooks.log()).actions).toHaveLength(1);

    // ...and an update waits for a pending move just the same.
    const other = setup();
    await other.session.openIssue(DEMO_1).transition(STATE.working, "1");
    expect(await failure(other.session.openIssue(DEMO_1).update({ priority: "low" }, "1")))
      .toMatch(/CONFLICT/);

    expect(await hooks.apply(props, 1)).toBeNull();
    await issue.update({ priority: "low" }, (await issue.read()).revision);
    expect((await hooks.log()).actions).toHaveLength(2);
  });

  it("refuses to apply an update whose issue changed after it was proposed", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Mine" }, "1");
    await mock.transition("DEMO", DEMO_1, STATE.done, "1", "someone-else");

    expect(await hooks.apply(props, 1)).toContain("changed in InferOps after this update was proposed");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ title: "Verify the local environment" });
  });

  it("leaves nothing behind when the update is denied", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Denied" }, "1");

    await hooks.reject(props, 1);

    expect(await session.openIssue(DEMO_1).read())
      .toMatchObject({ title: "Verify the local environment", revision: "1" });
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ revision: "1" });
  });

  it("applies an update once when approval is delivered twice", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Twice" }, "1");

    expect(await hooks.apply(props, 1)).toBeNull();
    expect(await hooks.apply(props, 1)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ title: "Twice", revision: "2" });
  });

  it("reverts a title and priority update while nothing else changed the issue", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Temporary", priority: "low" }, "1");
    await hooks.apply(props, 1);

    expect(await hooks.revert(props, 1)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1))
      .toMatchObject({ title: "Verify the local environment", priority: "medium", revision: "3" });
  });

  it("does not revert an update the issue has moved on from, or one that replaced the description", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Temporary" }, "1");
    await hooks.apply(props, 1);
    await mock.transition("DEMO", DEMO_1, STATE.done, "2", "someone-else");

    expect(await hooks.revert(props, 1)).toContain("has changed again since this update");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ title: "Temporary" });

    await session.openIssue(DEMO_1).update({ description: "New body" }, "3");
    const described = (await hooks.log()).actions[1]!;
    expect(described).toMatchObject({
      title: "Update DEMO-1: description", implementsRevert: false,
      fields: { "New description": "New body" },
    });
    await hooks.apply(props, described.id);
    expect(await hooks.revert(props, described.id)).toContain("cannot be restored here");
  });
});

describe("stored actions", () => {
  it("applies a record stored before creates and updates existed as the transition it is", async () => {
    const { props, hooks, mock } = setup();
    await hooks.putRaw(props, "action:5", {
      actionId: 5, issueId: DEMO_1, identifier: "DEMO-1", fromStateId: STATE.ready,
      toStateId: STATE.working, toStateName: "Working", expectedRevision: "1", status: "pending",
    });

    expect(await hooks.apply(props, 5)).toBeNull();

    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: STATE.working, revision: "2" });
  });

  it("refuses to send a request that no longer matches the fingerprint staged with it", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openIssue(DEMO_1).update({ title: "Approved title" }, "1");
    const record = await hooks.getRaw(props, "action:1") as { changes: { title: string } };
    record.changes.title = "Something else";
    await hooks.putRaw(props, "action:1", record);

    expect(await hooks.apply(props, 1)).toContain("no longer matches the one proposed");

    expect(await mock.readIssue("DEMO", DEMO_1))
      .toMatchObject({ title: "Verify the local environment", revision: "1" });
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

  it("replays a create under its key, and refuses the key for another create", async () => {
    const { mock } = setup();
    const request = { title: "Once", stateId: STATE.backlog };

    const first = await mock.createIssue("DEMO", request, "key-c");
    const replay = await mock.createIssue("DEMO", request, "key-c");

    expect(replay).toEqual(first);
    expect((await mock.readProject("DEMO")).issues.filter(i => i.title === "Once")).toHaveLength(1);
    expect(await failure(mock.createIssue("DEMO", { ...request, title: "Twice" }, "key-c")))
      .toMatch(/IDEMPOTENCY_CONFLICT/);
    expect(await failure(mock.createIssue("DEMO", { title: "x", stateId: STATE.drafting }, "key-d")))
      .toMatch(/WORKFLOW_MISMATCH/);
  });
});

describe("observers", () => {
  it("admits a collaborator who can open the project and refuses one who cannot", async () => {
    const { props, hooks } = setup();

    expect(await hooks.addObserver(props, true)).toBeNull();
    expect(await hooks.addObserver(props, false)).toContain("cannot open InferOps project DEMO");
  });
});

describe("board discovery", () => {
  it("finds a board by what its work is about, not only its title or key, and says why", async () => {
    const { hooks, session } = setup();

    // ENG's open work includes "Scope service tokens to one project"; its name is "Platform engineering".
    const byWork = await session.findBoards("where are we tracking service tokens?");
    expect(byWork.map(c => c.projectKey)).toContain("ENG");
    const eng = byWork.find(c => c.projectKey === "ENG")!;
    expect(eng).toMatchObject({
      tenant: "demo", workspace: "local", boardRef: "inferops://demo.local/project/board/ENG",
      title: "Platform engineering",
    });
    expect(eng.reasons.some(reason => /open issues? mentions?/.test(reason))).toBe(true);

    const byName = await session.findBoards("the platform team's kanban");
    expect(byName[0]).toMatchObject({ projectKey: "ENG" });
    expect(byName[0]!.reasons).toContain('Name "Platform engineering" matches "platform"');
    expect((await session.findBoards("eng"))[0]).toMatchObject({ projectKey: "ENG" });

    expect((await hooks.log()).observations).toEqual([
      "Searched InferOps boards on demo.local", "Searched InferOps boards on demo.local",
      "Searched InferOps boards on demo.local",
    ]);
  });

  it("returns every plausible board rather than picking one, and nothing for no match", async () => {
    const { session } = setup();
    // Both demo projects have open work about transitions.
    const plausible = await session.findBoards("transitions");
    expect(plausible.map(c => c.projectKey).toSorted()).toEqual(["DEMO", "ENG"]);
    expect(await session.findBoards("quarterly marketing budget")).toEqual([]);
    expect(await failure(session.findBoards("   "))).toMatch(/INVALID_REQUEST/);
    expect(await failure(session.findBoards("x".repeat(201)))).toMatch(/INVALID_REQUEST/);
  });

  it("fails, naming nothing, once the person's access is revoked", async () => {
    const { hooks, mock, session } = setup();
    expect((await session.findBoards("platform")).map(c => c.projectKey)).toEqual(["ENG"]);
    await mock.forget();
    expect(await failure(session.findBoards("platform"))).toMatch(/UNAUTHORIZED/);
    expect((await hooks.log()).observations).toHaveLength(1);
  });

  it("keeps results from the binding's observers, who were admitted for its project only", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addObserver(props, true)).toBeNull();
    await session.findBoards("platform");
    await hooks.removeObserver(props);
    await session.findBoards("platform");
    const log = await hooks.log();
    expect(log.excluded).toEqual([["observer-1"], []]);
  });
});

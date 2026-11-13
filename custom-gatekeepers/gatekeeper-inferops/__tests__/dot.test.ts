// The person's own Dot (FAC-133): the Dot facet's session, apply and reject, over the real HTTP
// client and relay, against a fake InferOps that streams a run exactly as `streamAguiEvents` does.
// A turn is an observation; every change the Dot proposes is staged once as an ordinary write, and
// approving it confirms it in InferOps keyed by the proposal id; the receipt speaks FAC-97's words
// and never InferOps' own. No model runs anywhere.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dotProposalStatus, summarizeDotOutcome } from "../src/dot";
import { CHATBOT_DOT_RESOURCE, dotUrl, parseDotUrl, resourceKind } from "../src/resources";
import type { DotProposalWire } from "../src/inferops-client";
import type { DotProgress } from "../src/types";
import { DOT_FRAMES, type DotScript } from "./worker";

const { sse, ping } = DOT_FRAMES;
const THREAD = "70000000-0000-4000-8000-000000000001";
const PROPOSAL = "72000000-0000-4000-8000-000000000001";
const RUN = "71000000-0000-4000-8000-000000000001";
const PAGE = "inferops://acme.operations/project/board/ENG";
const RECORD = "inferops://acme.operations/project/issue-card/ENG-7";

const started = sse({ type: "RUN_STARTED", threadId: THREAD, runId: RUN });
const finished = sse({ type: "RUN_FINISHED", threadId: THREAD, runId: RUN });
const text = (delta: string) => sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta });
const proposedResult = sse({
  type: "TOOL_CALL_RESULT", messageId: "r1", toolCallId: "t1",
  content: JSON.stringify({ proposed: true, proposalId: PROPOSAL, message: "Proposed, not done" }),
});

const proposal = (overrides: Partial<DotProposalWire> = {}): DotProposalWire => ({
  id: PROPOSAL, tool: "issue_create", input: { projectId: "p1", title: "Fix the gate" }, status: "proposed",
  outcome: null, run: null, createdAt: "2026-11-10T12:00:00.000Z", expiresAt: "2026-11-10T12:15:00.000Z", decidedAt: null,
  runStatus: null, ...overrides,
});

const script = (overrides: Partial<DotScript> = {}): DotScript => ({
  run: { frames: [started, text("Done."), finished] },
  proposals: [],
  confirm: { outcome: { issue: { id: "i7", identifier: "ENG-7", title: "Fix the gate", description: "secret body" } } },
  ...overrides,
});

/** A fresh hooks object (its own storage, queue log and fake InferOps) and a conversation in it. */
async function setup(dot: DotScript = script()) {
  const hooks = env.TEST_HOOKS.getByName(`dot-${crypto.randomUUID()}`);
  await hooks.dotScript(dot);
  const session = await hooks.startDotSession();
  const conversation = await session.startConversation();
  return { hooks, conversation };
}

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("the Dot resource kind", () => {
  it("parses its grammar, apart from the other kinds, and is never the operate chat's context", () => {
    expect(parseDotUrl("inferops://acme.operations/chatbot/dot")).toEqual({ host: "acme.operations", tenant: "acme", workspace: "operations" });
    expect(dotUrl({ host: "acme.operations" })).toBe("inferops://acme.operations/chatbot/dot");
    expect(resourceKind("inferops://acme.operations/chatbot/dot")).toBe("dot");
    for (const url of ["inferops://acme/chatbot/dot", "inferops://acme.operations/chatbot/dot/x", "inferops://acme.operations/chatbot"]) {
      expect(() => parseDotUrl(url), url).toThrow(/chatbot\/dot/);
    }
    expect(CHATBOT_DOT_RESOURCE.excludeFromOperateChat).toBe(true);
  });
});

describe("a Dot turn", () => {
  it("relays text in order, answers how it ended, and is logged as one observation", async () => {
    const { hooks, conversation } = await setup(script({ run: { frames: [started, text("Hel"), ping, text("lo."), finished] } }));
    const progress: DotProgress[] = [];
    const turn = await conversation.ask("What changed today?", { onProgress: event => { progress.push(event); } });
    expect(turn).toMatchObject({ status: "complete", reply: "Hello.", proposals: [] });
    expect(progress).toEqual([{ type: "text", delta: "Hel" }, { type: "text", delta: "lo." }]);
    const log = await hooks.log();
    expect(log.observations).toEqual(["Asked your Dot"]);
    expect(log.observationTexts).toEqual(["Asked your Dot: What changed today?"]);
  });

  it("sends the page and record as references, unchanged, and no other context", async () => {
    const { hooks, conversation } = await setup();
    await conversation.ask("What is on this board?", { page: PAGE, record: RECORD });
    const run = (await hooks.dotCalls()).find(c => c.path.endsWith("/runs"))!;
    expect(JSON.parse(run.body!)).toEqual({ runId: expect.any(String), prompt: "What is on this board?", context: [], selection: { page: PAGE, record: RECORD } });
  });

  it("stages each proposal once, as a write the person decides, with its receipt", async () => {
    const { hooks, conversation } = await setup(script({
      run: { frames: [started, sse({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "issue_create" }),
        sse({ type: "TOOL_CALL_END", toolCallId: "t1" }), proposedResult, text("Proposed it."), finished] },
      proposals: [proposal()],
    }));
    const progress: DotProgress[] = [];
    const turn = await conversation.ask("File it", { onProgress: event => { progress.push(event); } });
    expect(turn.status).toBe("complete");
    expect(turn.proposals.map(p => ({ id: p.id, tool: p.tool, status: p.status }))).toEqual([
      { id: PROPOSAL, tool: "issue_create", status: { outcome: "waiting" } },
    ]);
    expect(turn.proposals[0]!.receipt).not.toBeNull();
    expect(progress.map(p => p.type)).toEqual(["tool", "tool", "proposal", "text"]);
    const log = await hooks.log();
    expect(log.actions).toHaveLength(1);
    expect(log.actions[0]).toMatchObject({ kind: "inferops.dot-confirm", title: "Your Dot proposes: issue_create", implementsRevert: false });
    expect(log.actions[0]!.fields.Operation).toBe("issue_create");
    // Read again (as after a reconnect): the same proposal is not staged a second time.
    const read = await conversation.read();
    expect(read.proposals.map(p => p.id)).toEqual([PROPOSAL]);
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("says a knowledge write changes the page as the person, live, names its page, and never says it publishes (FAC-136)", async () => {
    const page = "inferops://acme.handbook/knowledge/page/00000000-0000-4000-8000-0000000000aa";
    const { hooks, conversation } = await setup(script({
      proposals: [proposal({ tool: "knowledge_page_edit", input: { page, expectedVersion: 3, body: "Refunds take 5 days." } })],
    }));
    await conversation.read();
    const [card] = (await hooks.log()).actions;
    expect(card).toMatchObject({ kind: "inferops.dot-confirm", title: "Your Dot proposes a change to a wiki page" });
    expect(card!.description).toContain("Your Dot will change this page as you, and readers see it right away.");
    expect(card!.description).not.toMatch(/publish/i);
    expect(card!.fields.Page).toBe(page);
    expect(card!.fields.Operation).toBe("knowledge_page_edit");
  });

  it("says a new page is created as the person, live, in the workspace it names, and never that it publishes (FAC-136)", async () => {
    const workspace = "inferops://acme.handbook/knowledge/page";
    const { hooks, conversation } = await setup(script({
      proposals: [proposal({ tool: "knowledge_page_create", input: { workspace, title: "Refunds", body: "Take 5 days." } })],
    }));
    await conversation.read();
    const [card] = (await hooks.log()).actions;
    expect(card).toMatchObject({ kind: "inferops.dot-confirm", title: "Your Dot proposes a new wiki page" });
    expect(card!.description).toContain("Your Dot will create this page as you, and readers see it right away.");
    expect(card!.description).toContain("checked again now in that workspace");
    expect(card!.description).not.toMatch(/change this page|that page's workspace|publish/i);
    expect(card!.fields["New page in"]).toBe(workspace);
  });

  it("stages on reading a proposal no relay saw, so a cut turn's change is still decided here", async () => {
    const { hooks, conversation } = await setup(script({ proposals: [proposal()] }));
    const read = await conversation.read();
    expect(read.proposals[0]!.receipt).not.toBeNull();
    expect((await hooks.log()).actions.map(a => a.kind)).toEqual(["inferops.dot-confirm"]);
  });

  it("ends with the run's own error as an error turn, shown as progress", async () => {
    const { conversation } = await setup(script({ run: { frames: [started, sse({ type: "RUN_ERROR", message: "Could not finish the response. You can retry." })] } }));
    const progress: DotProgress[] = [];
    const turn = await conversation.ask("Hi", { onProgress: event => { progress.push(event); } });
    expect(turn.status).toBe("error");
    expect(progress).toEqual([{ type: "error", message: "Could not finish the response. You can retry." }]);
  });

  it("reads a malformed event as a visible error, never silence, and stops the run", async () => {
    const { hooks, conversation } = await setup(script({ run: { frames: [started, text("Half"), sse({ type: "NOT_AN_EVENT" }), finished] } }));
    const progress: DotProgress[] = [];
    const turn = await conversation.ask("Hi", { onProgress: event => { progress.push(event); } });
    expect(turn).toMatchObject({ status: "error", reply: "Half" });
    expect(progress.at(-1)).toEqual({ type: "error", message: "The Dot's reply couldn't be read. Ask again." });
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/cancel"))).toBe(true);
  });

  it("reads a stream cut mid-run as interrupted, keeping what was said", async () => {
    const { conversation } = await setup(script({ run: { frames: [started, text("Half an")] } }));
    expect(await conversation.ask("Hi")).toMatchObject({ status: "interrupted", reply: "Half an" });
  });

  it("refuses before any stream in fixed words, never InferOps' own", async () => {
    const cases: [number, string, string][] = [
      [404, "RESOURCE_UNAVAILABLE", "NOT_FOUND: The page or record isn't one you can open."],
      [403, "FORBIDDEN", "FORBIDDEN: Your InferOps access doesn't allow this here."],
      [409, "CONFLICT", "CONFLICT: Another turn of this conversation is still running."],
      [503, "ASSISTANT_UNAVAILABLE", "UNAVAILABLE: Your Dot can't run now. Try again later."],
      [401, "UNAUTHORIZED", "UNAUTHORIZED"],
    ];
    for (const [status, code, expected] of cases) {
      const { hooks, conversation } = await setup(script({ run: { status, code } }));
      const refused = await failure(conversation.ask("Hi", { page: PAGE }));
      expect(refused, code).toContain(expected);
      expect(refused, code).not.toContain("InferOps detail");
      expect((await hooks.log()).actions, code).toEqual([]);
    }
  });

  it("refuses a prompt or reference InferOps wouldn't take, before asking", async () => {
    const { hooks, conversation } = await setup();
    expect(await failure(conversation.ask("  "))).toContain("INVALID_REQUEST");
    expect(await failure(conversation.ask("Hi", { page: "https://elsewhere" }))).toContain("INVALID_REQUEST");
    expect(await failure(conversation.ask("x".repeat(16_001)))).toContain("INVALID_REQUEST");
    expect((await hooks.dotCalls()).filter(c => c.path.endsWith("/runs"))).toEqual([]);
  });

  it("cancels the turn the conversation has running", async () => {
    const { hooks, conversation } = await setup();
    await conversation.cancel();
    // The fake's conversation has no running turn: nothing to stop.
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/cancel"))).toBe(false);
  });
});

/** A conversation whose one proposal was staged by reading it, and that action's id. */
async function staged(dot: DotScript) {
  const ctx = await setup(dot);
  await ctx.conversation.read();
  const [action] = (await ctx.hooks.log()).actions;
  return { ...ctx, actionId: action!.id };
}

describe("deciding a proposal", () => {
  it("confirms it in InferOps keyed by the proposal id, and reports a bounded result", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [proposal()] }));
    const applied = await hooks.applyDot(actionId);
    expect(applied.failure).toBeNull();
    expect(applied.result).toEqual({
      kind: "dot-confirm", proposalId: PROPOSAL, "issue.id": "i7", "issue.identifier": "ENG-7", "issue.title": "Fix the gate",
    });
    const confirm = (await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"))!;
    expect(confirm.key).toBe(PROPOSAL);
    // An issue proposal names no run.
    expect(JSON.parse(confirm.body ?? "null")).toEqual({});
    // Applied once: approving again sends nothing more.
    await hooks.applyDot(actionId);
    expect((await hooks.dotCalls()).filter(c => c.path.endsWith("/confirm"))).toHaveLength(1);
  });

  it("fails an expired proposal EXPIRED, not applied", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [proposal()], confirm: { status: 409, code: "PROPOSAL_EXPIRED" } }));
    const { failure: refused } = await hooks.applyDot(actionId);
    expect(refused).toMatchObject({ outcome: "notApplied", code: "EXPIRED" });
    expect(refused!.message).toContain("expired before it was decided");
  });

  it("settles one InferOps says was decided to what it is, never assuming success", async () => {
    const done = await staged(script({ proposals: [proposal()], confirm: { status: 409, code: "PROPOSAL_DECIDED", settlesAs: "confirmed" } }));
    expect((await done.hooks.applyDot(done.actionId)).failure).toBeNull();
    const declined = await staged(script({ proposals: [proposal()], confirm: { status: 409, code: "PROPOSAL_DECIDED", settlesAs: "declined" } }));
    expect((await declined.hooks.applyDot(declined.actionId)).failure).toMatchObject({ outcome: "notApplied", code: "CONFLICT" });
    const running = await staged(script({ proposals: [proposal()], confirm: { status: 409, code: "PROPOSAL_DECIDED", settlesAs: "confirming" } }));
    expect((await running.hooks.applyDot(running.actionId)).failure?.outcome).toBe("unknown");
  });

  it("declines it in InferOps when rejected, and never stages it again", async () => {
    const { hooks, conversation, actionId } = await staged(script({ proposals: [proposal()] }));
    await hooks.rejectDot(actionId);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(true);
    await conversation.read();
    expect((await hooks.log()).actions).toHaveLength(1);
  });
});

// FAC-120: the Dot's proposal to run an InferOS workflow. The run is the kernel's to start, as the
// person approving it (its approved effects, scripted here); InferOps runs nothing for it.
describe("deciding a workflow-run proposal", () => {
  const REFERENCE = 'inferops://acme.operations/inferos/workflow-trigger/ws-1/7?definition="def-1"&revision="2"';
  const workflow = () => proposal({ tool: "inferos_workflow_invoke", input: { reference: REFERENCE } });

  it("is staged as its own kind, naming the trigger and revision, never as an InferOps change", async () => {
    const { hooks } = await staged(script({ proposals: [workflow()] }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({ kind: "inferops.dot-workflow-invoke", title: "Your Dot proposes running a workflow", implementsRevert: false });
    // Declared to the kernel at submit, which binds the approval's run to exactly this reference.
    expect(action).toMatchObject({ workflowRun: { reference: REFERENCE } });
    expect(JSON.stringify(action)).toContain("trigger 7 of InferOS workspace ws-1, revision 2");
  });

  it("starts nothing, and asks InferOps nothing, without a person's approval", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()] }));
    const { failure } = await hooks.applyDot(actionId);
    expect(failure).toMatchObject({ outcome: "notApplied", kind: "policy", message: "Starting a workflow run needs your own approval here." });
    expect(await hooks.dotEffectsAsked()).toEqual([]);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("starts the run through the kernel, then confirms the hand-off keyed by the proposal id, with the run on the receipt", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } } }));
    const applied = await hooks.applyDot(actionId, { status: "started", runId: "run-1" });
    expect(applied.failure).toBeNull();
    expect(applied.result).toMatchObject({ kind: "dot-confirm", proposalId: PROPOSAL, runId: "run-1" });
    expect(await hooks.dotEffectsAsked()).toEqual(["invoked"]);
    const confirm = (await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"));
    expect(confirm?.key).toBe(PROPOSAL);
    // It names the run it started, so InferOps accepts that run's outcome only (FAC-134).
    expect(JSON.parse(confirm?.body ?? "null")).toEqual({ runId: "run-1" });
    // Applied once: approving again starts nothing more.
    await hooks.applyDot(actionId, { status: "started", runId: "run-2" });
    expect(await hooks.dotEffectsAsked()).toEqual(["invoked"]);
  });

  it("a run that may have started is uncertain: never retried as a refusal, never declined, never confirmed", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()] }));
    const { failure } = await hooks.applyDot(actionId, { status: "unknown", reason: "It isn't known whether the workflow run started." });
    expect(failure).toMatchObject({ outcome: "unknown", retryable: false });
    const calls = await hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith("/decline"))).toBe(false);
    expect(calls.some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("asks the kernel for its run's outcome when it declares the run (FAC-134)", async () => {
    const { hooks } = await staged(script({ proposals: [workflow()] }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({ workflowRun: { reference: REFERENCE, reportOutcome: true } });
  });

  // FAC-134: the kernel reports the run's outcome at least once; it is recorded once per run id.
  const outcomeOf = (runId: string, extra: Record<string, unknown> = {}) => ({
    kind: "workflow-run" as const, runId, outcome: "failed" as const, reason: "runtime-error",
    requestedBy: "p1", ranAs: "gadget_bindings" as const, actionApplied: true, ...extra,
  });
  const runOutcomeCalls = async (hooks: Awaited<ReturnType<typeof staged>>["hooks"]) =>
    (await hooks.dotCalls()).filter(c => c.path.endsWith("/run-outcome"));

  it("records its run's outcome in InferOps as the person, once: a second delivery changes nothing", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } } }));
    await hooks.applyDot(actionId, { status: "started", runId: "run-1" });
    expect(await hooks.dotRunOutcome(actionId, outcomeOf("run-1"))).toBeNull();
    const [call] = await runOutcomeCalls(hooks);
    expect(call!.method).toBe("POST");
    expect(call!.path.endsWith(`/proposals/${PROPOSAL}/run-outcome`)).toBe(true);
    // Fixed fields only, the kernel's reason as InferOps' reason code; nothing the run returned.
    expect(JSON.parse(call!.body!)).toEqual({ kind: "workflow-run", runId: "run-1", outcome: "failed", ranAs: "gadget_bindings", reasonCode: "runtime-error" });
    // The kernel delivering it again: no second request, nothing new recorded.
    expect(await hooks.dotRunOutcome(actionId, outcomeOf("run-1"))).toBeNull();
    expect(await runOutcomeCalls(hooks)).toHaveLength(1);
    expect(await hooks.dotReportedRuns(actionId)).toEqual([
      { runId: "run-1", outcome: "failed", reasonCode: "runtime-error", ranAs: "gadget_bindings", actionApplied: true, inferops: "recorded" },
    ]);
  });

  it("records a different run id on the same action once each", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } } }));
    await hooks.applyDot(actionId, { status: "started", runId: "run-1" });
    for (const runId of ["run-1", "run-2", "run-1", "run-2"]) expect(await hooks.dotRunOutcome(actionId, outcomeOf(runId))).toBeNull();
    expect((await runOutcomeCalls(hooks)).map(c => JSON.parse(c.body!).runId)).toEqual(["run-1", "run-2"]);
    expect((await hooks.dotReportedRuns(actionId) as { runId: string }[]).map(r => r.runId)).toEqual(["run-1", "run-2"]);
  });

  it("keeps InferOps' refusal for good, and lets a passing failure be retried", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } },
      runOutcome: { status: 503, code: "UNAVAILABLE" } }));
    await hooks.applyDot(actionId, { status: "started", runId: "run-1" });
    // Unavailable: thrown, so the kernel tries again; nothing recorded yet.
    expect(await hooks.dotRunOutcome(actionId, outcomeOf("run-1"))).not.toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([]);
    // Refused for good (another run already there): kept as refused, never retried.
    await hooks.dotScript(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } }, runOutcome: { status: 409, code: "PROPOSAL_RUN_RECORDED" } }));
    expect(await hooks.dotRunOutcome(actionId, outcomeOf("run-1"))).toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([expect.objectContaining({ runId: "run-1", inferops: "refused" })]);
  });

  it("ignores an outcome for an action that isn't a workflow-run proposal of this binding", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [proposal()] }));
    expect(await hooks.dotRunOutcome(actionId, outcomeOf("run-1"))).toBeNull();
    expect(await hooks.dotRunOutcome(actionId + 99, outcomeOf("run-1"))).toBeNull();
    expect(await runOutcomeCalls(hooks)).toEqual([]);
  });

  it("refused by the kernel, it is not applied, in the refusal's kind; only a final refusal declines it in InferOps (r1 on #488)", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()] }));
    const { failure } = await hooks.applyDot(actionId, { status: "refused", kind: "permission", reason: "You can't run this trigger." });
    expect(failure).toMatchObject({ outcome: "notApplied", kind: "permission", message: "You can't run this trigger.", retryable: true });
    let calls = await hooks.dotCalls();
    // A permission can be granted: the proposal stays pending in InferOps, for a later approval.
    expect(calls.some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(false);
    expect(calls.some(c => c.path.endsWith("/confirm"))).toBe(false);
    const final = await staged(script({ proposals: [workflow()] }));
    expect((await final.hooks.applyDot(final.actionId, { status: "refused", kind: "policy", reason: "Not allowed." })).failure)
      .toMatchObject({ outcome: "notApplied", retryable: false });
    calls = await final.hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(true);
    expect(calls.some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("refused for now, then approved again, it starts and is confirmed naming its run, never declined (r1 on #488)", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()], confirm: { outcome: { handedOff: true } } }));
    expect((await hooks.applyDot(actionId, { status: "refused", kind: "unavailable", reason: "Try again." })).failure)
      .toMatchObject({ retryable: true });
    expect((await hooks.applyDot(actionId, { status: "started", runId: "run-9" })).failure).toBeNull();
    const calls = await hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith("/decline"))).toBe(false);
    expect(JSON.parse(calls.find(c => c.path.endsWith("/confirm"))?.body ?? "null")).toEqual({ runId: "run-9" });
  });
});

// FAC-137: the Dot's proposal of a temporary canvas (inferops `inferos_canvas_compose`). The kernel
// creates it, as the person approving it, from what the action declared at submit (its approved
// effects, scripted here); InferOps makes nothing for it.
describe("deciding a temporary canvas proposal", () => {
  const BOARD = "inferops://acme.operations/project/board/ENG";
  const CARD = "inferops://acme.operations/project/issue-card/ENG-7";
  const GONE = "This canvas expired or was removed since it was created. Ask your Dot for it again.";
  // The kernel's typed references, as inferops #2649 sends them.
  const board = { type: "builtin", kind: "project/board", target: BOARD };
  const card = { type: "builtin", kind: "project/issue-card", target: CARD };
  const compose = (input: Record<string, unknown> = {
    title: "Release week",
    placements: [{ ref: board, layout: "small", filters: { status: "open" } }, { ref: card, layout: "half" }, { ref: board }],
  }) => proposal({ tool: "inferos_canvas_compose", input });

  it("is staged as its own kind, declaring to the kernel the canvas it will create, sizes as packed grid cells", async () => {
    const { hooks } = await staged(script({ proposals: [compose()] }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({
      kind: "inferops.dot-canvas-compose", title: "Your Dot proposes a temporary canvas", implementsRevert: false,
      temporaryCanvas: { title: "Release week", placements: [
        { ref: { type: "builtin", kind: "project/board", target: BOARD }, layout: { x: 0, y: 0, w: 4, h: 4 }, filters: { status: "open" } },
        { ref: { type: "builtin", kind: "project/issue-card", target: CARD }, layout: { x: 4, y: 0, w: 6, h: 6 }, filters: {} },
        // `large` when absent, and too wide for the row, so it starts the next one.
        { ref: { type: "builtin", kind: "project/board", target: BOARD }, layout: { x: 0, y: 6, w: 12, h: 8 }, filters: {} },
      ] },
    });
    // Each placement on the card, with its filters, so the person approves exactly what it will show.
    expect(JSON.stringify(action)).toContain(`project/board: ${BOARD}, filtered by status = \\"open\\"`);
    expect(JSON.stringify(action)).toContain(`project/issue-card: ${CARD}\\n`);
  });

  it.each([
    ["a list filter, which the kernel has no place for", { ref: board, filters: { status: ["open", "closed"] } }],
    ["a number filter", { ref: board, filters: { limit: 5 } }],
    ["a string reference (inferops #2649's earlier shape)", { ref: BOARD }],
    ["an unknown size", { ref: board, layout: "huge" }],
    ["an unknown field", { ref: board, position: { x: 0 } }],
  ])("is unreadable whole with %s: never a partial canvas, and approving it asks the kernel nothing", async (_what, odd) => {
    const { hooks, actionId } = await staged(script({ proposals: [compose({ title: "Mixed", placements: [{ ref: card }, odd] })] }));
    const [action] = (await hooks.log()).actions;
    expect(action).not.toHaveProperty("temporaryCanvas");
    expect(JSON.stringify(action)).toContain("a canvas InferOS can't read");
    const { failure } = await hooks.applyDotCanvas(actionId, { status: "created", canvasId: "c-1" });
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, kind: "policy" });
    expect(await hooks.dotEffectsAsked()).toEqual([]);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("creates nothing, and asks InferOps nothing, without a person's approval", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [compose()] }));
    const { failure } = await hooks.applyDot(actionId);
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, kind: "policy" });
    expect(await hooks.dotEffectsAsked()).toEqual([]);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("has the kernel create it, then confirms the hand-off keyed by the proposal id, with the canvas on the receipt", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [compose()], confirm: { outcome: { handedOff: true } } }));
    const applied = await hooks.applyDotCanvas(actionId, { status: "created", canvasId: "c-1" });
    expect(applied.failure).toBeNull();
    expect(applied.result).toMatchObject({ kind: "dot-confirm", proposalId: PROPOSAL, canvasId: "c-1" });
    expect((await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"))?.key).toBe(PROPOSAL);
    // Applied once: approving again creates nothing more.
    await hooks.applyDotCanvas(actionId, { status: "created", canvasId: "c-2" });
    expect(await hooks.dotEffectsAsked()).toEqual(["canvas"]);
  });

  it("refused by the kernel, it is not applied, never retryable, in the refusal's kind, and declined in InferOps", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [compose()] }));
    const { failure } = await hooks.applyDotCanvas(actionId, { status: "refused", kind: "permission", reason: "You can't use one of these widgets." });
    // A permission refusal elsewhere may be approved again once granted; the kernel's is final.
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, kind: "permission", message: "You can't use one of these widgets." });
    const calls = await hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(true);
    expect(calls.some(c => c.path.endsWith("/confirm"))).toBe(false);
  });

  it("a canvas gone since an uncertain first attempt is not applied and not retryable (K2's TEMPORARY_CANVAS_GONE)", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [compose()] }));
    // The kernel created the canvas, but its answer was lost: uncertain, and safe to send again.
    const first = await hooks.applyDotCanvas(actionId, "throw");
    expect(first.failure).toMatchObject({ outcome: "unknown", retryable: true });
    // By the retry the canvas expired or was removed: the kernel says so, and creates nothing.
    const { failure } = await hooks.applyDotCanvas(actionId, { status: "refused", kind: "policy", reason: GONE });
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, kind: "policy", message: GONE });
    expect(await hooks.dotAction(actionId)).toEqual({ status: "failed", message: GONE });
    // Settled: approving again replays the refusal and asks the kernel nothing more.
    const again = await hooks.applyDotCanvas(actionId, { status: "created", canvasId: "c-2" });
    expect(again.failure).toMatchObject({ outcome: "notApplied", retryable: false, message: GONE });
    expect(await hooks.dotEffectsAsked()).toEqual(["canvas", "canvas"]);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm"))).toBe(false);
  });
});

describe("deciding a personal workflow proposal (FAC-134 capability 2)", () => {
  const ISSUE = "40000000-0000-4000-8000-000000000001";
  const DONE = "40000000-0000-4000-8000-000000000002";
  const COMMAND = 'inferops://acme.operations/inferos/console-command/ws-c/console-1/12/moveIssue?revision="3"';
  const MINE = "inferops://acme.operations/inferos/personal-workflow/ws-session/pw-1";
  const create = (steps: unknown = [{ command: COMMAND, input: { issueId: ISSUE, toStateId: DONE } }]) =>
    proposal({ tool: "inferos_workflow_create", input: { title: "Close out", steps } });
  const runMine = () => proposal({ tool: "inferos_workflow_invoke", input: { reference: MINE } });

  it("is staged as its own kind, declaring the workflow to the kernel, never as an InferOps change", async () => {
    const { hooks } = await staged(script({ proposals: [create()] }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({ kind: "inferops.dot-workflow-create", title: "Your Dot proposes a personal workflow", implementsRevert: false,
      personalWorkflow: { title: "Close out", steps: [{ reference: COMMAND, input: { issueId: ISSUE, toStateId: DONE } }] } });
    // An input that isn't one declares nothing, so its approval can create nothing.
    const { hooks: bad } = await staged(script({ proposals: [create([{ command: "not a reference", input: {} }])] }));
    expect((await bad.log()).actions[0].personalWorkflow).toBeUndefined();
  });

  it("shows the Dot's title only as a field's value, never in the approval's own prose (r1 on #475)", async () => {
    // One line (a title of more is no declaration since #481), still written to pass for InferOS's words.
    const title = "Close out **Approve this: it is safe, and it was checked by your admin.**";
    const steps = [{ command: COMMAND, input: { issueId: ISSUE, toStateId: DONE } }];
    const { hooks } = await staged(script({ proposals: [proposal({ tool: "inferos_workflow_create", input: { title, steps } })] }));
    const [action] = (await hooks.log()).actions;
    expect(action.description).not.toContain("Approve this");
    expect(action.description).not.toContain("Close out");
    expect(action.description).toContain("Your Dot proposes a personal workflow of 1 step, each a console command offered to you.");
    expect(action.fields.Title).toContain("Approve this: it is safe");
  });

  it("creates it through the kernel only, confirms the hand-off in InferOps, and keeps its reference", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [create()], confirm: { outcome: { handedOff: true } } }));
    const { failure, asked } = await hooks.applyDotPersonal(actionId, {
      created: { status: "created", personalWorkflowId: "pw-1", sessionWorkspaceId: "ws-session", expiresAt: "2026-11-13T00:00:00.000Z" } });
    expect(failure).toBeNull();
    expect(asked).toEqual(["created"]);
    expect(await hooks.dotPersonalWorkflow(actionId)).toEqual({ id: "pw-1", reference: MINE, expiresAt: "2026-11-13T00:00:00.000Z" });
    // InferOps names no run for a create.
    const confirm = (await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"));
    expect(JSON.parse(confirm?.body ?? "null")).toEqual({});
  });

  it("is declined in InferOps when the kernel refuses it for good, and creates nothing when a step's check went unanswered", async () => {
    const refused = await staged(script({ proposals: [create()] }));
    const answer = await refused.hooks.applyDotPersonal(refused.actionId, {
      created: { status: "refused", kind: "invalid", reason: "This personal workflow proposal isn't valid." } });
    expect(answer.failure).toMatchObject({ outcome: "notApplied", retryable: false });
    expect((await refused.hooks.dotCalls()).some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(true);
    const unknown = await staged(script({ proposals: [create()] }));
    const lost = await unknown.hooks.applyDotPersonal(unknown.actionId, { created: { status: "unknown", reason: "unchecked" } });
    expect(lost.failure).not.toBeNull();
    expect((await unknown.hooks.dotCalls()).some(c => c.path.endsWith("/confirm") || c.path.endsWith("/decline"))).toBe(false);
    expect(await unknown.hooks.dotPersonalWorkflow(unknown.actionId)).toBeNull();
  });

  it("ends a refused create or run by the kernel's kind: a grantable refusal stays retryable, one that stands is final (QA's mutation 3)", async () => {
    // Each FAC-119 kind, through RUN_REFUSAL_CODES: a missing permission, a sign-in or an
    // unavailable check can pass later; a policy, conflict or invalid refusal stands.
    const kinds = [
      ["permission", true], ["sign-in", true], ["unavailable", true],
      ["policy", false], ["conflict", false], ["invalid", false],
    ] as const;
    for (const [kind, retryable] of kinds) {
      for (const which of ["create", "run"] as const) {
        const { hooks, actionId } = await staged(script({ proposals: [which === "create" ? create() : runMine()] }));
        const refusal = { status: "refused", kind, reason: `Refused as ${kind}.` } as const;
        const { failure } = await hooks.applyDotPersonal(actionId, which === "create" ? { created: refusal } : { run: refusal });
        expect(failure, `${which} ${kind}`).toMatchObject({ outcome: "notApplied", retryable });
        // Declined in InferOps only when it stands: a retryable one stays pending there (r1 on #488).
        expect((await hooks.dotCalls()).some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`)), `${which} ${kind}`).toBe(!retryable);
        expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm")), `${which} ${kind}`).toBe(false);
        // A retryable refusal leaves the action to approve again; one that stands ends it failed.
        expect((await hooks.dotAction(actionId))?.status, `${which} ${kind}`).toBe(retryable ? "pending" : "failed");
      }
    }
  });

  it("refused for now, then approved again, is created or run and confirmed, never declined (r1 on #488)", async () => {
    const made = await staged(script({ proposals: [create()], confirm: { outcome: { handedOff: true } } }));
    await made.hooks.applyDotPersonal(made.actionId, { created: { status: "refused", kind: "unavailable", reason: "Try again." } });
    expect((await made.hooks.applyDotPersonal(made.actionId, {
      created: { status: "created", personalWorkflowId: "pw-1", sessionWorkspaceId: "ws-session", expiresAt: "2026-11-13T00:00:00.000Z" } })).failure)
      .toBeNull();
    expect((await made.hooks.dotCalls()).some(c => c.path.endsWith("/decline"))).toBe(false);
    expect((await made.hooks.dotCalls()).some(c => c.path.endsWith("/confirm"))).toBe(true);
    const ran = await staged(script({ proposals: [runMine()], confirm: { outcome: { handedOff: true } } }));
    await ran.hooks.applyDotPersonal(ran.actionId, { run: { status: "refused", kind: "sign-in", reason: "Sign in again." } });
    expect((await ran.hooks.applyDotPersonal(ran.actionId, { run: { status: "started", runId: "run-7" } })).failure).toBeNull();
    const calls = await ran.hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith("/decline"))).toBe(false);
    expect(JSON.parse(calls.find(c => c.path.endsWith("/confirm"))?.body ?? "null")).toEqual({ runId: "run-7" });
  });

  it("keeps the kernel's refusal when InferOps doesn't answer the decline", async () => {
    for (const which of ["create", "run"] as const) {
      const { hooks, actionId } = await staged(script({
        proposals: [which === "create" ? create() : runMine()], decline: { status: 503, code: "UNAVAILABLE" },
      }));
      const refusal = { status: "refused", kind: "policy", reason: "Refused by policy." } as const;
      const { failure } = await hooks.applyDotPersonal(actionId, which === "create" ? { created: refusal } : { run: refusal });
      expect(failure, which).toMatchObject({ outcome: "notApplied", retryable: false });
      expect((await hooks.dotAction(actionId))?.status, which).toBe("failed");
    }
  });

  it("runs one by its reference through the kernel's own effect, naming the run at the confirm", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [runMine()], confirm: { outcome: { handedOff: true } } }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({ kind: "inferops.dot-personal-workflow-run", personalWorkflowRun: { reference: MINE, reportOutcome: true } });
    expect(action.workflowRun).toBeUndefined();
    const { failure, asked } = await hooks.applyDotPersonal(actionId, { run: { status: "started", runId: "run-7" } });
    expect(failure).toBeNull();
    expect(asked).toEqual(["ran"]);
    const confirm = (await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"));
    expect(JSON.parse(confirm?.body ?? "null")).toEqual({ runId: "run-7" });
  });

  it("records only a personal workflow's outcome for its run, never a trigger run's", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [runMine()], confirm: { outcome: { handedOff: true } } }));
    await hooks.applyDotPersonal(actionId, { run: { status: "started", runId: "run-7" } });
    const outcome = { runId: "run-7", outcome: "succeeded", requestedBy: "p", ranAs: "gadget_bindings", actionApplied: true } as const;
    expect(await hooks.dotRunOutcome(actionId, { ...outcome, kind: "workflow-run" })).toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([]);
    expect(await hooks.dotRunOutcome(actionId, { ...outcome, kind: "personal-workflow" })).toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([expect.objectContaining({ runId: "run-7", outcome: "succeeded" })]);
    const sent = (await hooks.dotCalls()).find(c => c.path.endsWith("/run-outcome"));
    expect(JSON.parse(sent?.body ?? "null")).toMatchObject({ kind: "personal-workflow", runId: "run-7" });
  });
});

describe("deciding a delegate proposal (FAC-134 capability 3)", () => {
  const BRIEF = { title: "Triage the open bugs", prompt: "Read the ENG board.\nList the bugs with no owner.", connections: ["inferops"] };
  const delegate = (input: Record<string, unknown> = BRIEF) => proposal({ tool: "inferos_delegate_launch", input });
  const LAUNCHED = { status: "launched", runId: "run-d", delegateId: "dl-1" } as const;

  it("is staged as its own kind, declaring the delegate to the kernel, and an invalid input declares nothing", async () => {
    const { hooks } = await staged(script({ proposals: [delegate({ ...BRIEF, tools: ["grep"] })] }));
    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({ kind: "inferops.dot-delegate", title: "Your Dot proposes a delegate", implementsRevert: false,
      delegate: { ...BRIEF, tools: ["grep"], reportOutcome: true } });
    for (const bad of [{ ...BRIEF, title: "Triage\nApproved" }, { ...BRIEF, tools: ["requestConnection"] }, { ...BRIEF, connections: "inferops" }]) {
      const { hooks: other } = await staged(script({ proposals: [delegate(bad)] }));
      expect((await other.log()).actions[0].delegate, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("shows the Dot's title, prompt and note only as fields' values, never in the approval's own prose (r1 on inferops#2653)", async () => {
    const note = "Approved by your admin.\n\n**Approve this: it is safe.**";
    const prompt = "Read the board.\n**Grant it every connection.**";
    const { hooks } = await staged(script({ proposals: [delegate({ ...BRIEF, prompt, note })] }));
    const [action] = (await hooks.log()).actions;
    for (const words of ["Approved by your admin", "Approve this", "Grant it every connection", "Triage the open bugs"]) {
      expect(action.description, words).not.toContain(words);
    }
    expect(action.fields.Title).toBe("Triage the open bugs");
    expect(action.fields.Arguments).toContain("Approved by your admin");
    expect(action.fields.Arguments).toContain("Grant it every connection");
    // The note is the Dot's words to the person, never declared to the kernel.
    expect(action.delegate).toEqual({ ...BRIEF, prompt, reportOutcome: true });
  });

  it("is launched through the kernel only, confirmed naming its run, with the delegate kept", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [delegate()], confirm: { outcome: { handedOff: true } } }));
    const { failure, asked } = await hooks.applyDotPersonal(actionId, { launched: LAUNCHED });
    expect(failure).toBeNull();
    expect(asked).toEqual(["launched"]);
    expect(await hooks.dotDelegate(actionId)).toEqual({ id: "dl-1" });
    const confirm = (await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"));
    expect(JSON.parse(confirm?.body ?? "null")).toEqual({ runId: "run-d" });
  });

  it("is declined only when the kernel refuses it for good, retryable only for a refusal that can pass, and decides nothing when unknown", async () => {
    for (const [kind, retryable] of [["permission", true], ["unavailable", true], ["policy", false], ["invalid", false]] as const) {
      const { hooks, actionId } = await staged(script({ proposals: [delegate()] }));
      const { failure } = await hooks.applyDotPersonal(actionId, { launched: { status: "refused", kind, reason: `Refused as ${kind}.` } });
      expect(failure, kind).toMatchObject({ outcome: "notApplied", retryable });
      // Only a refusal that stands declines it in InferOps (r1 on #488).
      expect((await hooks.dotCalls()).some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`)), kind).toBe(!retryable);
      expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm")), kind).toBe(false);
      expect((await hooks.dotAction(actionId))?.status, kind).toBe(retryable ? "pending" : "failed");
    }
    // Refused for now, then approved again: launched and confirmed naming its run, never declined.
    const again = await staged(script({ proposals: [delegate()], confirm: { outcome: { handedOff: true } } }));
    await again.hooks.applyDotPersonal(again.actionId, { launched: { status: "refused", kind: "unavailable", reason: "Try again." } });
    expect((await again.hooks.applyDotPersonal(again.actionId, { launched: LAUNCHED })).failure).toBeNull();
    const calls = await again.hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith("/decline"))).toBe(false);
    expect(JSON.parse(calls.find(c => c.path.endsWith("/confirm"))?.body ?? "null")).toEqual({ runId: "run-d" });
    const { hooks, actionId } = await staged(script({ proposals: [delegate()] }));
    const lost = await hooks.applyDotPersonal(actionId, { launched: { status: "unknown", reason: "lost" } });
    expect(lost.failure).not.toBeNull();
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/confirm") || c.path.endsWith("/decline"))).toBe(false);
    expect(await hooks.dotDelegate(actionId)).toBeNull();
  });

  it("records only a delegate's outcome as the person's, and no other kind or authority for it", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [delegate()], confirm: { outcome: { handedOff: true } } }));
    await hooks.applyDotPersonal(actionId, { launched: LAUNCHED });
    const outcome = { runId: "run-d", outcome: "failed", reason: "cancelled", requestedBy: "p", actionApplied: true } as const;
    expect(await hooks.dotRunOutcome(actionId, { ...outcome, kind: "workflow-run", ranAs: "person" })).toBeNull();
    expect(await hooks.dotRunOutcome(actionId, { ...outcome, kind: "delegate", ranAs: "gadget_bindings" })).toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([]);
    expect(await hooks.dotRunOutcome(actionId, { ...outcome, kind: "delegate", ranAs: "person" })).toBeNull();
    expect(await hooks.dotReportedRuns(actionId)).toEqual([expect.objectContaining({ runId: "run-d", outcome: "failed", ranAs: "person" })]);
    const sent = (await hooks.dotCalls()).find(c => c.path.endsWith("/run-outcome"));
    expect(JSON.parse(sent?.body ?? "null")).toMatchObject({ kind: "delegate", runId: "run-d", ranAs: "person", reasonCode: "cancelled" });
  });
});

describe("declining a proposal records only what InferOps confirmed (r2)", () => {
  it("keeps a decline InferOps didn't answer pending, says so, and can decline it again", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [proposal()], decline: { status: 503, code: "UNAVAILABLE" } }));
    expect(await failure(hooks.rejectDot(actionId))).toContain("Your decline couldn't be confirmed in InferOps");
    expect(await hooks.dotAction(actionId)).toEqual({ status: "pending", message: null });
    await hooks.dotScript(script({ proposals: [proposal()] }));
    await hooks.rejectDot(actionId);
    expect(await hooks.dotAction(actionId)).toEqual({ status: "failed", message: "Declined." });
  });

  it("refuses to decline a change InferOps already made, and approving it records it made", async () => {
    const { hooks, actionId } = await staged(script({
      proposals: [proposal()], decline: { status: 409, code: "PROPOSAL_DECIDED", settlesAs: "confirmed" },
    }));
    expect(await failure(hooks.rejectDot(actionId))).toContain("already made in InferOps");
    expect((await hooks.dotAction(actionId))?.status).toBe("pending");
    expect((await hooks.applyDot(actionId)).failure).toBeNull();
    expect((await hooks.dotAction(actionId))?.status).toBe("applied");
  });

  it("records the true outcome of a decline InferOps refused as expired", async () => {
    const { hooks, actionId } = await staged(script({
      proposals: [proposal()], decline: { status: 409, code: "PROPOSAL_EXPIRED", settlesAs: "expired" },
    }));
    await hooks.rejectDot(actionId);
    expect(await hooks.dotAction(actionId)).toEqual({
      status: "failed", message: "It expired before it was decided; nothing was made.",
    });
  });

  it("stages a proposal again when InferOps still waits on one recorded here as decided", async () => {
    const { hooks, conversation, actionId } = await staged(script({
      // A refusal that stands: the record settles as not applied.
      proposals: [proposal()], confirm: { status: 400, code: "INVALID_REQUEST" },
    }));
    expect((await hooks.applyDot(actionId)).failure?.outcome).toBe("notApplied");
    expect((await hooks.dotAction(actionId))?.status).toBe("failed");
    // InferOps still shows it waiting for a decision, so it is decided here again.
    await conversation.read();
    expect((await hooks.log()).actions).toHaveLength(2);
  });
});

describe("who may decide a Dot action (r1)", () => {
  it("admits no collaborator, so only the person whose Dot it is can open, and decide, it", async () => {
    const hooks = env.TEST_HOOKS.getByName(`dot-observer-${crypto.randomUUID()}`);
    const refused = await hooks.addDotObserver({
      accountId: `dot-${crypto.randomUUID()}`, connected: true, host: "acme.operations", workspaceId: "90000000-0000-4000-8000-000000000001",
    });
    expect(refused).toContain("A Dot is private to its person");
  });
});

describe("a proposal's status, in FAC-97's words", () => {
  it("maps every InferOps status, and keeps InferOps' words out of a failure", () => {
    expect(dotProposalStatus(proposal())).toEqual({ outcome: "waiting" });
    expect(dotProposalStatus(proposal({ status: "confirming" }))).toEqual({ outcome: "running" });
    expect(dotProposalStatus(proposal({ status: "declined" }))).toEqual({ outcome: "rejected" });
    expect(dotProposalStatus(proposal({ status: "expired" }))).toMatchObject({ outcome: "failed", code: "EXPIRED" });
    expect(dotProposalStatus(proposal({ status: "unknown" }))).toMatchObject({ outcome: "unknown" });
    const failed = dotProposalStatus(proposal({ status: "failed", outcome: { code: "FORBIDDEN", message: "Ada can't do this in Finance" } }));
    expect(failed).toMatchObject({ outcome: "failed", code: "FORBIDDEN" });
    expect(JSON.stringify(failed)).not.toContain("Ada");
    expect(dotProposalStatus(proposal({ status: "confirmed", outcome: { issue: { identifier: "ENG-7" } } })))
      .toEqual({ outcome: "succeeded", result: { "issue.identifier": "ENG-7" } });
    // FAC-120: the hand-off to InferOS is the write that succeeded; the run is InferOS's to report.
    expect(dotProposalStatus(proposal({ status: "handed-off", outcome: { handedOff: true, proposalId: "p-1" } })))
      .toMatchObject({ outcome: "succeeded" });
  });

  it("summarizes an answer to identifying scalars only, bounded", () => {
    const summary = summarizeDotOutcome({ issue: { identifier: "ENG-7", description: "body", title: "t".repeat(500) }, deliveries: [{ id: 1 }] });
    expect(summary).toEqual({ "issue.identifier": "ENG-7", "issue.title": "t".repeat(200) });
  });
});

describe("a knowledge write's target (FAC-136)", () => {
  it("names an edit's page and a create's workspace by link, and nothing for any other tool or a non-link", async () => {
    const { dotKnowledgeTarget } = await import("../src/dot");
    const link = "inferops://acme.handbook/knowledge/page/00000000-0000-4000-8000-0000000000aa";
    expect(dotKnowledgeTarget("knowledge_page_edit", { page: link })).toEqual({ label: "Page", link });
    expect(dotKnowledgeTarget("knowledge_page_create", { workspace: "inferops://acme.handbook/knowledge/page" }))
      .toEqual({ label: "New page in", link: "inferops://acme.handbook/knowledge/page" });
    expect(dotKnowledgeTarget("issue_create", { page: link })).toBeNull();
    expect(dotKnowledgeTarget("knowledge_page_edit", { page: "https://example.com" })).toBeNull();
    expect(dotKnowledgeTarget("knowledge_page_edit", null)).toBeNull();
  });
});

// FAC-135: a decision the Dot needs persists while the browser is closed, and its run resumes as the
// person, once. InferOS stages what a cut turn left at the Dot gadget's next session start (its page,
// or a tile holding it); nothing stages while InferOS is closed (that needs a kernel background hook).
describe("a decision the Dot waits for (FAC-135)", () => {
  /** A turn whose stream was cut before the relay saw its proposal (the browser closed mid-turn). */
  const cut = (overrides: Partial<DotScript> = {}) => script({
    run: { frames: [started, text("Let me file that")] }, proposals: [proposal()], ...overrides,
  });
  const listed = async (hooks: Awaited<ReturnType<typeof setup>>["hooks"]) =>
    (await hooks.dotCalls()).filter(c => c.method === "GET" && c.path.endsWith("/proposals")).length;
  const read = async (hooks: Awaited<ReturnType<typeof setup>>["hooks"]) =>
    (await hooks.dotCalls()).filter(c => c.method === "GET" && /\/conversations\/[0-9a-f-]+$/.test(c.path)).length;

  it("stages a proposal a cut turn left at the next session start, with no read of the conversation, once", async () => {
    const { hooks, conversation } = await setup(cut());
    const turn = await conversation.ask("File it");
    expect(turn.status).not.toBe("complete");
    expect((await hooks.log()).actions).toHaveLength(0);
    const readsBefore = await read(hooks);

    await hooks.startDotSession();
    const { actions } = await hooks.log();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "inferops.dot-confirm", title: "Your Dot proposes: issue_create" });
    expect(await read(hooks)).toBe(readsBefore);
    expect(await listed(hooks)).toBeGreaterThan(0);

    // Started again (another tab, a second tile): nothing more is staged.
    await hooks.startDotSession();
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("stages nothing when the person's sign-in is gone, and says once that it waits for them to reconnect", async () => {
    const { hooks, conversation } = await setup(cut());
    await conversation.ask("File it");
    await hooks.dotScript(cut({ list: { status: 401, code: "UNAUTHORIZED" } }));
    await hooks.startDotSession();
    const since = await hooks.dotWaitsForReconnect();
    expect(since).not.toBeNull();
    await hooks.startDotSession();
    expect(await hooks.dotWaitsForReconnect()).toBe(since);
    expect((await hooks.log()).actions).toHaveLength(0);
    // Reconnected: the next start stages it, and the wait is over.
    await hooks.dotScript(cut());
    await hooks.startDotSession();
    expect((await hooks.log()).actions).toHaveLength(1);
    expect(await hooks.dotWaitsForReconnect()).toBeNull();
  });

  it("confirms an approval long after, records the resumed run by its own id, and a second approval sends nothing", async () => {
    const waiting = proposal({ createdAt: "2026-11-03T12:00:00.000Z", expiresAt: "2099-11-10T12:00:00.000Z", runStatus: "awaiting_decision" });
    const { hooks, actionId } = await staged(script({
      proposals: [waiting], resumed: { runId: RUN, status: "complete" }, runStatusAfter: "complete",
    }));
    expect((await hooks.applyDot(actionId)).failure).toBeNull();
    expect(await hooks.dotRecord(actionId)).toMatchObject({ status: "applied", resumed: { runId: RUN, status: "complete" }, runStatus: "complete" });
    await hooks.applyDot(actionId);
    expect((await hooks.dotCalls()).filter(c => c.path.endsWith("/confirm"))).toHaveLength(1);
  });

  it("treats nothing resumed as not final, and learns the run's end at the next session start", async () => {
    const waiting = proposal({ expiresAt: "2099-11-10T12:00:00.000Z", runStatus: "awaiting_decision" });
    const { hooks, conversation } = await setup(script({ proposals: [waiting], resumed: null, runStatusAfter: "awaiting_decision" }));
    await conversation.ask("File it");
    await conversation.read();
    const actionId = (await hooks.log()).actions[0]!.id;
    expect((await hooks.applyDot(actionId)).failure).toBeNull();
    expect(await hooks.dotRecord(actionId)).toMatchObject({ resumed: null, runStatus: "awaiting_decision" });
    // InferOps resumed it when the conversation's busy run ended.
    await hooks.dotScript(script({ proposals: [{ ...waiting, status: "confirmed", runStatus: "complete" }] }));
    await hooks.startDotSession();
    expect(await hooks.dotRecord(actionId)).toMatchObject({ resumed: null, runStatus: "complete" });
    // Nothing waits any more: the conversation is no longer watched, and the next start reads nothing.
    const before = await listed(hooks);
    await hooks.startDotSession();
    expect(await listed(hooks)).toBe(before);
  });

  it("records the run a confirm resumed detached by its own id, and learns its end only from runStatus", async () => {
    const waiting = proposal({ expiresAt: "2099-11-10T12:00:00.000Z", runStatus: "awaiting_decision" });
    const { hooks, conversation } = await setup(script({
      proposals: [waiting], resumed: { runId: RUN, status: "running" }, runStatusAfter: "running",
    }));
    await conversation.ask("File it");
    await conversation.read();
    const actionId = (await hooks.log()).actions[0]!.id;
    expect((await hooks.applyDot(actionId)).failure).toBeNull();
    expect(await hooks.dotRecord(actionId)).toMatchObject({ resumed: { runId: RUN, status: "running" }, runStatus: "running" });
    // A session start while it still runs: a running resume isn't its end, so it stays watched.
    await hooks.dotScript(script({ proposals: [{ ...waiting, status: "confirmed", runStatus: "running" }] }));
    await hooks.startDotSession();
    await hooks.dotScript(script({ proposals: [{ ...waiting, status: "confirmed", runStatus: "complete" }] }));
    await hooks.startDotSession();
    expect(await hooks.dotRecord(actionId)).toMatchObject({ resumed: { runId: RUN, status: "running" }, runStatus: "complete" });
  });

  it("keeps an approval whose sign-in expired pending, declining nothing, and confirms it once after reconnect", async () => {
    const { hooks, actionId, conversation } = await staged(script({ proposals: [proposal()], confirm: { status: 401, code: "UNAUTHORIZED" } }));
    expect((await conversation.read()).proposals[0]!.waitsForReconnect).toBe(false);
    expect((await hooks.applyDot(actionId)).failure).toMatchObject({ outcome: "notApplied", retryable: true, kind: "sign-in" });
    expect(await hooks.dotRecord(actionId)).toMatchObject({ status: "pending" });
    // The page tells it apart from any other wait: it waits for the person to reconnect InferOps.
    expect((await conversation.read()).proposals[0]!.waitsForReconnect).toBe(true);
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/decline"))).toBe(false);
    await hooks.dotScript(script({ proposals: [proposal()], resumed: { runId: RUN, status: "complete" } }));
    expect((await hooks.applyDot(actionId)).failure).toBeNull();
    await hooks.applyDot(actionId);
    const confirms = (await hooks.dotCalls()).filter(c => c.path.endsWith("/confirm"));
    expect(confirms.map(c => c.key)).toEqual([PROPOSAL, PROPOSAL]);
    expect(await hooks.dotRecord(actionId)).toMatchObject({ status: "applied", resumed: { runId: RUN, status: "complete" } });
    expect((await conversation.read()).proposals[0]!.waitsForReconnect).toBe(false);
  });

  it("ends another company's connection final, not retried, and declines the proposal", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [proposal()], otherCompany: true }));
    const { failure } = await hooks.applyDot(actionId);
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, code: "OTHER_COMPANY", kind: "permission" });
    expect((await hooks.dotCalls()).some(c => c.path.endsWith("/decline"))).toBe(true);
    expect(await hooks.dotRecord(actionId)).toMatchObject({ status: "failed" });
  });

  it("records a stale refusal, and the run InferOps then ended refused", async () => {
    const { hooks, actionId } = await staged(script({
      // InferOps fails the proposal it refused to confirm, then resumes its run with the refusal.
      proposals: [proposal()], confirm: { status: 409, code: "STALE_REVISION", settlesAs: "failed" }, runStatusAfter: "refused",
    }));
    const { failure } = await hooks.applyDot(actionId);
    expect(failure).toMatchObject({ outcome: "notApplied", retryable: false, code: "CONFLICT" });
    expect(await hooks.dotRecord(actionId)).toMatchObject({ status: "failed", runStatus: "refused" });
  });

  it("stops watching a conversation once its proposals have expired", async () => {
    const { hooks, conversation } = await setup(cut({ proposals: [proposal({ expiresAt: "2020-01-01T00:00:00.000Z" })] }));
    await conversation.ask("File it");
    await hooks.startDotSession();
    const before = await listed(hooks);
    await hooks.startDotSession();
    expect(await listed(hooks)).toBe(before);
  });
});

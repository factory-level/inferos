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
  outcome: null, createdAt: "2026-11-10T12:00:00.000Z", expiresAt: "2026-11-10T12:15:00.000Z", decidedAt: null,
  ...overrides,
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
    expect((await hooks.dotCalls()).find(c => c.path.endsWith("/confirm"))?.key).toBe(PROPOSAL);
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

  it("refused by the kernel, it is not applied, in the refusal's kind, and is declined in InferOps, never confirmed", async () => {
    const { hooks, actionId } = await staged(script({ proposals: [workflow()] }));
    const { failure } = await hooks.applyDot(actionId, { status: "refused", kind: "permission", reason: "You can't run this trigger." });
    expect(failure).toMatchObject({ outcome: "notApplied", kind: "permission", message: "You can't run this trigger." });
    const calls = await hooks.dotCalls();
    expect(calls.some(c => c.path.endsWith(`/proposals/${PROPOSAL}/decline`))).toBe(true);
    expect(calls.some(c => c.path.endsWith("/confirm"))).toBe(false);
  });
});

// FAC-137: the Dot's proposal of a temporary canvas (inferops `inferos_canvas_compose`). The kernel
// creates it, as the person approving it, from what the action declared at submit (its approved
// effects, scripted here); InferOps makes nothing for it.
describe("deciding a temporary canvas proposal", () => {
  const BOARD = "inferops://acme.operations/project/board/ENG";
  const CARD = "inferops://acme.operations/project/issue-card/ENG-7";
  const GONE = "This canvas expired or was removed since it was created. Ask your Dot for it again.";
  const compose = (input: Record<string, unknown> = {
    title: "Release week",
    placements: [{ ref: BOARD, layout: "small", filters: { status: "open" } }, { ref: CARD, layout: "half" }, { ref: BOARD }],
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
    expect(JSON.stringify(action)).toContain("project/issue-card: " + CARD);
  });

  it.each([
    ["a list filter, which the kernel has no place for", { ref: BOARD, filters: { status: ["open", "closed"] } }],
    ["a number filter", { ref: BOARD, filters: { limit: 5 } }],
    ["a reference that isn't an inferops:// widget", { ref: "https://example.com/board" }],
    ["an unknown size", { ref: BOARD, layout: "huge" }],
    ["an unknown field", { ref: BOARD, position: { x: 0 } }],
  ])("is unreadable whole with %s: never a partial canvas, and approving it asks the kernel nothing", async (_what, odd) => {
    const { hooks, actionId } = await staged(script({ proposals: [compose({ title: "Mixed", placements: [{ ref: CARD }, odd] })] }));
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

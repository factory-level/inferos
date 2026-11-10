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
  });

  it("summarizes an answer to identifying scalars only, bounded", () => {
    const summary = summarizeDotOutcome({ issue: { identifier: "ENG-7", description: "body", title: "t".repeat(500) }, deliveries: [{ id: 1 }] });
    expect(summary).toEqual({ "issue.identifier": "ENG-7", "issue.title": "t".repeat(200) });
  });
});

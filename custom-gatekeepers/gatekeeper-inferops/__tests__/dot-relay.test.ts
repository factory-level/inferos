// The Dot's streaming relay (FAC-133), byte by byte: what InferOps' run stream carries reaches the
// caller in order and only once `@ag-ui/core` 1.0.2 accepts it, and every way a stream can go wrong
// ends the relay with a named reason, never silence. Frames are written exactly as InferOps'
// `streamAguiEvents` writes them. Also the strict parsers of the Dot's JSON answers.

import { describe, expect, it } from "vitest";
import {
  DOT_RELAY_LIMITS, DotMalformed, parseDotConversation, parseDotProposal, proposedIdOf, relayDotStream,
  type DotRelayLimits,
} from "../src/dot-relay";
import type { DotEvent } from "../src/inferops-client";

const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
const PING = ": ping\n\n";
const THREAD = "70000000-0000-4000-8000-000000000001";
const RUN = "71000000-0000-4000-8000-000000000001";
const started = sse({ type: "RUN_STARTED", threadId: THREAD, runId: RUN });
const finished = sse({ type: "RUN_FINISHED", threadId: THREAD, runId: RUN });
const delta = (text: string) => sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: text });

/** A stream that writes `chunks` (strings, or a pause in ms), then closes unless `open`. */
function stream(chunks: (string | number)[], open = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === "number") await new Promise(resolve => setTimeout(resolve, chunk));
        else controller.enqueue(encoder.encode(chunk));
      }
      if (!open) controller.close();
    },
  });
}

async function relay(chunks: (string | number)[], limits: Partial<DotRelayLimits> = {}, open = false) {
  const events: DotEvent[] = [];
  const end = await relayDotStream(stream(chunks, open), event => events.push(event), { ...DOT_RELAY_LIMITS, ...limits });
  return { end, events, types: events.map(e => e.type) };
}

describe("the Dot's relay", () => {
  it("hands on text deltas in order, across heartbeats and frames split anywhere", async () => {
    const whole = started + delta("Hel") + PING + delta("lo") + finished;
    const split = [whole.slice(0, 7), whole.slice(7, 40), whole.slice(40, 41), whole.slice(41)];
    const { end, events, types } = await relay(split);
    expect(end).toEqual({ kind: "finished" });
    expect(types).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]);
    expect(events.filter(e => e.type === "TEXT_MESSAGE_CONTENT").map(e => (e as { delta: string }).delta).join("")).toBe("Hello");
  });

  it("reads CRLF frames as LF ones", async () => {
    const { end, types } = await relay([started.replaceAll("\n", "\r\n"), finished.replaceAll("\n", "\r\n")]);
    expect(end).toEqual({ kind: "finished" });
    expect(types).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("hands on a tool call and its proposal result", async () => {
    const result = { proposed: true, proposalId: "72000000-0000-4000-8000-000000000001", message: "Proposed, not done" };
    const { types, events } = await relay([
      started,
      sse({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "issue_create" }),
      sse({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" }),
      sse({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      sse({ type: "TOOL_CALL_RESULT", messageId: "r1", toolCallId: "t1", content: JSON.stringify(result) }),
      finished,
    ]);
    expect(types).toEqual(["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_FINISHED"]);
    expect(proposedIdOf((events[4] as { content: unknown }).content)).toBe(result.proposalId);
  });

  it("ends with the run's own error, and reads nothing after it", async () => {
    const { end, types } = await relay([started, sse({ type: "RUN_ERROR", message: "Could not finish the response." }), delta("late")]);
    expect(end).toEqual({ kind: "error", message: "Could not finish the response." });
    expect(types).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  });

  it("names a stream that stops without ending the run as cut", async () => {
    const { end, types } = await relay([started, delta("Half")]);
    expect(end).toEqual({ kind: "cut" });
    expect(types).toEqual(["RUN_STARTED", "TEXT_MESSAGE_CONTENT"]);
  });

  it("names an event that isn't valid AG-UI malformed, and hands on nothing of it", async () => {
    for (const bad of ["data: {not json\n\n", sse({ type: "NOT_AN_EVENT" }), sse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1" })]) {
      const { end, types } = await relay([started, bad, finished]);
      expect(end, bad).toEqual({ kind: "malformed" });
      expect(types, bad).toEqual(["RUN_STARTED"]);
    }
  });

  it("names an event, a frame left open, or a run over its cap oversized", async () => {
    expect((await relay([started, delta("x".repeat(600)), finished], { eventBytes: 512 })).end).toEqual({ kind: "oversized" });
    expect((await relay([started, `data: ${"x".repeat(600)}`], { eventBytes: 512 })).end).toEqual({ kind: "oversized" });
    expect((await relay([started, delta("a"), delta("b"), finished], { runBytes: 200 })).end).toEqual({ kind: "oversized" });
  });

  it("keeps a run alive on heartbeats, and names a silence longer than the gap silent", async () => {
    expect((await relay([started, 30, PING, 30, PING, 30, finished], { silenceMs: 60 })).end).toEqual({ kind: "finished" });
    expect((await relay([started, PING], { silenceMs: 40 }, true)).end).toEqual({ kind: "silent" });
  });

  it("ends a run that outlives its deadline, however busy it is", async () => {
    const pings = Array.from({ length: 20 }, () => [10, PING]).flat();
    expect((await relay([started, ...pings], { deadlineMs: 60, silenceMs: 1000 }, true)).end).toEqual({ kind: "deadline" });
  });

  it("is bounded by InferOps' own run limits", () => {
    // InferOps aborts a run at 125 s and sends a heartbeat every 15 s.
    expect(DOT_RELAY_LIMITS.deadlineMs).toBeGreaterThan(125_000);
    expect(DOT_RELAY_LIMITS.silenceMs).toBeGreaterThan(15_000);
  });
});

describe("the Dot's answers, parsed strictly", () => {
  const proposal = {
    id: "72000000-0000-4000-8000-000000000001", tool: "issue_create", input: { title: "T" }, status: "proposed",
    outcome: null, createdAt: "2026-11-10T12:00:00.000Z", expiresAt: "2026-11-10T12:15:00.000Z", decidedAt: null,
  };

  it("reads every status InferOps names, its derived ones included", () => {
    // `handed-off` (FAC-120, inferops#2627): a confirmed InferOS workflow-run proposal.
    for (const status of ["proposed", "confirming", "confirmed", "handed-off", "declined", "failed", "expired", "unknown"]) {
      expect(parseDotProposal({ ...proposal, status }).status).toBe(status);
    }
  });

  it("refuses a shape InferOps didn't declare", () => {
    for (const bad of [{ ...proposal, status: "done" }, { ...proposal, id: "x" }, { ...proposal, input: [] }, null]) {
      expect(() => parseDotProposal(bad)).toThrow(DotMalformed);
    }
    expect(() => parseDotConversation({ id: THREAD, title: "t", messages: [{ role: "system" }], nextCursor: null, activeRunId: null, proposals: [] }))
      .toThrow(DotMalformed);
  });

  it("finds a proposal only in the broker's own answer", () => {
    expect(proposedIdOf({ proposed: true, proposalId: proposal.id })).toBe(proposal.id);
    expect(proposedIdOf(JSON.stringify({ proposed: true, proposalId: proposal.id }))).toBe(proposal.id);
    for (const other of [{ proposed: false, proposalId: proposal.id }, { proposalId: proposal.id }, "not json", { proposed: true, proposalId: "x" }]) {
      expect(proposedIdOf(other)).toBeNull();
    }
  });
});

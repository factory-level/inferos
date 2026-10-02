import { describe, expect, it } from "vitest";
import {
  applyOperateEvent,
  INITIAL_OPERATE_PAGE,
  MAX_OPERATE_FLOW_STEPS,
  MAX_OPERATE_WORKING_SET,
  OperateEventError,
  replayOperateEvents,
  type OperateEvent,
  type OperateRef,
} from "@gadgets/workshop-shared/operate-session";

const screen = (screenId: string, workspaceId = "ws1"): OperateRef =>
  ({ type: "screen", workspaceId, screenId });

describe("operate page state machine", () => {
  it("opens, focuses and closes references, moving focus to the latest remaining one", () => {
    let state = replayOperateEvents([
      { type: "open", ref: screen("a") },
      { type: "open", ref: screen("b") },
      { type: "focus", ref: screen("a") },
    ]);
    expect(state.workingSet).toEqual([screen("a"), screen("b")]);
    expect(state.focus).toEqual(screen("a"));

    state = applyOperateEvent(state, { type: "close", ref: screen("a") });
    expect(state.workingSet).toEqual([screen("b")]);
    expect(state.focus).toEqual(screen("b"));
  });

  it("re-opening a reference focuses it without duplicating it", () => {
    let state = replayOperateEvents([
      { type: "open", ref: screen("a") },
      { type: "open", ref: { type: "workspace", workspaceId: "app1" } },
      { type: "open", ref: screen("a") },
    ]);
    expect(state.workingSet).toHaveLength(2);
    expect(state.focus).toEqual(screen("a"));
  });

  it("drops the oldest reference when the working set is full", () => {
    let events: OperateEvent[] = [];
    for (let i = 0; i <= MAX_OPERATE_WORKING_SET; i++) events.push({ type: "open", ref: screen(`s${i}`) });
    let state = replayOperateEvents(events);
    expect(state.workingSet).toHaveLength(MAX_OPERATE_WORKING_SET);
    expect(state.workingSet[0]).toEqual(screen("s1"));
  });

  it("rejects invalid events and leaves the state unchanged", () => {
    let state = applyOperateEvent(INITIAL_OPERATE_PAGE, { type: "open", ref: screen("a") });
    let before = structuredClone(state);
    for (let event of [
      { type: "focus", ref: screen("missing") },
      { type: "close", ref: screen("missing") },
      { type: "open", ref: screen("") },
      { type: "setSubject", subject: "" },
      { type: "setSubject", subject: "x".repeat(513) },
    ] satisfies OperateEvent[]) {
      expect(() => applyOperateEvent(state, event)).toThrow(OperateEventError);
    }
    expect(state).toEqual(before);
  });

  it("is deterministic: replaying the same log yields the same page", () => {
    let log: OperateEvent[] = [
      { type: "open", ref: screen("a") },
      { type: "setSubject", subject: "inferops://demo.local/project/board/DEMO" },
      { type: "setChatOpen", open: false },
      { type: "setAppPresentation", presentation: "chat" },
    ];
    expect(replayOperateEvents(log)).toEqual(replayOperateEvents(log));
    expect(replayOperateEvents(log)).toMatchObject({
      subject: "inferops://demo.local/project/board/DEMO", chatOpen: false, appPresentation: "chat",
    });
  });

  it("runs a flow step by step without disturbing the working set", () => {
    const start: OperateEvent =
        { type: "startFlow", workspaceId: "ws1", flowId: "intake", title: "Intake", steps: ["a", "b", "c"] };
    let state = replayOperateEvents([{ type: "open", ref: screen("board") }, start]);
    expect(state.flow).toEqual({ workspaceId: "ws1", flowId: "intake", title: "Intake", steps: ["a", "b", "c"], index: 0 });
    expect(state.focus).toEqual(screen("board"));

    state = applyOperateEvent(state, { type: "goToStep", index: 2 });
    expect(state.flow?.index).toBe(2);
    expect(() => applyOperateEvent(state, { type: "goToStep", index: 3 })).toThrow(OperateEventError);
    expect(() => applyOperateEvent(state, { type: "goToStep", index: -1 })).toThrow(OperateEventError);
    expect(() => applyOperateEvent(state, { type: "goToStep", index: 0.5 })).toThrow(OperateEventError);

    state = applyOperateEvent(state, { type: "exitFlow" });
    expect(state.flow).toBeNull();
    expect(state.workingSet).toEqual([screen("board")]);
    expect(state.focus).toEqual(screen("board"));
  });

  it("rejects stepping or exiting with no flow, and a flow with no or too many steps", () => {
    expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, { type: "goToStep", index: 0 })).toThrow(OperateEventError);
    expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, { type: "exitFlow" })).toThrow(OperateEventError);
    const start = (steps: string[]): OperateEvent =>
        ({ type: "startFlow", workspaceId: "ws1", flowId: "f", title: "F", steps });
    expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, start([]))).toThrow(OperateEventError);
    expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE,
        start(Array.from({ length: MAX_OPERATE_FLOW_STEPS + 1 }, (_, i) => `s${i}`)))).toThrow(OperateEventError);
    expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, start([""]))).toThrow(OperateEventError);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyOperateEvent,
  INITIAL_OPERATE_PAGE,
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
});

import { describe, expect, it } from "vitest";
import {
  applyOperateEvent,
  INITIAL_OPERATE_PAGE,
  MAX_OPERATE_FLOW_STEPS,
  MAX_OPERATE_WORKING_SET,
  OperateEventError,
  replayOperateEvents,
  type OperateEvent,
  type OperatePageState,
  type OperateRef,
} from "@gadgets/workshop-shared/operate-session";

const screen = (screenId: string, workspaceId = "ws1"): OperateRef =>
  ({ type: "screen", workspaceId, screenId });
const approval = (actionId: number, workspaceId = "ws1") => ({ workspaceId, actionId });

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

  describe("approval review", () => {
    it("reviewing then resolving the same approval clears the review and records the outcome", () => {
      let state = applyOperateEvent(INITIAL_OPERATE_PAGE, { type: "reviewApproval", approval: approval(7) });
      expect(state.reviewing).toEqual(approval(7));

      state = applyOperateEvent(state, { type: "approvalResolved", approval: approval(7), outcome: "applied" });
      expect(state.reviewing).toBeNull();
      expect(state.lastApprovalOutcome).toEqual({ ...approval(7), outcome: "applied" });
    });

    it("resolving another approval records its outcome but keeps the one under review", () => {
      let state = replayOperateEvents([
        { type: "reviewApproval", approval: approval(7) },
        { type: "approvalResolved", approval: approval(7, "ws2"), outcome: "failed" },
        { type: "approvalResolved", approval: approval(8), outcome: "rejected" },
      ]);
      expect(state.reviewing).toEqual(approval(7));
      expect(state.lastApprovalOutcome).toEqual({ ...approval(8), outcome: "rejected" });
    });

    it("reviewing another approval replaces the one under review", () => {
      let state = replayOperateEvents([
        { type: "reviewApproval", approval: approval(7) },
        { type: "reviewApproval", approval: approval(9) },
      ]);
      expect(state.reviewing).toEqual(approval(9));
    });

    it("rejects malformed approval references", () => {
      for (let bad of [approval(-1), approval(1.5), approval(Number.NaN), approval(2 ** 53), approval(1, "")]) {
        expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, { type: "reviewApproval", approval: bad }))
            .toThrow(OperateEventError);
        expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE,
            { type: "approvalResolved", approval: bad, outcome: "applied" })).toThrow(OperateEventError);
      }
    });

    it("applies to a page stored before approvals existed once it is filled from the initial page", () => {
      // How the user DO reads a stored snapshot: missing fields come from INITIAL_OPERATE_PAGE.
      let { reviewing: _r, lastApprovalOutcome: _o, ...old } =
          replayOperateEvents([{ type: "open", ref: screen("a") }]);
      let stored: OperatePageState = { ...INITIAL_OPERATE_PAGE, ...old };
      expect(stored.reviewing).toBeNull();
      expect(stored.lastApprovalOutcome).toBeNull();
      let state = applyOperateEvent(stored, { type: "approvalResolved", approval: approval(3), outcome: "applied" });
      expect(state.reviewing).toBeNull();
      expect(state.focus).toEqual(screen("a"));
    });

    it("replays a log written before approvals existed with no review and no outcome", () => {
      let state = replayOperateEvents([
        { type: "open", ref: screen("a") },
        { type: "setChatOpen", open: false },
      ]);
      expect(state.reviewing).toBeNull();
      expect(state.lastApprovalOutcome).toBeNull();
    });
  });

  describe("consoles", () => {
    const openConsole = (fullChat: "off" | "available" | "default" | "only" = "available"): OperateEvent =>
      ({ type: "openConsole", workspaceId: "ws1", consoleId: "c1", title: "Operations lead", fullChat, viewId: "overview" });

    it("opens a console at a view, drills into a screen and back, and switches views", () => {
      let state = replayOperateEvents([openConsole(), { type: "showScreen", screenId: "board" }]);
      expect(state.console).toEqual({
        workspaceId: "ws1", consoleId: "c1", title: "Operations lead", fullChat: "available",
        viewId: "overview", screenId: "board",
      });
      expect(state.presentation).toBe("canvas");

      state = applyOperateEvent(state, { type: "showScreen", screenId: null });
      expect(state.console?.screenId).toBeNull();

      state = replayOperateEvents([openConsole(), { type: "showScreen", screenId: "board" }, { type: "openView", viewId: "activity" }]);
      expect(state.console).toMatchObject({ viewId: "activity", screenId: null });
    });

    it("opens in full chat when the console defaults to it or is chat-only", () => {
      expect(applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("default")).presentation).toBe("chat");
      expect(applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("only")).presentation).toBe("chat");
      expect(applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("off")).presentation).toBe("canvas");
    });

    it("switches presentation only as the console's full chat setting allows", () => {
      let available = applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("available"));
      let chat = applyOperateEvent(available, { type: "setPresentation", presentation: "chat" });
      expect(chat.presentation).toBe("chat");
      expect(applyOperateEvent(chat, { type: "setPresentation", presentation: "canvas" }).presentation).toBe("canvas");

      let off = applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("off"));
      expect(() => applyOperateEvent(off, { type: "setPresentation", presentation: "chat" })).toThrow(/does not offer full chat/);
      let only = applyOperateEvent(INITIAL_OPERATE_PAGE, openConsole("only"));
      expect(() => applyOperateEvent(only, { type: "setPresentation", presentation: "canvas" })).toThrow(/chat-only/);
    });

    it("closing the console returns to the mosaic in the canvas presentation", () => {
      let state = replayOperateEvents([openConsole("only"), { type: "closeConsole" }]);
      expect(state.console).toBeNull();
      expect(state.presentation).toBe("canvas");
    });

    it("rejects console events with no console open, and malformed consoles", () => {
      for (let event of [
        { type: "openView", viewId: "x" },
        { type: "showScreen", screenId: "x" },
        { type: "closeConsole" },
        { type: "setPresentation", presentation: "chat" },
      ] as OperateEvent[]) {
        expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, event)).toThrow(OperateEventError);
      }
      expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, { ...openConsole(), title: "" } as OperateEvent)).toThrow(OperateEventError);
      expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE, { ...openConsole(), viewId: "" } as OperateEvent)).toThrow(OperateEventError);
      expect(() => applyOperateEvent(INITIAL_OPERATE_PAGE,
          { ...openConsole(), fullChat: "sometimes" } as unknown as OperateEvent)).toThrow(OperateEventError);
    });

    it("applies to a page stored before consoles existed once it is filled from the initial page", () => {
      let { console: _c, presentation: _p, ...old } = replayOperateEvents([{ type: "open", ref: screen("a") }]);
      let stored: OperatePageState = { ...INITIAL_OPERATE_PAGE, ...old };
      let state = applyOperateEvent(stored, openConsole());
      expect(state.console?.consoleId).toBe("c1");
      expect(state.focus).toEqual(screen("a"));
    });
  });
});

it("returns home without losing the working set or approval context, including from a flow", () => {
  const events: OperateEvent[] = [
    { type: "open", ref: screen("a") },
    { type: "openConsole", workspaceId: "ws1", consoleId: "c1", title: "Operations", fullChat: "default", viewId: "a" },
    { type: "reviewApproval", approval: approval(7) },
    { type: "startFlow", workspaceId: "ws1", flowId: "f1", title: "Intake", steps: ["a"] },
    { type: "showHome" },
  ];
  const state = replayOperateEvents(events);
  expect(state).toMatchObject({ console: null, focus: null, flow: null, presentation: "canvas", workingSet: [screen("a")], reviewing: approval(7) });
  expect(applyOperateEvent(state, { type: "showHome" })).toEqual(state);
  expect(applyOperateEvent(state, { type: "focus", ref: screen("a") }).focus).toEqual(screen("a"));
});

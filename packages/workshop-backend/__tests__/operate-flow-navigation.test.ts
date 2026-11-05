// FAC-87: page states and navigation in a flow. A flow may name its pages and say where each one
// leads; a run then moves by those routes (branch, retry, return) and back through its history,
// never by step index, and each page may hold one of its own declared states. A flow that names
// no pages is the ordered list it always was and runs unchanged.

import { describe, expect, it } from "vitest";
import {
  createOpenGadgetError, getOperateSessionErrorCode, OPEN_GADGET_ERROR_CODES, OPERATE_SESSION_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import { checkFlowDestination } from "../src/flow-navigation";
import {
  MAX_OPERATE_FLOW_PAGE_STATES,
  MAX_OPERATE_FLOW_ROUTES,
  parseOperateFlowContent,
  type OperateFlowContent,
} from "@gadgets/workshop-shared/operate-flow";
import {
  applyOperateEvent,
  INITIAL_OPERATE_PAGE,
  MAX_OPERATE_FLOW_HISTORY,
  OperateEventError,
  replayOperateEvents,
  type OperateEvent,
  type OperateFlowPage,
  type OperatePageState,
} from "@gadgets/workshop-shared/operate-session";
import { applyWidgetTransition, parseWidgetStates } from "@gadgets/workshop-shared/widget-state";

// Intake (fill in) → Review, which approves to Done or sends back to Intake (retry); Done returns
// home to Intake. Screens are canvas ids; pages are this flow's own names.
const STEPS = ["scr-intake", "scr-review", "scr-done"];
const PAGES: OperateFlowPage[] = [
  { name: "intake", states: ["empty", "filled"], routes: [{ label: "Review", to: "review" }] },
  { name: "review", routes: [{ label: "Approve", to: "done" }, { label: "Send back", to: "intake" },
    { label: "Look again", to: "review" }] },
  { name: "done", routes: [{ label: "Start over", to: "intake" }] },
];
const start = (pages: OperateFlowPage[] | null = PAGES, steps = STEPS): OperateEvent =>
  ({ type: "startFlow", workspaceId: "ws1", flowId: "claims", title: "Claims", steps,
    ...(pages === null ? {} : { pages }) });
const run = (...events: OperateEvent[]): OperatePageState => replayOperateEvents([start(), ...events]);
const refused = (state: OperatePageState, event: OperateEvent) =>
  expect(() => applyOperateEvent(state, event)).toThrow(OperateEventError);

describe("a linear flow (no pages)", () => {
  it("still starts, steps and exits exactly as before, with no new fields", () => {
    let state = replayOperateEvents([start(null), { type: "goToStep", index: 2 }]);
    expect(state.flow).toEqual({ workspaceId: "ws1", flowId: "claims", title: "Claims", steps: STEPS, index: 2 });
    expect(parseOperateFlowContent({ title: "Claims", steps: STEPS })).toEqual({ title: "Claims", steps: STEPS });
  });

  it("refuses page navigation, which it has no pages for", () => {
    let state = replayOperateEvents([start(null)]);
    refused(state, { type: "navigateFlow", to: "review" });
    refused(state, { type: "backFlow" });
    refused(state, { type: "setFlowPageState", state: "filled" });
  });
});

describe("a flow with named pages", () => {
  it("starts on its first page in that page's first state, with no history", () => {
    expect(run().flow).toMatchObject({ index: 0, pages: PAGES, history: [], pageState: "empty" });
  });

  it("branches by a route, retries back to an earlier page, and returns along its history", () => {
    let state = run({ type: "setFlowPageState", state: "filled" }, { type: "navigateFlow", to: "review" });
    expect(state.flow).toMatchObject({ index: 1, history: [0], pageState: null });
    // Retry: review sends back to intake, which starts again in its first state.
    state = applyOperateEvent(state, { type: "navigateFlow", to: "intake" });
    expect(state.flow).toMatchObject({ index: 0, history: [0, 1], pageState: "empty" });
    state = applyOperateEvent(state, { type: "navigateFlow", to: "review" });
    state = applyOperateEvent(state, { type: "navigateFlow", to: "review" }); // a route to itself
    expect(state.flow).toMatchObject({ index: 1, history: [0, 1, 0, 1] });
    state = applyOperateEvent(state, { type: "navigateFlow", to: "done" });
    // Back follows the history, one page at a time, and stops at its start.
    expect(state.flow).toMatchObject({ index: 2, history: [0, 1, 0, 1, 1] });
    state = applyOperateEvent(state, { type: "backFlow" });
    expect(state.flow).toMatchObject({ index: 1, history: [0, 1, 0, 1] });
    for (let i = 0; i < 4; i++) state = applyOperateEvent(state, { type: "backFlow" });
    expect(state.flow).toMatchObject({ index: 0, history: [] });
    refused(state, { type: "backFlow" });
  });

  it("is not a wizard: no step index, and no page its current page doesn't lead to", () => {
    let state = run();
    refused(state, { type: "goToStep", index: 2 });
    refused(state, { type: "navigateFlow", to: "done" }); // intake leads only to review
  });

  it("holds only the current page's declared states", () => {
    let state = run({ type: "setFlowPageState", state: "filled" });
    expect(state.flow?.pageState).toBe("filled");
    refused(state, { type: "setFlowPageState", state: "approved" });
    state = applyOperateEvent(state, { type: "navigateFlow", to: "review" });
    refused(state, { type: "setFlowPageState", state: "filled" }); // review declares no states
  });

  it("refuses an unknown page, a screen id, and a widget event as navigation targets", () => {
    let state = run();
    for (let to of ["nowhere", "scr-review", "submit", "", "Review"]) {
      refused(state, { type: "navigateFlow", to });
    }
  });

  it("caps back history: past the cap the oldest moves are dropped, and back stops at the floor", () => {
    // Start on intake, then alternate review and intake, 40 moves: indexes 0,1,0,1,... are left.
    let state = run();
    let left: number[] = [];
    for (let i = 0; i < 40; i++) {
      left.push(state.flow!.index);
      state = applyOperateEvent(state, { type: "navigateFlow", to: i % 2 === 0 ? "review" : "intake" });
      expect(state.flow!.history!.length).toBeLessThanOrEqual(MAX_OPERATE_FLOW_HISTORY);
    }
    const kept = left.slice(-MAX_OPERATE_FLOW_HISTORY);
    expect(state.flow!.history).toEqual(kept);
    // Back walks exactly the kept moves, newest first, and never past them to a dropped one.
    let visited: number[] = [];
    for (let i = 0; i < MAX_OPERATE_FLOW_HISTORY; i++) {
      state = applyOperateEvent(state, { type: "backFlow" });
      visited.push(state.flow!.index);
    }
    expect(visited).toEqual(kept.toReversed());
    expect(state.flow!.history).toEqual([]);
    expect(() => applyOperateEvent(state, { type: "backFlow" })).toThrow("There is no earlier page to go back to.");
  });

  it("keeps back history bounded, dropping the oldest page", () => {
    let state = run({ type: "navigateFlow", to: "review" });
    for (let i = 0; i < MAX_OPERATE_FLOW_HISTORY + 5; i++) {
      state = applyOperateEvent(state, { type: "navigateFlow", to: "review" });
    }
    expect(state.flow?.history).toHaveLength(MAX_OPERATE_FLOW_HISTORY);
  });
});

describe("saving or starting a flow with pages", () => {
  const content = (pages: OperateFlowPage[], steps = STEPS): OperateFlowContent => ({ title: "Claims", steps, pages });
  const bad = (pages: OperateFlowPage[], steps = STEPS) => {
    expect(() => parseOperateFlowContent(content(pages, steps))).toThrow(TypeError);
    refused(INITIAL_OPERATE_PAGE, start(pages, steps));
  };

  it("accepts and copies a valid flow", () => {
    expect(parseOperateFlowContent(content(PAGES))).toEqual(content(PAGES));
  });

  it("refuses a route to an unknown page, a screen id or a widget event, and a misnamed page", () => {
    bad([PAGES[0]!, { ...PAGES[1]!, routes: [{ label: "Go", to: "nowhere" }] }, PAGES[2]!]);
    bad([{ ...PAGES[0]!, routes: [{ label: "Go", to: "scr-review" }] }, PAGES[1]!, PAGES[2]!]);
    bad([{ ...PAGES[0]!, routes: [{ label: "Go", to: "submit" }] }, PAGES[1]!, PAGES[2]!]);
    bad([{ ...PAGES[0]!, name: "Intake" }, PAGES[1]!, PAGES[2]!]);
    bad([PAGES[0]!, { ...PAGES[1]!, name: "intake" }, PAGES[2]!]); // two pages one name
    bad([{ ...PAGES[0]!, name: "scr-review" }, PAGES[1]!, PAGES[2]!]); // a page named as a screen
    bad(PAGES.slice(0, 2)); // a page per step
    bad([{ ...PAGES[0]!, routes: [{ label: "", to: "review" }] }, PAGES[1]!, PAGES[2]!]);
    bad([{ ...PAGES[0]!, states: ["empty", "empty"] }, PAGES[1]!, PAGES[2]!]);
  });

  it("refuses each limit one past it", () => {
    const routes = (n: number) => Array.from({ length: n }, () => ({ label: "Again", to: "intake" }));
    const states = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(() => parseOperateFlowContent(content([{ ...PAGES[0]!, routes: routes(MAX_OPERATE_FLOW_ROUTES) },
      PAGES[1]!, PAGES[2]!]))).not.toThrow();
    bad([{ ...PAGES[0]!, routes: routes(MAX_OPERATE_FLOW_ROUTES + 1) }, PAGES[1]!, PAGES[2]!]);
    expect(() => parseOperateFlowContent(content([{ ...PAGES[0]!, states: states(MAX_OPERATE_FLOW_PAGE_STATES) },
      PAGES[1]!, PAGES[2]!]))).not.toThrow();
    bad([{ ...PAGES[0]!, states: states(MAX_OPERATE_FLOW_PAGE_STATES + 1) }, PAGES[1]!, PAGES[2]!]);
  });
});

describe("widget transitions stay apart from page navigation", () => {
  it("a widget's machine knows nothing of the flow's pages", () => {
    const machine = parseWidgetStates(JSON.stringify({
      version: 1, initial: "open", persistence: "session", states: ["open", "sent"],
      transitions: [{ event: "submit", from: "open", to: "sent" }],
    }));
    expect(applyWidgetTransition(machine, "open", "submit")).toBe("sent");
    expect(() => applyWidgetTransition(machine, "open", "review")).toThrow(); // a page name is no widget event
  });
});

describe("checking a navigation's destination on the server", () => {
  const code = async (read: () => Promise<unknown>) => {
    try { await checkFlowDestination(read); return "accepted"; } catch (error) { return getOperateSessionErrorCode(error); }
  };
  const { flowNavigationFailed, flowPageUnavailable } = OPERATE_SESSION_ERROR_CODES;

  it("accepts a screen the caller can read", async () => {
    expect(await code(async () => ({ id: "scr-review" }))).toBe("accepted");
  });

  it("refuses a missing screen or a refused workspace as no longer available", async () => {
    expect(await code(async () => null)).toBe(flowPageUnavailable);
    for (const refusal of Object.values(OPEN_GADGET_ERROR_CODES)) {
      expect(await code(async () => { throw createOpenGadgetError(refusal); })).toBe(flowPageUnavailable);
    }
  });

  it("refuses any other failure as transient, so it can be retried, naming nothing", async () => {
    for (const failure of [new Error("Network connection lost."), new TypeError("stub disposed"), "boom"]) {
      let message = "";
      try { await checkFlowDestination(async () => { throw failure; }); } catch (error) { message = (error as Error).message; }
      expect(await code(async () => { throw failure; })).toBe(flowNavigationFailed);
      expect(message).toBe("Couldn't move to that page of the flow just now. Try again.");
    }
  });
});

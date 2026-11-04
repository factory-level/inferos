// A widget's local states (FAC-86): the declared machine is bounded and checked, a transition is a
// pure function that refuses predictably with a stable code and changes nothing, and a stored state
// resumes only while the machine still declares it.
import { describe, expect, it } from "vitest";
import {
  MAX_HELD_WIDGET_STATES, WIDGET_STATE_ERROR_CODES, WidgetStateError, WidgetStateMemory, applyWidgetTransition,
  parseWidgetStates, recoverWidgetState, widgetEventsFrom, type WidgetStateMachine,
} from "./widget-state";

/** A request widget: view, edit, submit, then a result with retry and return paths. */
const REQUEST = {
  version: 1, initial: "viewing", persistence: "person",
  states: ["viewing", "editing", "submitting", "done", "failed"],
  transitions: [
    { event: "edit", from: "viewing", to: "editing" },
    { event: "cancel", from: "editing", to: "viewing" },
    { event: "submit", from: "editing", to: "submitting" },
    { event: "succeed", from: "submitting", to: "done" },
    { event: "fail", from: "submitting", to: "failed" },
    { event: "retry", from: "failed", to: "submitting" },
    { event: "edit", from: "failed", to: "editing" },
    { event: "reset", from: "done", to: "viewing" },
  ],
};
const parse = (spec: unknown) => parseWidgetStates(JSON.stringify(spec));

describe("parsing states.json", () => {
  it("keeps a machine with branch, retry and return paths", () => {
    let machine = parse(REQUEST);
    expect(machine).toEqual(REQUEST);
    expect(widgetEventsFrom(machine, "failed")).toEqual(["retry", "edit"]);
  });

  it("refuses an unreachable state, an undeclared end, an ambiguous event and an unknown field", () => {
    expect(() => parse({ ...REQUEST, states: [...REQUEST.states, "orphan"] }))
      .toThrow('State "orphan" can\'t be reached from "viewing".');
    expect(() => parse({ ...REQUEST, transitions: [...REQUEST.transitions, { event: "jump", from: "done", to: "nowhere" }] }))
      .toThrow('Transition "jump" to "nowhere" is not a declared state.');
    expect(() => parse({ ...REQUEST, transitions: [...REQUEST.transitions, { event: "edit", from: "viewing", to: "done" }] }))
      .toThrow('Event "edit" is declared twice from state "viewing".');
    expect(() => parse({ ...REQUEST, guard: "x > 1" })).toThrow("has a field it doesn't take");
    expect(() => parse({ ...REQUEST, transitions: [{ event: "edit", from: "viewing", to: "editing", run: "fetch()" }] }))
      .toThrow("has a field it doesn't take");
  });

  it("refuses a bad version, persistence, initial state or id, and past the limits", () => {
    expect(() => parse({ ...REQUEST, version: 2 })).toThrow("version 1");
    expect(() => parse({ ...REQUEST, persistence: "workspace" })).toThrow('"person" or "session"');
    expect(() => parse({ ...REQUEST, initial: "missing" })).toThrow("is not a declared state");
    expect(() => parse({ ...REQUEST, states: ["Viewing"] })).toThrow("lowercase id");
    expect(() => parse({ ...REQUEST, states: [] })).toThrow("1 to 32 states");
    let many = Array.from({ length: 33 }, (_, i) => `s${i}`);
    expect(() => parse({ ...REQUEST, initial: "s0", states: many, transitions: [] })).toThrow("1 to 32 states");
    expect(() => parseWidgetStates("{")).toThrow("not valid JSON");
    expect(() => parseWidgetStates(" ".repeat(16 * 1024 + 1))).toThrow("larger than");
  });
});

describe("a transition", () => {
  const machine = parse(REQUEST) as WidgetStateMachine;

  it("moves only along a declared transition, including back to an earlier state", () => {
    expect(applyWidgetTransition(machine, "viewing", "edit")).toBe("editing");
    expect(applyWidgetTransition(machine, "failed", "retry")).toBe("submitting");
    expect(applyWidgetTransition(machine, "done", "reset")).toBe("viewing");
  });

  it("refuses an undeclared event and one not permitted here, with distinct codes and the accepted events", () => {
    let refusal = (state: string, event: unknown) => {
      try {
        applyWidgetTransition(machine, state, event);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(WidgetStateError);
        return { code: (error as WidgetStateError).code, message: (error as Error).message };
      }
    };
    expect(refusal("viewing", "launch")?.code).toBe(WIDGET_STATE_ERROR_CODES.unknownEvent);
    expect(refusal("viewing", 42)?.code).toBe(WIDGET_STATE_ERROR_CODES.unknownEvent);
    expect(refusal("viewing", "submit")).toEqual({
      code: WIDGET_STATE_ERROR_CODES.notPermitted,
      message: `${WIDGET_STATE_ERROR_CODES.notPermitted}: Event "submit" isn't permitted in state "viewing"; it accepts "edit".`,
    });
  });

  it("resumes a stored state the machine declares, and starts again at initial otherwise", () => {
    expect(recoverWidgetState(machine, "failed")).toBe("failed");
    expect(recoverWidgetState(machine, "gone")).toBe("viewing");
    expect(recoverWidgetState(machine, undefined)).toBe("viewing");
  });
});

describe("session state in memory", () => {
  const machine = parse(REQUEST) as WidgetStateMachine;

  it("checks the seq and writes in one step, refusing a second transition at the same seq", () => {
    let memory = new WidgetStateMemory();
    expect(memory.transition("w", machine, "edit", 0)).toMatchObject({ state: "editing", seq: 1 });
    expect(() => memory.transition("w", machine, "cancel", 0)).toThrow(WIDGET_STATE_ERROR_CODES.conflict);
    expect(memory.read("w", machine)).toMatchObject({ state: "editing", seq: 1 });
  });

  it("holds at most MAX_HELD_WIDGET_STATES, dropping the least recently changed", () => {
    let memory = new WidgetStateMemory();
    for (let i = 0; i <= MAX_HELD_WIDGET_STATES; i++) memory.transition(`w${i}`, machine, "edit", 0);
    expect(memory.read("w0", machine).state).toBe("viewing");
    expect(memory.read(`w${MAX_HELD_WIDGET_STATES}`, machine).state).toBe("editing");
  });
});

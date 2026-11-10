// A widget's local states (FAC-86): the `states.json` its commit may declare, and the pure
// transition function the kernel applies to one person's running state of one placed widget.
// It is declarative and bounded, with no guards or code (inferops docs/human/architecture/inferos/
// operate-mode.md), so publication freezes it and every check is the same everywhere.
//
// A widget's state is its own: changing it never changes the operate page (`OperatePageState`).
// Connecting a widget event to the page is an explicitly configured attachment (canvas-model.ts),
// which page states (FAC-87) run; nothing here reaches the page.
//
// Every problem message is kernel-written and names only identifiers `states.json` declared,
// each of which matches the id pattern first.

/** The file in a widget's commit that declares its local states. */
export const WIDGET_STATES_FILE = "states.json";

/** The limits on `states.json`. */
export const WIDGET_STATE_LIMITS = Object.freeze({
  /** Most states one widget declares. */
  states: 32,
  /** Most transitions one widget declares. */
  transitions: 128,
  /** Largest `states.json`, in UTF-8 bytes. */
  fileBytes: 16 * 1024,
});

/** A state or event id: lowercase, starting with a letter, at most 40 characters. */
const ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Whether a person's state of a widget is kept between visits.
 * - `person`: kept for that person, for one published revision of its console, and recovered when
 *   they open it again. A republished console starts every widget again at `initial`, since each
 *   revision runs its own frozen install.
 * - `session`: kept only while that person's operate session connection lives, and back at
 *   `initial` after a reconnect.
 */
export type WidgetStatePersistence = "person" | "session";

/** One permitted local transition: event `event` moves the widget from `from` to `to`. */
export type WidgetTransition = { event: string; from: string; to: string };

/**
 * A widget's declared local states. Branch, retry and return paths are just transitions: one state
 * may have several outgoing events, and a transition may lead back to an earlier state or to its
 * own. An `(event, from)` pair is declared at most once, so a transition is never ambiguous.
 */
export type WidgetStateMachine = {
  version: 1;
  initial: string;
  persistence: WidgetStatePersistence;
  states: string[];
  transitions: WidgetTransition[];
};

/**
 * A widget a published console offers, as an operate session names it: the console's workspace,
 * the console, its published revision and that revision's frozen install of the widget. Each
 * revision runs its own frozen install, so a republished console starts every widget afresh.
 */
export type OperateWidgetRef = { workspaceId: string; consoleId: string; revision: string; gadgetId: number };

/** Checks an `OperateWidgetRef` from a client: four bounded fields, nothing else read. */
export function parseOperateWidgetRef(ref: unknown): OperateWidgetRef {
  if (typeof ref !== "object" || ref === null) throw new TypeError("A widget is named by its console and install.");
  let { workspaceId, consoleId, revision, gadgetId } = ref as Record<string, unknown>;
  for (let value of [workspaceId, consoleId, revision]) {
    if (typeof value !== "string" || !value || value.length > 128) throw new TypeError("A widget is named by its console and install.");
  }
  if (!Number.isSafeInteger(gadgetId) || (gadgetId as number) < 0) throw new TypeError("A widget is named by its console and install.");
  return { workspaceId: workspaceId as string, consoleId: consoleId as string, revision: revision as string, gadgetId: gadgetId as number };
}

/** The storage key of one person's state of the widget `ref` names. */
export function widgetStateKey(ref: OperateWidgetRef): string {
  return JSON.stringify([ref.workspaceId, ref.consoleId, ref.revision, ref.gadgetId]);
}

/** One person's running state of one placed widget. */
export type WidgetStateSnapshot = {
  /** The current state, always one of the machine's `states`. */
  state: string;
  /** Raised by one with each transition; a transition names the `seq` it expects. */
  seq: number;
  /** The events the widget accepts in `state`, in declaration order. */
  events: string[];
  /**
   * Present only when the transition's event is wired to a `navigate` effect on the published page
   * the person is shown (FAC-94): where it led, and whether the person's own operate page moved
   * there. Absent for an unwired event, which changes nothing but the widget.
   */
  navigation?: WidgetNavigation;
  /**
   * Present only when the transition's event is wired to an `insert-prompt` effect on that same
   * published page (FAC-98): the first such prompt, for the transitioning person's own chat. `submit`
   * false puts it in their composer as a draft; true sends it as them, through the same send as their
   * own Send. It carries no target: it reaches only the session that made the transition, and what
   * it asks for still needs that person's own grants and approval.
   */
  prompt?: WidgetPrompt;
};

/** A prompt a wired widget event puts in the transitioning person's own chat (FAC-98). */
export type WidgetPrompt = { text: string; submit: boolean };

/**
 * Where a wired widget event navigated the person's operate page (FAC-94). `shown` when the page now
 * shows `screenId`; `refused` when the move was checked and refused (the console doesn't show that
 * screen, or the page changed meanwhile), leaving the page as it was. The widget's own transition
 * stands either way.
 */
export type WidgetNavigation = { screenId: string; outcome: "shown" | "refused" };

/** Refusal codes a widget transition carries, so a client can tell the reasons apart. */
export const WIDGET_STATE_ERROR_CODES = Object.freeze({
  /** The widget declares no states (its commit has no `states.json`). */
  noStates: "WIDGET_HAS_NO_STATES",
  /** The event is not one the widget declares at all. */
  unknownEvent: "WIDGET_UNKNOWN_EVENT",
  /** The event is declared, but not from the widget's current state. */
  notPermitted: "WIDGET_TRANSITION_NOT_PERMITTED",
  /** Another transition landed first: re-read the state and try again. */
  conflict: "WIDGET_STATE_CONFLICT",
});

/** A refused transition. The state it was asked of is unchanged. */
export class WidgetStateError extends Error {
  /** One of `WIDGET_STATE_ERROR_CODES`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WidgetStateError";
    this.code = code;
  }
}

/**
 * Parses `states.json`'s text, or throws an `Error` naming the first problem. Every state must be
 * reachable from `initial`, and every transition's `from` and `to` must be declared states.
 */
export function parseWidgetStates(text: string): WidgetStateMachine {
  if (new TextEncoder().encode(text).length > WIDGET_STATE_LIMITS.fileBytes) {
    throw new Error(`states.json is larger than ${WIDGET_STATE_LIMITS.fileBytes} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("states.json is not valid JSON.");
  }
  let spec = exactObject(value, ["version", "initial", "persistence", "states", "transitions"], "states.json");
  if (spec.version !== 1) throw new Error("states.json must have version 1.");
  if (spec.persistence !== "person" && spec.persistence !== "session") {
    throw new Error('states.json persistence must be "person" or "session".');
  }
  if (!Array.isArray(spec.states) || spec.states.length === 0 || spec.states.length > WIDGET_STATE_LIMITS.states) {
    throw new Error(`states.json must declare 1 to ${WIDGET_STATE_LIMITS.states} states.`);
  }
  let states: string[] = [];
  for (let state of spec.states) {
    let id = parseId(state, "A state");
    if (states.includes(id)) throw new Error(`State "${id}" is declared twice.`);
    states.push(id);
  }
  let initial = parseId(spec.initial, "The initial state");
  if (!states.includes(initial)) throw new Error(`The initial state "${initial}" is not a declared state.`);
  if (!Array.isArray(spec.transitions) || spec.transitions.length > WIDGET_STATE_LIMITS.transitions) {
    throw new Error(`states.json must declare at most ${WIDGET_STATE_LIMITS.transitions} transitions.`);
  }
  let transitions: WidgetTransition[] = [];
  let pairs = new Set<string>();
  for (let item of spec.transitions) {
    let t = exactObject(item, ["event", "from", "to"], "A transition");
    let event = parseId(t.event, "An event");
    // Reserved for a requested run's result on a page (FAC-116, canvas-model.ts), never a widget's own.
    if (event.startsWith("run-result-")) throw new Error(`Event "${event}" is reserved: "run-result-" names a run's result.`);
    let from = parseId(t.from, "A transition's from");
    let to = parseId(t.to, "A transition's to");
    for (let [end, id] of [["from", from], ["to", to]] as const) {
      if (!states.includes(id)) throw new Error(`Transition "${event}" ${end} "${id}" is not a declared state.`);
    }
    if (pairs.has(`${event} ${from}`)) throw new Error(`Event "${event}" is declared twice from state "${from}".`);
    pairs.add(`${event} ${from}`);
    transitions.push({ event, from, to });
  }
  let reached = new Set([initial]);
  for (let grew = true; grew;) {
    grew = false;
    for (let { from, to } of transitions) {
      if (reached.has(from) && !reached.has(to)) {
        reached.add(to);
        grew = true;
      }
    }
  }
  let unreachable = states.find(state => !reached.has(state));
  if (unreachable !== undefined) throw new Error(`State "${unreachable}" can't be reached from "${initial}".`);
  return { version: 1, initial, persistence: spec.persistence, states, transitions };
}

/** The events `machine` accepts in `state`, in declaration order. */
export function widgetEventsFrom(machine: WidgetStateMachine, state: string): string[] {
  return machine.transitions.filter(t => t.from === state).map(t => t.event);
}

/**
 * The state `event` moves `machine` to from `current`. Throws a `WidgetStateError` with
 * `unknownEvent` for an event the widget never declares and `notPermitted` for one it doesn't
 * accept in `current`, naming that state's accepted events. Pure: nothing changes on refusal.
 */
export function applyWidgetTransition(machine: WidgetStateMachine, current: string, event: unknown): string {
  if (typeof event !== "string" || !machine.transitions.some(t => t.event === event)) {
    throw new WidgetStateError(WIDGET_STATE_ERROR_CODES.unknownEvent, "This widget declares no such event.");
  }
  let transition = machine.transitions.find(t => t.event === event && t.from === current);
  if (!transition) {
    let accepted = widgetEventsFrom(machine, current);
    throw new WidgetStateError(WIDGET_STATE_ERROR_CODES.notPermitted,
        `Event "${event}" isn't permitted in state "${current}"` +
        (accepted.length ? `; it accepts ${accepted.map(e => `"${e}"`).join(", ")}.` : "; it accepts no events."));
  }
  return transition.to;
}

/**
 * The state to resume from `stored`: it when `machine` still declares it, else `initial`. A
 * published machine never changes, so a stored state from the same revision always resumes.
 */
export function recoverWidgetState(machine: WidgetStateMachine, stored: string | undefined): string {
  return stored !== undefined && machine.states.includes(stored) ? stored : machine.initial;
}

/** Most widget states one memory holds, as the user DO keeps: the oldest is dropped past it. */
export const MAX_HELD_WIDGET_STATES = 256;

/**
 * Widget states held in memory, for `session` persistence (one operate session connection). Every
 * method is synchronous, so a read, its `seq` check and the write happen with nothing between them.
 */
export class WidgetStateMemory {
  #held = new Map<string, { state: string; seq: number }>();

  /** The state of `key` under `machine`: the held one when the machine declares it, else initial. */
  read(key: string, machine: WidgetStateMachine): WidgetStateSnapshot {
    let held = this.#held.get(key);
    let state = recoverWidgetState(machine, held?.state);
    return { state, seq: held?.seq ?? 0, events: widgetEventsFrom(machine, state) };
  }

  /** Moves `key` by `event` if `expectedSeq` is current, in one synchronous step. */
  transition(key: string, machine: WidgetStateMachine, event: string, expectedSeq: number): WidgetStateSnapshot {
    let current = this.read(key, machine);
    if (expectedSeq !== current.seq) {
      throw new WidgetStateError(WIDGET_STATE_ERROR_CODES.conflict, "The widget's state changed. Read it again.");
    }
    let state = applyWidgetTransition(machine, current.state, event);
    this.#held.delete(key);
    this.#held.set(key, { state, seq: current.seq + 1 });
    if (this.#held.size > MAX_HELD_WIDGET_STATES) this.#held.delete(this.#held.keys().next().value!);
    return { state, seq: current.seq + 1, events: widgetEventsFrom(machine, state) };
  }
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`${what} must be a lowercase id of letters, digits and dashes, starting with a letter, at most 40 characters.`);
  }
  return value;
}

function exactObject(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  let extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra !== undefined) throw new Error(`${what} has a field it doesn't take.`);
  let missing = keys.find(key => !(key in value));
  if (missing !== undefined) throw new Error(`${what} is missing "${missing}".`);
  return value as Record<string, unknown>;
}

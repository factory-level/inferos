// Sticky chat taint (callable-widget contract §4.8.4-§4.8.5): once a chat's agent has read console
// tool output -- authored text that may carry a prompt injection -- the chat is marked for the rest
// of its life, and the Overseer's egress gates refuse every channel that could carry its context
// out: connections outside a first-party allowlist, gadget and worktree bindings, env.GIT, stubs
// delivered into the chat, new connection requests and webFetch. The mark lives in its own
// collection, not on `chatMeta`, which is rewritten wholesale at many sites; only deleting the chat
// (or the workspace) removes it.
//
// Nothing writes the mark yet: the console tools that will (callable-widget C6) do so at the start
// of each call, before any authored code runs. Until then every gate here is inert.

import { collection } from "@gadgets/typed-storage";
import type { OverseerStorage } from "./overseer";

/** A chat whose agent has read console tool output. Written once; removed only with the chat. */
export type ConsoleToolTaintRecord = {
  chatId: number;

  /** When the first console tool call in the chat started. */
  markedAt: Date;
};

/**
 * Typed-storage schema for the `consoleToolTaints` collection, keyed by chat id. Shared between
 * `makeOverseerStorage()` and tests so both bind the identical schema.
 */
export function consoleToolTaintsCollection() {
  return collection<ConsoleToolTaintRecord>()({primaryKey: "chatId"});
}

type TaintStorage = Pick<OverseerStorage, "consoleToolTaints">;

/** Whether chat `chatId` carries the console tool taint mark. */
export function isConsoleToolTainted(storage: TaintStorage, chatId: number): boolean {
  return storage.consoleToolTaints.get(chatId) !== undefined;
}

/**
 * Marks chat `chatId` as having read console tool output. Idempotent: the first mark's time is
 * kept. Called at the start of a console tool call, before the widget is invoked.
 */
export function markConsoleToolTainted(storage: TaintStorage, chatId: number): void {
  if (isConsoleToolTainted(storage, chatId)) return;
  storage.consoleToolTaints.put({chatId, markedAt: new Date()});
}

/**
 * The vendor ids of the first-party gatekeepers a tainted chat may still use: InferOps, the
 * Context Library and Scheduled Tasks. Admission is a review item: each neither sends agent input
 * to a third party nor persists or returns a caller's stubs (contract §4.8.5).
 */
export const TAINTED_CHAT_VENDOR_IDS: ReadonlySet<string> =
    new Set(["inferops", "context", "scheduler"]);

/**
 * Whether a connection with recorded vendor id `vendorId` (lowercased, as `gatekeeperVendorId`
 * returns it) may be used by a tainted chat's agent. A strict allowlist: a connection with no
 * recorded vendor -- the agent spawner, an AI model, a legacy record -- is refused.
 */
export function usableWhileTainted(vendorId: string | undefined): boolean {
  return vendorId !== undefined && TAINTED_CHAT_VENDOR_IDS.has(vendorId);
}

/**
 * How deep `dropStubsIfTainted` walks. Stored callback arguments are structured clones, so any
 * nesting is possible; a value below this depth is dropped (fail closed) rather than walked, so the
 * walk can neither exhaust the stack nor keep a capability it never looked at.
 */
export const STUB_WALK_MAX_DEPTH = 64;

/**
 * Measure B's walk: when `tainted`, returns `value` with every capability removed -- RPC stubs,
 * loopback service stubs, functions and any other non-data object -- so a stub minted elsewhere
 * (in another chat, or in this one before the mark) never reaches a tainted chat's executeCode.
 * Arrays and plain objects are walked, as `guardedResult` walks them; primitives, dates and binary
 * data are kept. A removed array element becomes `undefined` (so argument positions hold) and a
 * removed property is omitted. Structured clone keeps cycles, and agent code can store one through
 * `self.<method>()`, so an edge back to an ancestor is removed the same way, as is anything below
 * `STUB_WALK_MAX_DEPTH`. An object reached twice without a cycle is walked once, so a shared
 * reference cannot make the walk exponential. A `"__proto__"` key is copied as an own property,
 * never applied as a prototype. Returns `value` unchanged when not `tainted`.
 */
export function dropStubsIfTainted(value: unknown, tainted: boolean): unknown {
  return tainted ? withoutStubs(value, {ancestors: new Set(), walked: new Map()}, 0) : value;
}

type Walk = {
  /** The objects on the path to the current one: an edge back to one of them is a cycle. */
  ancestors: Set<object>;

  /** Each object already walked, with its result. */
  walked: Map<object, unknown>;
};

function withoutStubs(value: unknown, walk: Walk, depth: number): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (typeof value === "function") return undefined;
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  let isArray = Array.isArray(value);
  if (!isArray) {
    let prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
  }
  if (walk.walked.has(value)) return walk.walked.get(value);
  if (walk.ancestors.has(value) || depth >= STUB_WALK_MAX_DEPTH) return undefined;
  walk.ancestors.add(value);
  let result: unknown;
  if (isArray) {
    result = (value as unknown[]).map(item => withoutStubs(item, walk, depth + 1));
  } else {
    let kept: Record<string, unknown> = {};
    for (let [key, item] of Object.entries(value)) {
      let walked = withoutStubs(item, walk, depth + 1);
      if (walked !== undefined || item === undefined) {
        Object.defineProperty(kept, key,
            {value: walked, enumerable: true, writable: true, configurable: true});
      }
    }
    result = kept;
  }
  walk.ancestors.delete(value);
  walk.walked.set(value, result);
  return result;
}

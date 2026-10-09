// The isolated tool lane: runs one method of an authored widget's frozen code, once, for one
// caller, in a fresh dynamic Worker on a per-call facet that is deleted afterwards (see
// docs/architecture/operate-mode.md, "Isolated tool lane"). Internal to the kernel: nothing here is
// reachable from a client, and the overseer only wires its sweeps (startup and alarm). Discovery
// and invocation, with their authorization checks, are the caller's.
//
// - Isolation. Each call gets its own `LOADER.load()` (fresh module state), its own facet named
//   `tool-<randomUUID>` (fresh storage, keyed by name), `env: {}`, `globalOutbound: null`, no
//   tails, and `disallow_importable_env`.
// - Module graph. The kernel's `tool-main.js` imports the kernel's `tool-guard.js` first and the
//   authored `server.js` second. ES modules evaluate depth-first in import order, so the guard has
//   captured its intrinsics and frozen its runner before any authored module evaluates. The guard
//   bounds the envelope only: authored code still computes the value and can patch intrinsics the
//   guard does not own, so the tag proves nothing and the caller re-validates what comes back.
// - Return channel. The runner answers with a byte stream of one JSON envelope, `{t:"ok", v}` or
//   `{t:"err", m, len}` with `m` cut to 1 KiB in the isolate. The kernel reads it with a BYOB reader
//   into a fixed buffer of 16 KiB + 1 and cancels on overflow, so it keeps no more than that
//   whatever the isolate allocated. A thrown RPC error is reported as `threw`; its text is never
//   read.
// - Cleanup. The facet name is written to `pendingToolFacets` with the slot, synchronously, before
//   the facet exists. A call ends with `abort` then `delete`, after which the row becomes one of the
//   latest 256 tombstones. A row whose delete threw, or whose instance crashed, is swept: at
//   startup, before every new call, and from the alarm, at most 16 deletes per sweep, oldest first.
//   A row leaves the table only after a successful `delete`.
// - Limits. Not enforced locally: workerd does not interrupt CPU-bound code, so an authored spin
//   delays the deadline (and blocks this Durable Object, its siblings and other objects in the
//   process) until it ends, and nothing bounds the lane's memory. The deadline bounds asynchronous
//   waits only. `limits` is declared for production, where these bounds are remote checks.

import type { Collection, Singleton, UniqueIndex } from "@gadgets/typed-storage";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.tool-lane");

/** The lane's bounds. */
export const TOOL_LANE_LIMITS = {
  /** Calls running at once in one console workspace. */
  activeCalls: 4,
  /** Calls running at once for one caller. */
  activeCallsPerCaller: 1,
  /** Rows in `pendingToolFacets`: the active calls plus facets whose delete failed. */
  pendingRows: 64,
  /** Recently deleted facet names kept as tombstones, oldest dropped first. */
  tombstones: 256,
  /** Facet deletions one sweep attempts. */
  sweepDeletes: 16,
  /** The most envelope bytes the kernel keeps; one more byte refuses the result. */
  envelopeBytes: 16 * 1024,
  /** The most characters of authored error text an `err` envelope carries. */
  errorChars: 1024,
  /** The alarm's first retry delay while pending rows remain (provisional). */
  retryMs: 30_000,
  /** The alarm's longest retry delay after repeated failed deletes (provisional). */
  maxRetryMs: 300_000,
} as const;

/**
 * The lane's own module names. The lane adds them to every load, so a commit that contains either
 * is refused, here and (by the caller) at publish.
 */
export const TOOL_LANE_KERNEL_MODULES: readonly string[] = Object.freeze(["tool-main.js", "tool-guard.js"]);

/** The compatibility date tool code loads with, the same as a gadget's. */
const TOOL_COMPATIBILITY_DATE = "2026-02-01";

/** The authored module `tool-main.js` imports, the widget's own server module. */
const AUTHORED_MAIN = "server.js";

// The guard. It imports nothing authored and owns the runner: it captures every intrinsic it later
// uses at top level, then freezes the runner class, its prototype and each of its exports before
// its evaluation ends, which is before `server.js` begins. `attach` takes the authored namespace
// once; an authored module that calls it first makes `tool-main.js` throw, failing the load.
const TOOL_GUARD = `
import { DurableObject } from "cloudflare:workers";
const parse = JSON.parse;
const stringify = JSON.stringify;
const freeze = Object.freeze;
const ownNames = Object.getOwnPropertyNames;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const Stream = ReadableStream;
const encoder = new TextEncoder();
const encode = TextEncoder.prototype.encode;
const slice = String.prototype.slice;
const toText = String;
const ERROR_CHARS = ${TOOL_LANE_LIMITS.errorChars};
let authored;
function attach(namespace) {
  if (authored !== undefined) throw new Error("The tool lane is already attached.");
  authored = namespace;
}
function method(Gadget, name) {
  if (typeof Gadget !== "function" || typeof name !== "string" || name === "constructor") return undefined;
  const proto = Gadget.prototype;
  const names = ownNames(proto);
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== name) continue;
    const descriptor = ownDescriptor(proto, name);
    return descriptor && typeof descriptor.value === "function" ? descriptor.value : undefined;
  }
  return undefined;
}
function errorText(error) {
  try {
    const message = error !== null && typeof error === "object" ? error.message : error;
    return typeof message === "string" ? message : toText(message);
  } catch {
    return "The tool failed.";
  }
}
function envelope(value) {
  const bytes = apply(encode, encoder, [stringify(value)]);
  return new Stream({ type: "bytes", start(controller) { controller.enqueue(bytes); controller.close(); } });
}
class ToolRunner extends DurableObject {
  async __invoke(name, inputJson) {
    try {
      const Gadget = authored === undefined ? undefined : authored.Gadget;
      const fn = method(Gadget, name);
      if (fn === undefined) throw new Error("The widget has no such tool method.");
      const input = parse(inputJson);
      const value = await apply(fn, new Gadget(this.ctx, this.env), [input]);
      return envelope({ t: "ok", v: value === undefined ? null : value });
    } catch (error) {
      const message = errorText(error);
      return envelope({ t: "err", m: apply(slice, message, [0, ERROR_CHARS]), len: message.length });
    }
  }
}
freeze(ToolRunner.prototype);
freeze(ToolRunner);
freeze(attach);
export { ToolRunner, attach };
`;

// The main module: the guard first, the authored module second, and no code before or between.
const TOOL_MAIN = `
import { ToolRunner, attach } from "./tool-guard.js";
import * as authored from "./${AUTHORED_MAIN}";
attach(authored);
export { ToolRunner };
`;

/** A tool facet that may still exist, recorded before the facet is created. */
export interface PendingToolFacetRecord {
  /** The facet name, `tool-<randomUUID>`. */
  name: string;
  /** The user the call ran for. */
  callerUserId: string;
  /** When the slot was reserved (epoch ms). */
  startedAt: number;
  /** Always `pending`: a row is removed once its facet is deleted. */
  state: "pending";
  /** Failed deletes so far. */
  attempts: number;
}

/** A deleted tool facet's name, kept so that name is never reserved again within the window. */
export interface ToolFacetTombstoneRecord {
  /** Insertion order; the oldest is dropped past `TOOL_LANE_LIMITS.tombstones`. */
  seq: number;
  /** The deleted facet's name. */
  name: string;
}

/** What the lane needs from its console workspace's Durable Object. */
export interface ToolLanePorts {
  /** The workspace's facets: the lane creates, aborts and deletes only `tool-*` names. */
  facets: Pick<DurableObjectFacets, "get" | "abort" | "delete">;
  /** The Worker Loader each call loads its code through. */
  loader: WorkerLoader;
  /** Facets that may still exist, by name. */
  pending: Collection<PendingToolFacetRecord, string>;
  /** The latest deleted names, by insertion order, indexed by name. */
  tombstones: Collection<ToolFacetTombstoneRecord, number> & {
    byName: UniqueIndex<ToolFacetTombstoneRecord, string>;
  };
  /** The next tombstone's `seq`. */
  nextTombstoneSeq: Singleton<number>;
  /** Runs `fn` as one synchronous storage transaction. */
  transaction: (fn: () => void) => void;
  /** Called after the pending table changes, so the alarm can be recomputed. */
  pendingChanged: () => void;
  /** Mints a facet name's UUID. Defaults to `crypto.randomUUID`; tests replace it. */
  mintId?: () => string;
}

/** Why a slot was not reserved. */
export type ToolLaneRefusal =
  /** `TOOL_LANE_LIMITS.activeCalls` calls are running in this workspace. */
  | "busy"
  /** This caller already has a call running. */
  | "caller-busy"
  /** The pending table is full: cleanup is behind. */
  | "cleanup-behind"
  /** The minted name is pending or a recent tombstone; it is not re-minted. */
  | "name-collision";

/** Why a call produced no envelope. */
export type ToolLaneFailure =
  /** The commit contains one of `TOOL_LANE_KERNEL_MODULES`. */
  | "reserved-module"
  /** The commit has no `server.js`. */
  | "no-server-module"
  /** The deadline passed first. */
  | "deadline"
  /** The call threw over RPC (its text is not read). */
  | "threw"
  /** The call returned something other than a stream. */
  | "not-a-stream"
  /** The stream exceeded `TOOL_LANE_LIMITS.envelopeBytes`. */
  | "too-large"
  /** The bytes were not one well-formed envelope. */
  | "bad-envelope";

/**
 * A call's outcome. `ok` carries the authored value, which the caller must still check against
 * the tool's declared output: the envelope is not evidence of what ran.
 */
export type ToolLaneResult =
  | { status: "ok"; value: unknown }
  | { status: "error"; message: string; length: number }
  | { status: "failed"; reason: ToolLaneFailure };

/** What one sweep did. */
export interface ToolLaneSweep {
  /** Names whose facets were deleted. */
  deleted: string[];
  /** Names whose delete threw; they stay pending. */
  failed: string[];
  /** Pending rows left, live calls included. */
  remaining: number;
}

/** One code run on a reserved slot. */
export interface ToolLaneRequest {
  /** The frozen commit's `.js` files, by path; `server.js` exports the `Gadget` class. */
  modules: Record<string, string>;
  /** An own method of `Gadget.prototype`, already checked against the tool's declaration. */
  method: string;
  /** The tool input, as JSON text. */
  inputJson: string;
  /** When the call must end (epoch ms). */
  deadlineAt: number;
}

/**
 * A reserved slot: its facet name is recorded as pending, and the slot counts against the
 * workspace's and the caller's limits until `release()` (which `runIsolatedTool` calls).
 */
export class ToolLaneSlot {
  #released = false;

  constructor(readonly lane: ToolLane, readonly name: string, readonly callerUserId: string) {}

  /** Whether the slot has been released. */
  get released(): boolean { return this.#released; }

  /**
   * Aborts and deletes the facet, then frees the slot. A failed delete leaves the row pending for a
   * sweep. Idempotent.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.lane.cleanUp(this);
  }
}

/** One console workspace's tool lane: its slots, its pending facets and their sweeps. */
export class ToolLane {
  #ports: ToolLanePorts;
  // The names of this instance's live calls, with their callers. Lost on restart, which is what
  // lets the startup sweep treat every pending row as abandoned.
  #live = new Map<string, string>();
  // The alarm time while pending rows remain, set once and held so recomputes don't push it out.
  #retryAt: number | undefined;

  constructor(ports: ToolLanePorts) {
    this.#ports = ports;
  }

  /**
   * Reserves a slot for `callerUserId`, synchronously: sweeps first, then checks the limits, mints
   * the facet name and records it as pending, all before any facet exists.
   */
  reserve(callerUserId: string): ToolLaneSlot | { refused: ToolLaneRefusal } {
    this.sweep();
    if (this.#live.size >= TOOL_LANE_LIMITS.activeCalls) return { refused: "busy" };
    for (let caller of this.#live.values()) {
      if (caller === callerUserId) return { refused: "caller-busy" };
    }
    let { pending, tombstones } = this.#ports;
    if (this.#pendingCount() >= TOOL_LANE_LIMITS.pendingRows) return { refused: "cleanup-behind" };
    let name = `tool-${(this.#ports.mintId ?? (() => crypto.randomUUID()))()}`;
    if (pending.get(name) !== undefined || tombstones.byName.get(name) !== undefined) {
      logger.error("tool facet name collision refused", { event: "tool-lane.name.collision" });
      return { refused: "name-collision" };
    }
    pending.put({ name, callerUserId, startedAt: Date.now(), state: "pending", attempts: 0 });
    this.#live.set(name, callerUserId);
    this.#ports.pendingChanged();
    return new ToolLaneSlot(this, name, callerUserId);
  }

  /**
   * Deletes the facets of pending rows that are not live in this instance, oldest first, attempting
   * at most `TOOL_LANE_LIMITS.sweepDeletes`. A delete that throws counts an attempt and stays pending.
   */
  sweep(): ToolLaneSweep {
    let rows = Array.from(this.#ports.pending.list());
    let abandoned = rows.filter(row => !this.#live.has(row.name))
        .toSorted((a, b) => a.startedAt - b.startedAt || (a.name < b.name ? -1 : 1))
        .slice(0, TOOL_LANE_LIMITS.sweepDeletes);
    let result: ToolLaneSweep = { deleted: [], failed: [], remaining: rows.length };
    for (let row of abandoned) {
      if (this.#deleteFacet(row)) result.deleted.push(row.name);
      else result.failed.push(row.name);
    }
    result.remaining -= result.deleted.length;
    if (abandoned.length > 0) {
      this.#retryAt = undefined;
      this.#ports.pendingChanged();
    }
    return result;
  }

  /**
   * When the alarm should next sweep: while pending rows remain, 30 s from when this was first
   * asked, backing off to 5 min after repeated failed deletes; otherwise undefined.
   */
  nextSweepTime(): number | undefined {
    let attempts = -1;
    for (let row of this.#ports.pending.list()) attempts = Math.max(attempts, row.attempts);
    if (attempts < 0) {
      this.#retryAt = undefined;
      return undefined;
    }
    let delay = Math.min(TOOL_LANE_LIMITS.maxRetryMs, TOOL_LANE_LIMITS.retryMs * 2 ** Math.max(0, attempts - 1));
    return this.#retryAt ??= Date.now() + delay;
  }

  /** Ends a slot's call: abort, delete, tombstone, free. Called by `ToolLaneSlot.release()` only. */
  cleanUp(slot: ToolLaneSlot): void {
    try {
      let row = this.#ports.pending.get(slot.name);
      if (row !== undefined) this.#deleteFacet(row);
    } finally {
      this.#live.delete(slot.name);
      this.#ports.pendingChanged();
    }
  }

  /** Loads a call's code: the kernel modules around the authored ones, with no capabilities. */
  load(modules: Record<string, string>): WorkerStub {
    return this.#ports.loader.load({
      compatibilityDate: TOOL_COMPATIBILITY_DATE,
      compatibilityFlags: ["disallow_importable_env"],
      mainModule: "tool-main.js",
      modules: { ...modules, "tool-main.js": TOOL_MAIN, "tool-guard.js": TOOL_GUARD },
      env: {},
      globalOutbound: null,
      // Declared for production only: local workerd enforces neither.
      limits: { cpuMs: 100, subRequests: 0 },
    });
  }

  /** The tool facet for a live slot. */
  facet(slot: ToolLaneSlot, worker: WorkerStub): Fetcher<ToolRunnerRpc> {
    return this.#ports.facets.get<ToolRunnerRpc>(slot.name, () => ({
      class: worker.getDurableObjectClass<ToolRunnerRpc>("ToolRunner"),
    }));
  }

  /** Aborts the facet of a live slot, ending any call in it. */
  abort(slot: ToolLaneSlot, reason: string): void {
    this.#ports.facets.abort(slot.name, new Error(reason));
  }

  #pendingCount(): number {
    return Array.from(this.#ports.pending.list({ limit: TOOL_LANE_LIMITS.pendingRows })).length;
  }

  // Aborts then deletes one row's facet. On success the row becomes a tombstone; on failure it
  // stays pending with one more attempt.
  #deleteFacet(row: PendingToolFacetRecord): boolean {
    let { facets, pending, tombstones, nextTombstoneSeq } = this.#ports;
    try {
      facets.abort(row.name, new Error("The tool call ended."));
      facets.delete(row.name);
    } catch (error) {
      pending.put({ ...row, attempts: row.attempts + 1 });
      logger.warn("tool facet delete failed; left pending", {
        event: "tool-lane.delete.failed", error,
      });
      return false;
    }
    this.#ports.transaction(() => {
      pending.delete(row.name);
      let seq = nextTombstoneSeq.get();
      nextTombstoneSeq.put(seq + 1);
      tombstones.put({ seq, name: row.name });
      if (seq >= TOOL_LANE_LIMITS.tombstones) tombstones.delete(seq - TOOL_LANE_LIMITS.tombstones);
    });
    return true;
  }
}

/** The runner's RPC surface, as the kernel calls it. */
interface ToolRunnerRpc extends Rpc.DurableObjectBranded {
  __invoke(method: string, inputJson: string): ReadableStream<Uint8Array>;
}

/**
 * Runs `request` on `slot` and releases the slot once its facet is cleaned up, whatever the
 * outcome. The call races `request.deadlineAt`; at the deadline the facet is aborted, which ends
 * asynchronous waits but not CPU-bound code (see the module comment).
 */
export async function runIsolatedTool(slot: ToolLaneSlot, request: ToolLaneRequest): Promise<ToolLaneResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (slot.released) throw new Error("The tool slot was already released.");
    if (Object.keys(request.modules).some(path => TOOL_LANE_KERNEL_MODULES.includes(path))) {
      return { status: "failed", reason: "reserved-module" };
    }
    if (typeof request.modules[AUTHORED_MAIN] !== "string") {
      return { status: "failed", reason: "no-server-module" };
    }
    let lane = slot.lane;
    let call = (async (): Promise<ToolLaneResult> => {
      let returned: unknown;
      try {
        returned = await lane.facet(slot, lane.load(request.modules)).__invoke(request.method, request.inputJson);
      } catch {
        return { status: "failed", reason: "threw" };
      }
      return await readToolEnvelope(returned);
    })();
    let deadline = new Promise<ToolLaneResult>(resolve => {
      timer = setTimeout(() => {
        lane.abort(slot, "The tool call reached its deadline.");
        resolve({ status: "failed", reason: "deadline" });
      }, Math.max(0, request.deadlineAt - Date.now()));
    });
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
    slot.release();
  }
}

/**
 * Reads one tool envelope from an RPC result: a stream, read with a BYOB reader into a buffer of
 * `TOOL_LANE_LIMITS.envelopeBytes + 1` bytes and cancelled on overflow, holding UTF-8 JSON that is
 * exactly `{t: "ok", v}` or `{t: "err", m, len}` with `m` at most `TOOL_LANE_LIMITS.errorChars`.
 */
export async function readToolEnvelope(returned: unknown): Promise<ToolLaneResult> {
  if (!(returned instanceof ReadableStream)) {
    try { (returned as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.(); } catch {}
    return { status: "failed", reason: "not-a-stream" };
  }
  let capacity = TOOL_LANE_LIMITS.envelopeBytes + 1;
  let buffer = new ArrayBuffer(capacity);
  let filled = 0;
  let reader: ReadableStreamBYOBReader;
  try {
    reader = returned.getReader({ mode: "byob" });
  } catch {
    returned.cancel().catch(() => {});
    return { status: "failed", reason: "not-a-stream" };
  }
  try {
    for (;;) {
      let { done, value } = await reader.read(new Uint8Array(buffer, filled, capacity - filled));
      if (value !== undefined) {
        buffer = value.buffer as ArrayBuffer;
        filled += value.byteLength;
      }
      if (filled >= capacity) {
        reader.cancel("The tool result is too large.").catch(() => {});
        return { status: "failed", reason: "too-large" };
      }
      if (done) break;
    }
  } catch {
    return { status: "failed", reason: "threw" };
  }
  return parseEnvelope(new Uint8Array(buffer, 0, filled));
}

function parseEnvelope(bytes: Uint8Array): ToolLaneResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { status: "failed", reason: "bad-envelope" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "failed", reason: "bad-envelope" };
  }
  let record = parsed as Record<string, unknown>;
  let keys = Object.keys(record).toSorted().join(",");
  if (record.t === "ok" && keys === "t,v") return { status: "ok", value: record.v };
  if (record.t === "err" && keys === "len,m,t" && typeof record.m === "string" &&
      record.m.length <= TOOL_LANE_LIMITS.errorChars && Number.isSafeInteger(record.len) &&
      (record.len as number) >= record.m.length) {
    return { status: "error", message: record.m, length: record.len as number };
  }
  return { status: "failed", reason: "bad-envelope" };
}

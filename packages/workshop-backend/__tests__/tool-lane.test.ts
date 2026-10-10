// The isolated tool lane (src/tool-lane.ts), run for real: the Worker Loader, facets and RPC of a
// real OverseerDurableObject. These are the callable-widget spike's cases made permanent, each
// with trusted, bounded, synthetic fixtures only (CI logs are readable by anyone with repository
// access, and workerd prints authored logs and caught RPC errors to its own output).
//
// NOT RUN, by design: CPU-bound and wedge cases. Local workerd does not interrupt CPU-bound
// authored code. A spin in a tool method, a constructor, a serialization getter or a loaded
// entrypoint delays the deadline until it ends and blocks this Durable Object, its sibling facets,
// other objects in the process and the test runner with it; a `while (true)` wedges the runner so
// that no vitest timeout fires (spike case 1, `c1-*.log`). Those bounds are production checks
// (MVP-35). Every "stuck tool" here is an asynchronous wait, which the deadline does abort.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RESERVED_TOOL_MODULES } from "@gadgets/workshop-shared/widget-tools";
import {
  readToolEnvelope, runIsolatedTool, ToolLane, TOOL_LANE_KERNEL_MODULES, TOOL_LANE_LIMITS, type ToolLaneResult,
  type ToolLaneSlot,
} from "../src/tool-lane.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures: synthetic authored widgets. Each exports `Gadget`, as a widget's server.js does.

const TOOLS = `
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
let seen = [];
export class Gadget extends DurableObject {
  echo(input) { return { echo: input }; }
  nothing() {}
  async remember(input) {
    seen.push(input.sentinel);
    globalThis.__seen = (globalThis.__seen ?? []).concat(input.sentinel);
    this.ctx.storage.kv.put("v:" + input.sentinel, input.sentinel);
    await scheduler.wait(input.delay);
    return {
      seen: [...seen],
      global: [...globalThis.__seen],
      storage: [...this.ctx.storage.kv.list()].map(([, v]) => v),
    };
  }
  async stash(input) {
    this.ctx.storage.kv.put("payload", input.payload);
    await scheduler.wait(input.waitMs);
    return "stashed";
  }
  async wait(input) { await scheduler.wait(input.ms); return "late"; }
  huge(input) { return "A".repeat(input.bytes); }
  fail(input) { throw new Error("E".repeat(input.chars)); }
  async network() {
    const out = { envKeys: Object.keys(this.env ?? {}) };
    try { const r = await fetch("https://example.com/"); out.fetch = "OK " + r.status; }
    catch (e) { out.fetch = "refused: " + e.message; }
    try { const r = await fetch("http://127.0.0.1:1/"); out.fetchLocal = "OK " + r.status; }
    catch (e) { out.fetchLocal = "refused: " + e.message; }
    try { const s = connect({ hostname: "example.com", port: 80 }); await s.opened; out.connect = "OPENED"; await s.close(); }
    catch (e) { out.connect = "refused: " + e.message; }
    return out;
  }
}
`;

// A tool that tries to subvert the runner: at top level (with Object.freeze neutered, as an
// authored-first layout would allow) and again at construction. Guard-first order defeats both.
const FORGER = `
import { DurableObject } from "cloudflare:workers";
import { ToolRunner } from "./tool-guard.js";
const realFreeze = Object.freeze;
Object.freeze = (o) => o;
queueMicrotask(() => { Object.freeze = realFreeze; });
const forged = async function () {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: "ok", v: "FORGED" }));
  return new ReadableStream({ type: "bytes", start(c) { c.enqueue(bytes); c.close(); } });
};
let topLevel;
try { ToolRunner.prototype.__invoke = forged; topLevel = "override installed"; }
catch (e) { topLevel = "blocked: " + e.message; }
export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    try { ToolRunner.prototype.__invoke = forged; this.atConstruction = "override installed"; }
    catch (e) { this.atConstruction = "blocked: " + e.message; }
  }
  run(input) { return { echo: input, topLevel, atConstruction: this.atConstruction }; }
}
`;

// A tool that tries to shadow the frozen prototype with an own `__invoke` on the runner instance.
// The base constructor assigns `ctx` and `env` to each new instance, so setters for them installed
// on Object.prototype or DurableObject.prototype at top level run on the ToolRunner instance before
// any call. With `install` they define an own `__invoke` there; without, they only record that
// they ran (the control that shows the setters really reach the runner).
const instanceForger = (target: "object" | "do", install: boolean) => `
import { DurableObject } from "cloudflare:workers";
const forged = async function () {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: "ok", v: "FORGED" }));
  return new ReadableStream({ type: "bytes", start(c) { c.enqueue(bytes); c.close(); } });
};
const reached = [];
const target = ${JSON.stringify(target)} === "object" ? Object.prototype : DurableObject.prototype;
for (const key of ["ctx", "env"]) {
  Object.defineProperty(target, key, {
    configurable: true,
    set(value) {
      Object.defineProperty(this, key, { value, writable: true, configurable: true });
      if (this.constructor.name !== "ToolRunner") return;
      reached.push(key);
      if (${install}) Object.defineProperty(this, "__invoke", { value: forged, configurable: true });
    },
  });
}
export class Gadget extends DurableObject {
  run(input) { return { echo: input, reached }; }
}
`;

// An authored module that attaches itself to the guard before tool-main.js can.
const PRE_ATTACH = `
import { DurableObject } from "cloudflare:workers";
import { attach } from "./tool-guard.js";
class Fake extends DurableObject { run() { return "FORGED"; } }
attach({ Gadget: Fake });
export class Gadget extends DurableObject { run() { return "genuine"; } }
`;

// Reads a facet's storage, and writes to it, without running tool code.
const STORE = `
import { DurableObject } from "cloudflare:workers";
export class Store extends DurableObject {
  put(k, v) { this.ctx.storage.kv.put(k, v); return true; }
  dump() { return [...this.ctx.storage.kv.list()]; }
}
`;

// Spike case 3: a parent facet that owns a child facet and hands out stubs to it.
const PARENT = `
import { DurableObject, RpcTarget } from "cloudflare:workers";
export class Child extends DurableObject {
  put(k, v) { this.ctx.storage.kv.put(k, v); return true; }
  dump() { return [...this.ctx.storage.kv.list()]; }
}
class ChildWrapper extends RpcTarget {
  constructor(child) { super(); this.child = child; }
  put(k, v) { return this.child.put(k, v); }
  dump() { return this.child.dump(); }
}
export class Parent extends DurableObject {
  child() { return this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child })); }
  childWrapper() { return new ChildWrapper(this.child()); }
  async childPut(k, v) { return await this.child().put(k, v); }
  async childDump() { return await this.child().dump(); }
}
`;

// Spike case 5: return values that are not tool envelopes, from a plain loaded entrypoint.
const RETURNS = `
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
class Thing extends RpcTarget { hello() { return "hi"; } }
export default class extends WorkerEntrypoint {
  hugeChunk(bytes) {
    let sent = false;
    return new ReadableStream({ type: "bytes", pull(c) {
      if (sent) return c.close();
      sent = true;
      c.enqueue(new Uint8Array(bytes).fill(65));
    } });
  }
  notStream(kind) {
    if (kind === "object") return { getReader() { return "fake"; } };
    if (kind === "function") return () => "a function";
    if (kind === "stub") return new Thing();
    if (kind === "string") return "a string";
    if (kind === "response") return new Response("body");
  }
}
`;

// Spike case 5's layout controls: a harness around an authored class in three module orders.
// Only the ordered one (guard evaluated and frozen before authored code) resists the override.
function harnessLayout(layout: "unprotected" | "freeze-after-import" | "ordered-freeze"): Record<string, string> {
  const authored = `
import * as H from "./guard.js";
const realFreeze = Object.freeze;
Object.freeze = (o) => o;
queueMicrotask(() => { Object.freeze = realFreeze; });
export class Program {
  constructor() {
    try {
      const orig = H.Harness.prototype.__invoke;
      H.Harness.prototype.__invoke = async function (input) { return { ...(await orig.call(this, input)), value: "FORGED" }; };
    } catch {}
  }
  run(input) { return input; }
}
`;
  const harness = `
let Program;
export function register(P) { Program = P; }
export class Harness extends WorkerEntrypoint {
  async __invoke(input) { return { ok: true, value: await new Program().run(input) }; }
}
`;
  if (layout === "ordered-freeze") {
    return {
      "main.js": `import { Harness, register } from "./guard.js";\nimport { Program } from "./authored.js";\nregister(Program);\nexport { Harness };\n`,
      "guard.js": `import { WorkerEntrypoint } from "cloudflare:workers";\n${harness}\nObject.freeze(Harness.prototype); Object.freeze(Harness);\n`,
      "authored.js": authored,
    };
  }
  const freeze = layout === "freeze-after-import" ? "Object.freeze(Harness.prototype); Object.freeze(Harness);" : "";
  return {
    "main.js": `export { Harness } from "./guard.js";\n`,
    "guard.js": `import { WorkerEntrypoint } from "cloudflare:workers";\nimport { Program as P } from "./authored.js";\n${harness}\nregister(P);\n${freeze}\n`,
    "authored.js": authored,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers.

type Impl = {
  toolLane: ToolLane;
  storage: any;
  runAlarmTasks(): Promise<void>;
};

let doCounter = 0;
const workspaceName = () => `tool-lane-${++doCounter}-${crypto.randomUUID()}`;

/** Runs `fn` inside the console workspace Durable Object named `name` (a fresh one by default). */
function inWorkspace<T>(fn: (impl: Impl, state: DurableObjectState) => Promise<T>, name = workspaceName()): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), (instance: OverseerDurableObject, state: DurableObjectState) =>
    fn((instance as unknown as { impl: Impl }).impl, state));
}

function loaderCode(modules: Record<string, string>, mainModule = Object.keys(modules)[0]): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: "2026-02-01",
    compatibilityFlags: ["disallow_importable_env"],
    mainModule,
    modules,
    env: {},
    globalOutbound: null,
  };
}

interface TestLaneOptions {
  /** Makes `facets.delete` (and, if set, `facets.abort`) throw while set. */
  faults?: { deleteThrows: boolean; abortThrows?: boolean };
  /** Records every name `facets.get` is asked for. */
  gets?: string[];
  mintId?: () => string;
}

/**
 * A second lane over the workspace's own tables (a stand-in for a restarted instance: it shares
 * the storage but none of the live calls), with facets that record gets and can fail deletes.
 */
function testLane(impl: Impl, state: DurableObjectState, options: TestLaneOptions = {}): ToolLane {
  let faults = options.faults ?? { deleteThrows: false };
  return new ToolLane({
    facets: {
      get: ((name: string, startup: any) => { options.gets?.push(name); return state.facets.get(name, startup); }) as DurableObjectFacets["get"],
      abort: (name, reason) => {
        if (faults.abortThrows) throw new Error("injected facets.abort failure");
        state.facets.abort(name, reason);
      },
      delete: name => {
        if (faults.deleteThrows) throw new Error("injected facets.delete failure");
        state.facets.delete(name);
      },
    },
    loader: env.LOADER,
    pending: impl.storage.pendingToolFacets,
    tombstones: impl.storage.toolFacetTombstones,
    nextTombstoneSeq: impl.storage.nextToolFacetTombstoneSeq,
    transaction: fn => impl.storage.transaction(fn),
    pendingChanged: () => {},
    mintId: options.mintId,
  });
}

function reserved(lane: ToolLane, caller: string): ToolLaneSlot {
  let slot = lane.reserve(caller);
  if (!("name" in slot)) throw new Error(`slot refused: ${slot.refused}`);
  return slot;
}

// Runs `request` on `slot`, then releases the slot as the kernel's caller does once it is done.
async function run(slot: ToolLaneSlot, request: Parameters<typeof runIsolatedTool>[1]): Promise<ToolLaneResult> {
  try {
    return await runIsolatedTool(slot, request);
  } finally {
    slot.release();
  }
}

function call(slot: ToolLaneSlot, method: string, input: unknown = {}, options: { server?: string; deadlineMs?: number } = {}): Promise<ToolLaneResult> {
  return run(slot, {
    modules: { "server.js": options.server ?? TOOLS },
    method,
    inputJson: JSON.stringify(input),
    deadlineAt: Date.now() + (options.deadlineMs ?? 4_000),
  });
}

/** Reads a facet's storage by name, without running tool code (and stops whatever is running). */
async function peek(state: DurableObjectState, name: string): Promise<unknown[]> {
  state.facets.abort(name, new Error("peek"));
  let facet = state.facets.get<any>(name, () => ({
    class: storeClass(),
  }));
  let contents = await facet.dump();
  state.facets.abort(name, new Error("peek done"));
  return contents;
}

/** Writes an abandoned pending row, as a crashed instance or a failed delete leaves one. */
function abandonedRow(impl: Impl, startedAt: number, attempts = 0): string {
  let name = `tool-${crypto.randomUUID()}`;
  impl.storage.pendingToolFacets.put({ name, callerUserId: "someone", startedAt, state: "pending", attempts });
  return name;
}

const pendingNames = (impl: Impl) => Array.from(impl.storage.pendingToolFacets.list(), (row: any) => row.name as string);

/**
 * The error an RPC call fails with, or undefined if it succeeds. Awaited directly: `expect().rejects`
 * would read further properties of the RPC promise, and each read pipelines another call.
 */
async function failure(rpc: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await rpc();
    return undefined;
  } catch (error) {
    return String(error);
  }
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parentClass = () => env.LOADER.load(loaderCode({ "p.js": PARENT })).getDurableObjectClass<any>("Parent");
const storeClass = () => env.LOADER.load(loaderCode({ "store.js": STORE })).getDurableObjectClass<any>("Store");

function streamOf(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({ type: "bytes", start(c) { c.enqueue(bytes); c.close(); } });
}

// ---------------------------------------------------------------------------------------------

describe("TOOL_LANE_KERNEL_MODULES", () => {
  it("is the publish-time RESERVED_TOOL_MODULES, so publish refuses every name the lane adds", () => {
    expect(TOOL_LANE_KERNEL_MODULES).toEqual(RESERVED_TOOL_MODULES);
  });
});

describe("tool lane: results and envelopes", () => {
  it("returns an ok envelope's value, and frees the slot and the facet", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let slot = reserved(lane, "u1");
    expect(pendingNames(impl)).toEqual([slot.name]);
    expect(await call(slot, "echo", { n: 1 })).toEqual({ status: "ok", value: { echo: { n: 1 } } });
    expect(await call(reserved(lane, "u1"), "nothing")).toEqual({ status: "ok", value: null });
    expect(slot.released).toBe(true);
    expect(pendingNames(impl)).toEqual([]);
    expect(impl.storage.toolFacetTombstones.byName.get(slot.name)).toBeDefined();
  }));

  it("reports an authored throw as an err envelope cut to 1 KiB in the isolate", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    expect(await call(reserved(lane, "u1"), "fail", { chars: 10 }))
        .toEqual({ status: "error", message: "E".repeat(10), length: 10 });
    // Spike c5.bigError: a 5 MB message crosses RPC in full if thrown; the guard caps it first.
    let big = await call(reserved(lane, "u1"), "fail", { chars: 5 * 1024 * 1024 });
    expect(big).toEqual({ status: "error", message: "E".repeat(TOOL_LANE_LIMITS.errorChars), length: 5 * 1024 * 1024 });
  }));

  it("refuses a method that is not an own function of Gadget.prototype", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    for (let method of ["constructor", "missing", "toString", "__invoke"]) {
      let message = "The widget has no such tool method.";
      expect(await call(reserved(lane, "u1"), method)).toEqual({ status: "error", message, length: message.length });
    }
  }));

  it("refuses a commit with a kernel module name or without server.js, before loading", () => inWorkspace(async (impl, state) => {
    let gets: string[] = [];
    let lane = testLane(impl, state, { gets });
    for (let kernel of ["tool-main.js", "tool-guard.js"]) {
      let slot = reserved(lane, "u1");
      expect(await run(slot, {
        modules: { "server.js": TOOLS, [kernel]: "export {};" }, method: "echo", inputJson: "{}", deadlineAt: Date.now() + 4_000,
      })).toEqual({ status: "failed", reason: "reserved-module" });
    }
    expect(await run(reserved(lane, "u1"), {
      modules: { "main.js": TOOLS }, method: "echo", inputJson: "{}", deadlineAt: Date.now() + 4_000,
    })).toEqual({ status: "failed", reason: "no-server-module" });
    expect(gets).toEqual([]);
    expect(pendingNames(impl)).toEqual([]);
  }));

  it("refuses module paths that are not plain relative .js paths, before loading", () => inWorkspace(async (impl, state) => {
    let gets: string[] = [];
    let lane = testLane(impl, state, { gets });
    for (let path of ["./tool-guard.js", "./tool-main.js", "lib//x.js", "lib/./x.js", "../x.js", "/x.js", "x.cjs", "x.wasm", "x.py", "lib/"]) {
      expect(await run(reserved(lane, "u1"), {
        modules: { "server.js": TOOLS, [path]: "export {};" }, method: "echo", inputJson: "{}", deadlineAt: Date.now() + 4_000,
      }), path).toEqual({ status: "failed", reason: "invalid-module" });
    }
    expect(gets).toEqual([]);
    // A nested plain path is an ordinary authored module.
    expect(await run(reserved(lane, "u1"), {
      modules: { "server.js": `export { Gadget } from "./lib/gadget.js";`, "lib/gadget.js": TOOLS },
      method: "echo", inputJson: "1", deadlineAt: Date.now() + 4_000,
    })).toEqual({ status: "ok", value: { echo: 1 } });
  }));

  it("caps a huge first chunk at 16 KiB + 1 (spike c5.huge)", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    expect(await call(reserved(lane, "u1"), "huge", { bytes: 8 * 1024 * 1024 }))
        .toEqual({ status: "failed", reason: "too-large" });
    // The cap is the reader's: an envelope just under it passes.
    let fits = await call(reserved(lane, "u1"), "huge", { bytes: TOOL_LANE_LIMITS.envelopeBytes - 20 });
    expect(fits.status).toBe("ok");

    let ep = env.LOADER.load(loaderCode({ "r.js": RETURNS })).getEntrypoint<any>();
    expect(await readToolEnvelope(await ep.hugeChunk(8 * 1024 * 1024))).toEqual({ status: "failed", reason: "too-large" });
  }));

  it("refuses a return that is not a stream (spike c5.notStream)", async () => {
    let ep = env.LOADER.load(loaderCode({ "r.js": RETURNS })).getEntrypoint<any>();
    for (let kind of ["object", "function", "stub", "string", "response"]) {
      expect(await readToolEnvelope(await ep.notStream(kind)), kind).toEqual({ status: "failed", reason: "not-a-stream" });
    }
    expect(await readToolEnvelope(undefined)).toEqual({ status: "failed", reason: "not-a-stream" });
  });

  it("refuses bytes that are not exactly one envelope", async () => {
    for (let bad of [
      encode({ t: "ok", v: 1, extra: true }),
      encode({ t: "ok" }),
      encode({ t: "err", m: "x".repeat(TOOL_LANE_LIMITS.errorChars + 1), len: 2_000 }),
      encode({ t: "err", m: "short", len: 1 }),
      encode({ t: "other", v: 1 }),
      encode([1]),
      new Uint8Array([0x7b, 0xff, 0x7d]),
    ]) {
      expect(await readToolEnvelope(streamOf(bad))).toEqual({ status: "failed", reason: "bad-envelope" });
    }
    expect(await readToolEnvelope(streamOf(encode({ t: "ok", v: [1] })))).toEqual({ status: "ok", value: [1] });
  });
});

describe("tool lane: module graph (spike case 5)", () => {
  it("guard-first order defeats a top-level and a constructor-time __invoke override", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let result = await call(reserved(lane, "u1"), "run", { n: 7 }, { server: FORGER });
    expect(result.status).toBe("ok");
    let value = (result as { value: any }).value;
    expect(value.echo).toEqual({ n: 7 });
    expect(value.topLevel).toMatch(/^blocked: /);
    expect(value.atConstruction).toMatch(/^blocked: /);
  }));

  it("an own __invoke on the runner instance, set from a ctx/env setter, fails the call rather than forging it", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    for (let target of ["object", "do"] as const) {
      // Control: the setters run on the runner instance itself.
      expect(await call(reserved(lane, "u1"), "run", 1, { server: instanceForger(target, false) }), target)
          .toEqual({ status: "ok", value: { echo: 1, reached: ["ctx", "env"] } });
      // workerd dispatches RPC only to prototype methods: an own `__invoke` makes it refuse the call
      // ("The RPC receiver does not implement the method"), which the lane reports as `threw`.
      expect(await call(reserved(lane, "u1"), "run", 1, { server: instanceForger(target, true) }), target)
          .toEqual({ status: "failed", reason: "threw" });
    }
  }));

  it("an authored module that attaches itself first fails the load instead of substituting", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    expect(await call(reserved(lane, "u1"), "run", {}, { server: PRE_ATTACH })).toEqual({ status: "failed", reason: "threw" });
    expect(pendingNames(impl)).toEqual([]);
  }));

  it("CONTROL: only the ordered-freeze layout resists the override", async () => {
    let forgedBy: Record<string, boolean> = {};
    for (let layout of ["unprotected", "freeze-after-import", "ordered-freeze"] as const) {
      let worker = env.LOADER.load(loaderCode(harnessLayout(layout), "main.js"));
      let values = [];
      for (let i = 0; i < 2; i++) values.push((await worker.getEntrypoint<any>("Harness").__invoke(`in-${i}`)).value);
      forgedBy[layout] = values.includes("FORGED");
    }
    expect(forgedBy).toEqual({ "unprotected": true, "freeze-after-import": true, "ordered-freeze": false });
  });
});

describe("tool lane: isolation", () => {
  it("blocks outbound fetch and connect, with an empty env", () => inWorkspace(async (impl, state) => {
    let result = await call(reserved(testLane(impl, state), "u1"), "network");
    expect(result.status).toBe("ok");
    let value = (result as { value: any }).value;
    expect(value.envKeys).toEqual([]);
    expect(value.fetch).toMatch(/^refused: /);
    expect(value.fetchLocal).toMatch(/^refused: /);
    expect(value.connect).toMatch(/^refused: /);
  }));

  it("concurrent callers see only their own globals and storage, during and after (spike case 2)", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let callers = Array.from({ length: TOOL_LANE_LIMITS.activeCalls }, (_, i) => `caller-${i}`);
    let foreign = await Promise.all(callers.map(async caller => {
      let count = 0;
      for (let round = 0; round < 3; round++) {
        let sentinel = `${caller}-${round}-${crypto.randomUUID().slice(0, 8)}`;
        let result = await call(reserved(lane, caller), "remember", { sentinel, delay: Math.floor(Math.random() * 25) });
        let value = (result as { value: any }).value;
        for (let seen of [...value.seen, ...value.global, ...value.storage]) if (seen !== sentinel) count++;
        expect([value.seen.length, value.global.length, value.storage.length]).toEqual([1, 1, 1]);
      }
      return count;
    }));
    expect(foreign).toEqual([0, 0, 0, 0]);
    expect(pendingNames(impl)).toEqual([]);
  }));

  it("CONTROL: one shared facet and load leaks across callers (the detector fires)", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let worker = lane.load({ "server.js": TOOLS });
    let shared = state.facets.get<any>("control-shared", () => ({ class: worker.getDurableObjectClass<any>("ToolRunner") }));
    let results = await Promise.all([0, 1, 2, 3].map(async i =>
      await readToolEnvelope(await shared.__invoke("remember", JSON.stringify({ sentinel: `c${i}`, delay: 10 })))));
    let foreign = results.map(r => (r as { value: any }).value.storage.length - 1);
    expect(foreign.some(n => n > 0)).toBe(true);
    state.facets.abort("control-shared", new Error("control done"));
    state.facets.delete("control-shared");
  }));

  it("old descendant stubs fail after the lane deletes the facet, and after the name is recreated (spike case 3)", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let slot = reserved(lane, "u1");
    let parent = state.facets.get<any>(slot.name, () => ({ class: parentClass() }));
    await parent.childPut("v", "old");
    let wrapper = await parent.childWrapper();
    expect(await wrapper.dump()).toEqual([["v", "old"]]);  // the stale-stub detector reads while live

    slot.release();
    expect(await failure(() => wrapper.dump())).toBeDefined();
    expect(await failure(() => parent.childDump())).toBeDefined();

    let recreated = state.facets.get<any>(slot.name, () => ({ class: parentClass() }));
    expect(await recreated.childDump()).toEqual([]);
    await recreated.childPut("v", "new");
    expect(await failure(() => wrapper.dump())).toBeDefined();
    expect(await failure(() => wrapper.put("late", "write"))).toBeDefined();
    expect(await recreated.childDump()).toEqual([["v", "new"]]);
    state.facets.abort(slot.name, new Error("done"));
    state.facets.delete(slot.name);
  }));
});

describe("tool lane: facet names", () => {
  it("mints a distinct tool-<uuid> name per call", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let names = new Set<string>();
    for (let i = 0; i < 3; i++) {
      let slot = reserved(lane, "u1");
      expect(slot.name).toMatch(/^tool-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      names.add(slot.name);
      await call(slot, "echo");
    }
    expect(names.size).toBe(3);
  }));

  it("refuses a minted name that is pending or tombstoned, before facets.get, and never re-mints", () => inWorkspace(async (impl, state) => {
    let gets: string[] = [];
    let minted = 0;
    let stubbed: string | undefined;
    let lane = testLane(impl, state, { gets, mintId: () => { minted++; return stubbed ?? crypto.randomUUID(); } });
    let done = reserved(lane, "u1");
    await call(done, "echo");
    let live = reserved(lane, "u2");

    for (let recorded of [done.name, live.name]) {
      gets.length = 0;
      minted = 0;
      stubbed = recorded.slice("tool-".length);
      expect(lane.reserve("u3")).toEqual({ refused: "name-collision" });
      expect(minted).toBe(1);
      expect(gets).toEqual([]);
    }
    expect(pendingNames(impl)).toEqual([live.name]);
    live.release();
  }));

  it("keeps the latest 256 tombstones, oldest dropped first", () => inWorkspace(async (impl, state) => {
    let next = 0;
    let lane = testLane(impl, state, { mintId: () => `fifo-${next++}` });
    for (let i = 0; i <= TOOL_LANE_LIMITS.tombstones; i++) reserved(lane, "u1").release();
    expect(impl.storage.toolFacetTombstones.byName.get("tool-fifo-0")).toBeUndefined();
    expect(impl.storage.toolFacetTombstones.byName.get("tool-fifo-1")).toBeDefined();
    // The window is all the tombstones guarantee: a name older than it is accepted again.
    next = 0;
    expect("name" in lane.reserve("u1")).toBe(true);
    next = 1;
    expect(lane.reserve("u2")).toEqual({ refused: "name-collision" });
  }));

  it("CONTROL: reusing a facet name reattaches its storage", () => inWorkspace(async (impl, state) => {
    let name = "control-reuse";
    await state.facets.get<any>(name, () => ({ class: storeClass() })).put("k", "earlier call");
    state.facets.abort(name, new Error("call ended without delete"));
    expect(await state.facets.get<any>(name, () => ({ class: storeClass() })).dump()).toEqual([["k", "earlier call"]]);
    state.facets.abort(name, new Error("done"));
    state.facets.delete(name);
  }));
});

describe("tool lane: slots and the deadline", () => {
  it("allows 4 calls per workspace and 1 per caller, reserved synchronously and held through cleanup", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let running = [0, 1, 2, 3].map(i => call(reserved(lane, `u${i}`), "wait", { ms: 60_000 }, { deadlineMs: 300 }));
    expect(lane.reserve("u9")).toEqual({ refused: "busy" });
    expect(lane.reserve("u0")).toEqual({ refused: "busy" });
    expect(pendingNames(impl)).toHaveLength(4);
    expect(await Promise.all(running)).toEqual(Array.from({ length: 4 }, () => ({ status: "failed", reason: "deadline" })));
    expect(pendingNames(impl)).toEqual([]);

    let first = reserved(lane, "u0");
    expect(lane.reserve("u0")).toEqual({ refused: "caller-busy" });
    let other = reserved(lane, "u1");
    first.release();
    reserved(lane, "u0").release();
    other.release();
  }));

  it("runIsolatedTool ends the call but leaves the slot to its caller, who releases it", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let slot = reserved(lane, "u1");
    expect(await runIsolatedTool(slot, {
      modules: { "server.js": TOOLS }, method: "echo", inputJson: "1", deadlineAt: Date.now() + 4_000,
    })).toEqual({ status: "ok", value: { echo: 1 } });
    // The facet is deleted and tombstoned, but the slot still counts against the caller.
    expect(pendingNames(impl)).toEqual([]);
    expect(impl.storage.toolFacetTombstones.byName.get(slot.name)).toBeDefined();
    expect(slot.released).toBe(false);
    expect(lane.reserve("u1")).toEqual({ refused: "caller-busy" });
    slot.release();
    expect(slot.released).toBe(true);
    reserved(lane, "u1").release();
  }));

  it("aborts an async wait at the deadline, deletes its facet and frees the slot", () => inWorkspace(async (impl, state) => {
    let lane = testLane(impl, state);
    let slot = reserved(lane, "u1");
    let started = Date.now();
    expect(await call(slot, "stash", { payload: "synthetic-deadline", waitMs: 60_000 }, { deadlineMs: 300 }))
        .toEqual({ status: "failed", reason: "deadline" });
    let elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    expect(pendingNames(impl)).toEqual([]);
    expect(await peek(state, slot.name)).toEqual([]);
    reserved(lane, "u1").release();
    state.facets.delete(slot.name);
  }));
});

describe("tool lane: deadline edge cases", () => {
  it("still answers at the deadline when aborting the facet throws", () => inWorkspace(async (impl, state) => {
    let faults = { deleteThrows: false, abortThrows: true };
    let lane = testLane(impl, state, { faults });
    let slot = reserved(lane, "u1");
    let started = Date.now();
    expect(await call(slot, "wait", { ms: 60_000 }, { deadlineMs: 200 })).toEqual({ status: "failed", reason: "deadline" });
    expect(Date.now() - started).toBeLessThan(3_000);
    // The release could not abort either, so the row waits for a sweep; the slot is free.
    expect(Array.from(impl.storage.pendingToolFacets.list())).toMatchObject([{ name: slot.name, attempts: 1 }]);
    faults.abortThrows = false;
    reserved(lane, "u1").release();
    expect(pendingNames(impl)).toEqual([]);
  }));

  it("runs no code for a deadline that has already passed", () => inWorkspace(async (impl, state) => {
    let gets: string[] = [];
    let lane = testLane(impl, state, { gets });
    for (let deadlineAt of [Date.now(), Date.now() - 1_000]) {
      expect(await run(reserved(lane, "u1"), {
        modules: { "server.js": TOOLS }, method: "echo", inputJson: "{}", deadlineAt,
      })).toEqual({ status: "failed", reason: "deadline" });
    }
    expect(gets).toEqual([]);
    expect(pendingNames(impl)).toEqual([]);
  }));
});

describe("tool lane: cleanup and sweeps (spike case 4)", () => {
  it("an abandoned call's payload stays until the sweep before the next call deletes it", () => inWorkspace(async (impl, state) => {
    let payload = `synthetic-${crypto.randomUUID()}`;
    // The first instance reserves, creates the facet and runs the tool, then is never heard from
    // again: no release, as when it crashes between creating and deleting the facet.
    let crashed = testLane(impl, state);
    let slot = reserved(crashed, "u1");
    let facet = crashed.facet(slot, crashed.load({ "server.js": TOOLS }));
    await readToolEnvelope(await facet.__invoke("stash", JSON.stringify({ payload, waitMs: 0 })));
    expect(JSON.stringify(await peek(state, slot.name))).toContain(payload);

    // A new instance knows no live call: its sweep before the next call removes the facet.
    let restarted = testLane(impl, state);
    restarted.reserve("u2");
    expect(pendingNames(impl)).not.toContain(slot.name);
    expect(impl.storage.toolFacetTombstones.byName.get(slot.name)).toBeDefined();
    expect(await peek(state, slot.name)).toEqual([]);
    state.facets.delete(slot.name);
  }));

  it("the startup sweep deletes a call abandoned by a crash", async () => {
    let name = workspaceName();
    let facetName = await inWorkspace(async impl => {
      let slot = reserved(impl.toolLane, "u1");
      void call(slot, "stash", { payload: "synthetic-crash", waitMs: 60_000 }, { deadlineMs: 60_000 }).catch(() => {});
      await scheduler.wait(200);
      return slot.name;
    }, name);
    await abortAllDurableObjects();
    await inWorkspace(async (impl, state) => {
      expect(pendingNames(impl)).toEqual([]);
      expect(impl.storage.toolFacetTombstones.byName.get(facetName)).toBeDefined();
      expect(await peek(state, facetName)).toEqual([]);
      state.facets.delete(facetName);
    }, name);
  });

  it("a failed delete stays pending and retryable; a later sweep deletes it", () => inWorkspace(async (impl, state) => {
    let faults = { deleteThrows: true };
    let lane = testLane(impl, state, { faults });
    let slot = reserved(lane, "u1");
    expect(await call(slot, "stash", { payload: "synthetic-retry", waitMs: 0 })).toEqual({ status: "ok", value: "stashed" });
    expect(Array.from(impl.storage.pendingToolFacets.list())).toMatchObject([{ name: slot.name, attempts: 1 }]);
    expect(JSON.stringify(await peek(state, slot.name))).toContain("synthetic-retry");
    expect(lane.sweep()).toEqual({ deleted: [], failed: [slot.name], remaining: 1 });
    expect(Array.from(impl.storage.pendingToolFacets.list())).toMatchObject([{ name: slot.name, attempts: 2 }]);

    // The slot itself was freed: the same caller may call again, and that call's sweep deletes it.
    faults.deleteThrows = false;
    let next = reserved(lane, "u1");
    expect(pendingNames(impl)).toEqual([next.name]);
    expect(impl.storage.toolFacetTombstones.byName.get(slot.name)).toBeDefined();
    next.release();
    expect(await peek(state, slot.name)).toEqual([]);
    state.facets.delete(slot.name);
  }));

  it("a sweep attempts at most 16 deletes, oldest first; the rest carry over", () => inWorkspace(async (impl, state) => {
    let faults = { deleteThrows: true };
    let lane = testLane(impl, state, { faults });
    let names = Array.from({ length: 20 }, (_, i) => abandonedRow(impl, 1_000 + i));
    let failing = lane.sweep();
    expect(failing.failed).toEqual(names.slice(0, 16));
    expect(failing.remaining).toBe(20);

    faults.deleteThrows = false;
    expect(lane.sweep()).toEqual({ deleted: names.slice(0, 16), failed: [], remaining: 4 });
    expect(lane.sweep()).toEqual({ deleted: names.slice(16), failed: [], remaining: 0 });
  }));

  it("refuses new calls while 64 rows are pending, until a sweep frees some", () => inWorkspace(async (impl, state) => {
    let faults = { deleteThrows: true };
    let lane = testLane(impl, state, { faults });
    for (let i = 0; i < TOOL_LANE_LIMITS.pendingRows; i++) abandonedRow(impl, 1_000 + i);
    expect(lane.reserve("u1")).toEqual({ refused: "cleanup-behind" });
    faults.deleteThrows = false;
    reserved(lane, "u1").release();
    expect(pendingNames(impl)).toHaveLength(TOOL_LANE_LIMITS.pendingRows - 16);
  }));

  it("retries 30 s out while rows remain, backing off to 5 min", () => inWorkspace(async (impl, state) => {
    expect(testLane(impl, state).nextSweepTime()).toBeUndefined();
    for (let [attempts, delay] of [[0, 30_000], [1, 30_000], [3, 120_000], [10, 300_000]]) {
      let name = abandonedRow(impl, 1_000, attempts);
      let at = testLane(impl, state).nextSweepTime()!;
      expect(at - Date.now()).toBeGreaterThan(delay - 1_000);
      expect(at - Date.now()).toBeLessThanOrEqual(delay);
      impl.storage.pendingToolFacets.delete(name);
    }
  }));

  it("the alarm sweeps (forced), and re-arms 30 s out while rows remain", async () => {
    let name = workspaceName();
    let names = await inWorkspace(async (impl, state) => {
      let rows = Array.from({ length: 20 }, (_, i) => abandonedRow(impl, 1_000 + i));
      await impl.runAlarmTasks();
      expect(pendingNames(impl).toSorted()).toEqual(rows.slice(16).toSorted());
      let alarm = await state.storage.getAlarm();
      expect(alarm! - Date.now()).toBeGreaterThan(29_000);
      expect(alarm! - Date.now()).toBeLessThanOrEqual(30_000);
      return rows;
    }, name);
    expect(await runDurableObjectAlarm(env.TEST_OVERSEER.getByName(name))).toBe(true);
    await inWorkspace(async (impl, state) => {
      expect(pendingNames(impl)).toEqual([]);
      expect(impl.storage.toolFacetTombstones.byName.get(names[19])).toBeDefined();
      expect(await state.storage.getAlarm()).toBeNull();
    }, name);
  });

  it("a live call that outlasts the alarm does not re-arm it at the time that just fired", () => inWorkspace(async (impl, state) => {
    // Under steady traffic some call is always live. If live rows held the retry time, every alarm
    // would find nothing abandoned and set that same (by then past) time again: a hot loop.
    let slot = reserved(impl.toolLane, "u1");
    let fired = await state.storage.getAlarm();
    expect(fired).not.toBeNull();  // a live row still schedules a wake-up, in case the object crashes
    await scheduler.wait(5);  // the alarm fires later than the reservation
    await impl.runAlarmTasks();
    let next = await state.storage.getAlarm();
    expect(next === null || (fired !== null && next > fired), `fired at ${fired}, re-armed at ${next}`).toBe(true);
    expect(next! - Date.now()).toBeGreaterThan(29_000);
    expect(pendingNames(impl)).toEqual([slot.name]);
    slot.release();
  }));

  it("a real scheduled alarm sweeps an abandoned facet and its payload", async () => {
    let name = workspaceName();
    let facetName = await inWorkspace(async (impl, state) => {
      let abandoned = abandonedRow(impl, 1_000);
      await state.facets.get<any>(abandoned, () => ({
        class: storeClass(),
      })).put("payload", "synthetic-alarm");
      state.facets.abort(abandoned, new Error("abandoned"));
      await state.storage.setAlarm(Date.now() + 50);
      return abandoned;
    }, name);
    await expect.poll(() => inWorkspace(async impl => pendingNames(impl).length, name), { timeout: 3_000 }).toBe(0);
    await inWorkspace(async (_impl, state) => {
      expect(await peek(state, facetName)).toEqual([]);
      state.facets.delete(facetName);
    }, name);
  });
});

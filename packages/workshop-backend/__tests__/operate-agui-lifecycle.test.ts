import { afterEach, expect, it, vi } from "vitest";
import type { AuthenticatedApi, AiChatSubscriber, OperateSession, Overseer } from "@gadgets/workshop-shared/api";
import { INITIAL_OPERATE_PAGE, type OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";
import { handleOperateAgui } from "../src/operate-agui";

// Adapter ownership/timer probe only. Real native stubs and DO eviction are exercised over HTTP
// in integration-tests/operate-agui.test.ts; this mock makes every disposal and late call observable.
const nativeDisposals = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);
vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
  RpcStub: class {
    constructor(target: object) {
      const dispose = vi.fn();
      nativeDisposals.push(dispose);
      return Object.assign(target, {[Symbol.dispose]: dispose});
    }
  },
}));
afterEach(() => { vi.useRealTimers(); nativeDisposals.length = 0; });

function fixture() {
  vi.useFakeTimers();
  let callbacks!: AiChatSubscriber;
  let updates!: (snapshot: OperateSessionSnapshot) => void;
  const disposals = Array.from({length: 4}, () => vi.fn());
  const history = vi.fn<Overseer["getChatHistory"]>().mockResolvedValue({messages: []});
  const workspace = {
    subscribeToChat: async (subscriber: AiChatSubscriber) => {
      callbacks = subscriber;
      return {[Symbol.dispose]: disposals[0]};
    },
    getChatHistory: history,
    [Symbol.dispose]: disposals[1],
  };
  const session = {
    getWorkspace: async () => workspace,
    subscribe: async (subscriber: typeof updates) => {
      updates = subscriber;
      subscriber({seq: 0, state: INITIAL_OPERATE_PAGE});
      return {[Symbol.dispose]: disposals[2]};
    },
    startReadRun: vi.fn<OperateSession["startReadRun"]>().mockResolvedValue(1),
    [Symbol.dispose]: disposals[3],
  };
  // Only the methods consumed by this adapter are present; their payloads derive from the public API.
  const authenticate = async () => ({getOperateSession: async () => session}) as AuthenticatedApi;
  const request = new Request("http://localhost/api/operate/agui", {method: "POST", body: JSON.stringify({
    threadId: "thread", runId: "run", messages: [{id: "prompt", role: "user", content: "Read"}],
    tools: [], context: [], state: {},
  })});
  const lateCallbacks = () => {
    callbacks.metadata({id: 1} as Parameters<AiChatSubscriber["metadata"]>[0]);
    callbacks.deleted(1);
    callbacks.changeApplied(1);
    updates({seq: 1, state: INITIAL_OPERATE_PAGE});
  };
  const cleaned = () => {
    expect(vi.getTimerCount()).toBe(0);
    expect(nativeDisposals).toHaveLength(2);
    for (const dispose of [...disposals, ...nativeDisposals]) expect(dispose).toHaveBeenCalledTimes(1);
  };
  return {request, authenticate, session, history, lateCallbacks, cleaned, callbacks: () => callbacks};
}

it.each(["deadline", "output", "success"] as const)("cleans up %s once and ignores late callbacks", async kind => {
  const f = fixture();
  const response = await handleOperateAgui(f.request, f.authenticate);
  expect(response.status).toBe(200);
  expect(vi.getTimerCount()).toBe(2);
  if (kind === "deadline") {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
  } else if (kind === "output") {
    f.callbacks().message({chatId: 1, sequence: 1, type: "message", author: {type: "agent", id: "model", name: "Model"},
      timestamp: new Date(), message: "x".repeat(4 * 1024 * 1024)});
  } else {
    f.callbacks().metadata({id: 1} as Parameters<AiChatSubscriber["metadata"]>[0]);
    await vi.advanceTimersByTimeAsync(0);
  }
  f.cleaned();
  f.lateCallbacks();
  await vi.advanceTimersByTimeAsync(120_000);
  f.cleaned();
  expect(f.history).toHaveBeenCalledTimes(kind === "success" ? 1 : 0);
  expect(f.session.startReadRun).toHaveBeenCalledTimes(1);
  const text = await response.text();
  const events = text.split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  expect(events[0].type).toBe("RUN_STARTED");
  expect(events.filter(event => ["RUN_FINISHED", "RUN_ERROR"].includes(event.type))).toHaveLength(1);
  expect(events.at(-1)).toMatchObject(kind === "success" ? {type: "RUN_FINISHED"} : {
    type: "RUN_ERROR", code: kind === "output" ? "OPERATE_READ_LIMIT" : "OPERATE_READ_FAILED",
  });
  expect(text.length).toBeLessThan(4096);
  expect(events.filter(event => event.type === "STATE_DELTA")).toHaveLength(0);
});

it("reader cancellation disposes both timers and every owned capability without replay", async () => {
  const f = fixture();
  const response = await handleOperateAgui(f.request, f.authenticate);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("RUN_STARTED");
  await reader.cancel();
  f.cleaned();
  f.lateCallbacks();
  await vi.advanceTimersByTimeAsync(120_000);
  f.cleaned();
  expect(f.history).not.toHaveBeenCalled();
  expect(f.session.startReadRun).toHaveBeenCalledTimes(1);
});

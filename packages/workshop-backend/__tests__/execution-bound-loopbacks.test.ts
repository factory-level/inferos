import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// In an operate workspace, the `gatekeeper` and `git` loopbacks in the agent's executeCode env
// are bound to the execution they were minted for, like worktree loopbacks: a stub retained past
// it -- stored through `self.later` and delivered into a later execution of the same chat or of
// another chat -- is refused at session open. Other workspaces are unchanged.
//
// A loopback is a service stub whose props are its target and caller; GatekeeperLoopback opens
// the session from those props alone. So a stored stub is modelled here by the props it was
// minted with, replayed through startGatekeeperSession -- exactly what the loopback does when
// it is used. (The real loopbacks are not reachable from this test pool.)

const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const CONN_ID = 1;
const BINDINGS = { CONN: { type: "workpiece", id: CONN_ID } };

type Minted = { target: any, caller: any };

let doCounter = 0;
async function withImpl(operate: boolean, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`execution-bound-loopbacks-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = "owner-user-do";
    impl.users = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => name,
      get: () => ({ whoami: async () => ({ type: "user", id: "owner", name: "Owner" }) }),
    };
    impl.storage.title.put("My Workspace");
    if (operate) impl.storage.operateSession.put(true);
    // A connection with no recorded vendor or URL: never excluded from an operate chat.
    impl.storage.gatekeepers.put({ id: CONN_ID, resourceTitle: "Conn", class: {} as any });
    impl.getGatekeeperFacet = () => ({});
    impl.openGatekeeperSession = async (id: number) => ({ session: id });
    // Observe each loopback's props rather than an opaque service stub.
    impl.makeBindingLoopback = (target: unknown, caller: unknown): Minted =>
        ({ target, caller }) as Minted;
    await fn(impl);
  });
}

// Start an executeCode run in `chatId` that stays live for `ms`, resolving its env once built.
function startExecution(impl: any, chatId: number, ms = 1000)
    : { env: Promise<Record<string, Minted>>, done: Promise<string> } {
  let resolveEnv!: (env: Record<string, Minted>) => void;
  let envPromise = new Promise<Record<string, Minted>>(resolve => { resolveEnv = resolve; });
  let getEnvForAgent = impl.getEnvForAgent;
  impl.getEnvForAgent = (...args: unknown[]) => {
    impl.getEnvForAgent = getEnvForAgent;
    let built = getEnvForAgent.apply(impl, args);
    resolveEnv(built);
    return built;
  };
  let done = impl.executeCodeMode(chatId, `
      export default async function() { await new Promise(r => setTimeout(r, ${ms})); }`,
      ALICE, "some-model", BINDINGS);
  return { env: envPromise, done };
}

async function open(impl: any, minted: Minted): Promise<unknown> {
  return await impl.startGatekeeperSession(minted.target, minted.caller);
}

const NOT_LIVE = /no longer live/;

describe("operate workspace: gatekeeper and git loopbacks are execution-bound", () => {
  it("mints them with the execution's id, and they open inside that execution",
      () => withImpl(true, async impl => {
    let run = startExecution(impl, 1);
    let env = await run.env;
    expect(env.CONN.target).toEqual(
        { type: "gatekeeper", id: CONN_ID, executionId: expect.any(String) });
    expect(env.GIT.target).toEqual({ type: "git", executionId: env.CONN.target.executionId });

    expect(await open(impl, env.CONN)).toEqual({ session: CONN_ID });
    expect(await open(impl, env.GIT)).toBeDefined();
    await run.done;
  }));

  it("refuses a stub kept past its execution, even in a later execution of the same chat",
      () => withImpl(true, async impl => {
    // The B -> B control: no taint involved, only the execution binding.
    let first = startExecution(impl, 1, 0);
    let stored = await first.env;
    await first.done;

    let second = startExecution(impl, 1);
    let current = await second.env;
    await expect(open(impl, stored.CONN)).rejects.toThrow(NOT_LIVE);
    await expect(open(impl, stored.GIT)).rejects.toThrow(NOT_LIVE);
    // The later execution's own stubs still work.
    expect(await open(impl, current.CONN)).toEqual({ session: CONN_ID });
    expect(await open(impl, current.GIT)).toBeDefined();
    await second.done;

    // And once nothing runs, nothing opens.
    await expect(open(impl, current.CONN)).rejects.toThrow(NOT_LIVE);
    await expect(open(impl, current.GIT)).rejects.toThrow(NOT_LIVE);
  }));

  it("refuses a stub delivered into another chat", () => withImpl(true, async impl => {
    // Minted in chat B (2), delivered into chat A (1) once B's execution has ended.
    let inB = startExecution(impl, 2, 0);
    let fromB = await inB.env;
    await inB.done;

    let inA = startExecution(impl, 1);
    let ownA = await inA.env;
    await expect(open(impl, fromB.CONN)).rejects.toThrow(NOT_LIVE);
    await expect(open(impl, fromB.GIT)).rejects.toThrow(NOT_LIVE);

    // A live execution's id does not lend itself to another chat's caller.
    for (let name of ["CONN", "GIT"]) {
      await expect(open(impl, { target: ownA[name].target, caller: { from: "agent", chatId: 2 } }))
          .rejects.toThrow(NOT_LIVE);
    }
    await inA.done;
  }));

  it("refuses an agent stub minted with no execution id", () => withImpl(true, async impl => {
    let run = startExecution(impl, 1);
    await run.env;
    let caller = { from: "agent", chatId: 1 };
    await expect(open(impl, { target: { type: "gatekeeper", id: CONN_ID }, caller }))
        .rejects.toThrow(NOT_LIVE);
    await expect(open(impl, { target: { type: "git" }, caller })).rejects.toThrow(NOT_LIVE);
    await run.done;
  }));

  it("leaves gadget callers unbound", () => withImpl(true, async impl => {
    let caller = { from: "gadget", gadgetId: 100 };
    expect(await open(impl, { target: { type: "gatekeeper", id: CONN_ID }, caller }))
        .toEqual({ session: CONN_ID });
    expect(await open(impl, { target: { type: "git" }, caller })).toBeDefined();
  }));
});

describe("other workspaces", () => {
  it("mint unbound gatekeeper and git loopbacks that open after their execution",
      () => withImpl(false, async impl => {
    let run = startExecution(impl, 1, 0);
    let env = await run.env;
    expect(env.CONN.target).toEqual({ type: "gatekeeper", id: CONN_ID });
    expect(env.GIT.target).toEqual({ type: "git" });
    await run.done;

    expect(await open(impl, env.CONN)).toEqual({ session: CONN_ID });
    expect(await open(impl, env.GIT)).toBeDefined();
  }));
});

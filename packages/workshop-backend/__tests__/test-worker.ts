// The Worker the unit suites run inside: the production Worker's exports (so `ctx.exports` resolves
// the real Durable Objects and callbacks) plus test-only entrypoints that stand in for other Workers.

import { DurableObject, WorkerEntrypoint, restore } from "cloudflare:workers";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import { GatekeeperConnectCallbackImpl } from "../src/user.js";
import { LoginConnectCallbackImpl } from "../src/auth/login-flow.js";
import { OverseerDurableObject as RealOverseerDurableObject } from "../src/server.js";

export * from "../src/server.js";
export { default } from "../src/server.js";

/**
 * The pool stands a proxy class in front of every Durable Object (`createDurableObjectWrapper`) and
 * forwards only string-keyed methods to the instance it constructs, so when the runtime looks up
 * `[restore]` on the entrypoint -- which is what `ctx.restore()` does -- it finds nothing. The
 * wrapper's prototype chain does end at `DurableObject.prototype`, and it hands the instance the
 * very `ctx` it was given, so a `[restore]()` there can route by `ctx` to any instance that has
 * registered itself (below).
 */
const restoreTargets = new WeakMap<DurableObjectState, DurableObject>();
function bridgedRestore(this: DurableObject, params: unknown): unknown {
  const target = restoreTargets.get(this.ctx) as { [restore]?: (params: unknown) => unknown } | undefined;
  if (target?.[restore] === undefined || target[restore] === bridgedRestore) {
    throw new TypeError("This Durable Object does not implement a [restore]() method.");
  }
  return target[restore](params);
}
(DurableObject.prototype as unknown as Record<symbol, unknown>)[restore] = bridgedRestore;

/**
 * The test file now running, counted by `workerd/backend-file-boundary.ts`. The `backend` project
 * runs several files in one Miniflare (see vitest.config.ts), and a Durable Object's storage --
 * alarm included -- outlives the file that made it.
 */
let currentTestFile = 0;
/** The test file that first constructed each overseer, by id. */
const overseerTestFile = new Map<string, number>();

/** Called as each test file starts (see `workerd/backend-file-boundary.ts`). */
export function beginTestFile(): void {
  currentTestFile++;
}

/**
 * The overseer, registered for the bridge above so tests can exercise `ctx.restore()`. Its alarm
 * runs only for the file that made it: an alarm a finished file left armed would otherwise wake its
 * overseer while a later file runs, resuming persisted agent calls through that file's `fetch` stub.
 */
export class OverseerDurableObject extends RealOverseerDurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    restoreTargets.set(ctx, this);
    let id = ctx.id.toString();
    if (!overseerTestFile.has(id)) overseerTestFile.set(id, currentTestFile);
  }

  override async alarm(): Promise<void> {
    if (overseerTestFile.get(this.ctx.id.toString()) !== currentTestFile) return;
    await super.alarm();
  }
}
/**
 * The `self` object / spawnCallable() stub entrypoint, named explicitly for the same reason as the
 * callbacks below: the overseer mints it through `ctx.exports.AgentSelfLoopback({props})`.
 */
export { AgentSelfLoopback } from "../src/server.js";
/** What a loaded gadget's `env.GADGET` and tail worker are minted from, likewise. */
export { GatekeeperLoopback, GadgetTailLoopback } from "../src/server.js";
/** What an executeCode run's tail worker is minted from, likewise. */
export { CodeModeTailLoopback } from "../src/server.js";
/**
 * The Workshop's connect callback, reachable through `ctx.exports`: the pool derives those from this
 * module's own declarations, so an entrypoint a test reaches that way has to be named here rather
 * than covered by the `export *`.
 */
export class TestConnectCallback extends GatekeeperConnectCallbackImpl {}
/** The sign-in callback, reachable the same way. */
export class TestLoginCallback extends LoginConnectCallbackImpl {}

/**
 * What each FakeGatekeeperAccount has been asked to do, by its `scope` and `name` props. This module
 * outlives a test file: the `backend` project shares one module graph across the files a pool worker
 * runs (see vitest.config.ts), so the key carries a scope the file mints for itself, and two files
 * that both name an account "octocat" never read each other's calls.
 */
const accountCalls = new Map<string, string[]>();

/**
 * A gatekeeper account as the Workshop sees one: a persistent stub it can store and call back into.
 * Records calls by `props.scope` and `props.name` so a test can ask any instance what happened
 * (`calls()`); with `failRevoke` / `failDescribe`, that method rejects after being recorded.
 */
export class FakeGatekeeperAccount extends WorkerEntrypoint<
    unknown, { scope: string; name: string; failRevoke?: boolean; failDescribe?: boolean }> {
  get #key(): string {
    return JSON.stringify([this.ctx.props.scope, this.ctx.props.name]);
  }

  #record(call: string) {
    const calls = accountCalls.get(this.#key) ?? [];
    calls.push(call);
    accountCalls.set(this.#key, calls);
  }

  async describe(): Promise<AccountDescription> {
    this.#record("describe");
    if (this.ctx.props.failDescribe) throw new Error("describe failed");
    return { displayName: this.ctx.props.name, uniqueName: this.ctx.props.name };
  }

  async revoke(): Promise<void> {
    this.#record("revoke");
    if (this.ctx.props.failRevoke) throw new Error("revoke failed");
  }

  async commitReconnect(stageId: string): Promise<void> {
    this.#record(`commitReconnect(${stageId})`);
  }

  async reconnect(): Promise<{ url: string }> {
    this.#record("reconnect");
    return { url: `https://gk.example/reconnect/${this.ctx.props.name}` };
  }

  /**
   * Nothing to grant for an empty list, as a real gatekeeper answers when the grant already covers
   * every requested resource.
   */
  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    this.#record(`ensureResources(${resourceUrlPatterns.join(",")})`);
    if (resourceUrlPatterns.length === 0) return {};
    return { url: `https://gk.example/expand/${this.ctx.props.name}` };
  }

  async calls(): Promise<string[]> {
    return accountCalls.get(this.#key) ?? [];
  }
}

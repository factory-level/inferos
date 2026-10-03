// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object that plays the overseer: it instantiates the
// gatekeeper as a facet with props, hands it an approval queue that records what it is told, and
// applies or rejects the actions it collected.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription, ConnectHandoff, GatekeeperUser, GatekeeperUserVerifier, GitCache,
  GitObjectType, GitOid, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { InferOpsProjectGatekeeper } from "../src/inferops.js";
import type { InferOpsProjectSession } from "../src/types.js";

export { default } from "../src/inferops.js";
export * from "../src/inferops.js";
// Vitest's ctx.exports analyzer does not follow `export *`, so the classes reached through
// ctx.exports are named explicitly.
export {
  GatekeeperVendor, InferLabLogin, InferOpsAccount, InferOpsCredentials, InferOpsProjectGatekeeper,
  InferOpsVerifier, MockInferOps,
} from "../src/inferops.js";

/**
 * The production gatekeeper plus one test-only method, so a test can write a stored action record
 * the way an older version (or a corrupted store) left it.
 */
export class TestProjectGatekeeper extends InferOpsProjectGatekeeper {
  async putRaw(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }
}

/** The props the Workshop bakes into one project-board binding. */
export type BindingProps = {
  accountId: string; host: string; projectKey: string; connected?: boolean; workspaceId?: string;
};

/** What the recording approval queue was told, in order. */
export type QueueLog = {
  observations: string[];
  actions: Array<{
    id: number; title: string; description: string; implementsRevert: boolean;
    /** Each field's label and shown value. */
    fields: Record<string, string>;
  }>;
};

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly log: QueueLog) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.observations.push(description.title);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    const fields: Record<string, string> = {};
    for (const field of description.fields ?? []) {
      if ("value" in field && typeof field.value === "string") fields[field.label] = field.value;
    }
    this.log.actions.push({
      id, title: description.title, description: description.description,
      implementsRevert: description.implementsRevert ?? false, fields,
    });
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("not implemented");
  }
}

/** Stands in for the git cache the overseer passes to `applyAction()`; never touched. */
class TestGitCache extends RpcTarget implements GitCache {
  async get(_id: GitOid): Promise<{ type: GitObjectType; content: Uint8Array } | null> {
    throw new Error("not implemented");
  }
  async has(_id: GitOid): Promise<boolean> { throw new Error("not implemented"); }
  async stat(_id: GitOid): Promise<{ type: GitObjectType; size: number } | null> {
    throw new Error("not implemented");
  }
  async put(_type: GitObjectType, _content: Uint8Array): Promise<GitOid> {
    throw new Error("not implemented");
  }
  async advertiseCommit(_commitId: GitOid): Promise<void> { throw new Error("not implemented"); }
  async buildPack(): Promise<ReadableStream<Uint8Array>> { throw new Error("not implemented"); }
  async consumePack(_pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    throw new Error("not implemented");
  }
  async isAncestor(_ancestor: GitOid, _descendant: GitOid): Promise<boolean> {
    throw new Error("not implemented");
  }
}

/** Stands in for another user's account during an observer admission check. */
class TestVerifier extends RpcTarget {
  constructor(private readonly hasAccess: boolean) {
    super();
  }

  async hasProjectAccess(): Promise<boolean> {
    return this.hasAccess;
  }
}

/** The emails sign-in and connect flows reported to each `TestConnectCallback`, by label. */
export const signIns: Array<{ label: string; email: string | null }> = [];
/** The stage ids reconnects reported, by label. */
export const reconnects: Array<{ label: string; stageId: string }> = [];
/** The labels whose credentials the gatekeeper reported expired, in order. */
export const expired: string[] = [];

/** The props of one account, as the Workshop's stub for it carries them. */
export type AccountProps = { accountId: string; email?: string; connected?: boolean };

/** Stands in for the Workshop's callback: records the account's email and returns a handoff. */
export class TestConnectCallback extends WorkerEntrypoint<Cloudflare.Env, { label: string }> {
  async complete(user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    signIns.push({ label: this.ctx.props.label, email: await user.getAuthenticatedEmail() });
    return { targetOrigin: "http://localhost:3000", ticket: `ticket-${this.ctx.props.label}` };
  }

  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    reconnects.push({ label: this.ctx.props.label, stageId });
    return { targetOrigin: "http://localhost:3000", ticket: `reticket-${this.ctx.props.label}` };
  }

  async credentialsExpired(): Promise<void> {
    expired.push(this.ctx.props.label);
  }

  async credentialsRestored(): Promise<void> {}
}

/** The test worker's own entrypoints, as `ctx.exports` exposes them. */
export type SignInExports = {
  TestConnectCallback(options: { props: { label: string } }): Fetcher<TestConnectCallback>;
  GatekeeperVendor(options: object): Fetcher<import("../src/inferops.js").GatekeeperVendor>;
};

type TestExports = {
  TestProjectGatekeeper(options: { props: BindingProps }):
    DurableObjectClass<TestProjectGatekeeper>;
  InferOpsAccount(options: { props: AccountProps }): Fetcher<GatekeeperUser>;
};

/** The project configurator's capability, as the picker iframe receives it. */
type ConfiguratorRpc = {
  defaultHost(): Promise<string | null>;
  listWorkspaces(): Promise<Array<{ value: string; title: string }>>;
  listProjects(query: string, host: string): Promise<Array<{ value: string }>>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #log: QueueLog = { observations: [], actions: [] };
  // Classes the accounts minted, by binding name: a facet is re-initialized from its class on
  // every `facets.get`.
  #minted = new Map<string, DurableObjectClass<InferOpsProjectGatekeeper>>();

  #gatekeeper(props: BindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TestProjectGatekeeper>(
      `${props.accountId}/${props.projectKey}`,
      () => ({ class: exports.TestProjectGatekeeper({ props }) }));
  }

  // --- Driving an account the Workshop holds by its props. Stubs cannot leave a Durable Object's
  // context, so every account operation runs in here and hands back plain data or a session.

  #account(props: AccountProps): Fetcher<GatekeeperUser> {
    return (this.ctx.exports as unknown as TestExports).InferOpsAccount({ props });
  }

  async describeAccount(props: AccountProps) {
    return this.#account(props).describe();
  }

  async authenticatedEmail(props: AccountProps): Promise<string | null> {
    return this.#account(props).getAuthenticatedEmail();
  }

  async revokeAccount(props: AccountProps): Promise<void> {
    await this.#account(props).revoke();
  }

  async reconnectAccount(props: AccountProps): Promise<string> {
    return (await this.#account(props).reconnect()).url;
  }

  /** Commits a reconnect; returns the failure message, or null on success. */
  async commitReconnect(props: AccountProps, stageId: string): Promise<string | null> {
    try {
      await this.#account(props).commitReconnect(stageId);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Binds `url` through the account's own `getGatekeeperClassFor`; the failure message, or null. */
  async bindAccount(name: string, props: AccountProps, url: string): Promise<string | null> {
    try {
      const { class: cls } = await this.#account(props).getGatekeeperClassFor(url);
      this.#minted.set(name, cls as DurableObjectClass<InferOpsProjectGatekeeper>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  #bound(name: string) {
    const cls = this.#minted.get(name);
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsProjectGatekeeper>(`minted/${name}`, () => ({ class: cls }));
  }

  /** A session over a binding `bindAccount` made under `name`. */
  async startBoundSession(name: string): Promise<InferOpsProjectSession> {
    return this.#bound(name).startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Apply an action of a bound binding; returns the failure message, or null on success. */
  async applyBound(name: string, actionId: number): Promise<string | null> {
    try {
      await this.#bound(name).applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Admission of a collaborator by their own account's verifier, over a bound binding. */
  async addObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    try {
      await this.#bound(name).addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async #configurator(props: AccountProps): Promise<ConfiguratorRpc> {
    const frame = await this.#account(props).startResourceConfigurator("inferops://*/project/board/*");
    return frame.ui as unknown as ConfiguratorRpc;
  }

  async defaultHost(props: AccountProps): Promise<string | null> {
    return (await this.#configurator(props)).defaultHost();
  }

  async listWorkspaces(props: AccountProps) {
    return (await this.#configurator(props)).listWorkspaces();
  }

  /** The project keys the configurator lists on `host`, or the failure message. */
  async listProjects(props: AccountProps, host: string, query = ""): Promise<string[] | string> {
    try {
      return (await (await this.#configurator(props)).listProjects(query, host)).map(p => p.value);
    } catch (error) {
      return messageOf(error);
    }
  }

  /** A session over a binding, recording into this object's queue log. */
  async startSession(props: BindingProps): Promise<InferOpsProjectSession> {
    return this.#gatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  async log(): Promise<QueueLog> {
    return this.#log;
  }

  /** Apply an action; returns the failure message, or null on success. */
  async apply(props: BindingProps, actionId: number): Promise<string | null> {
    try {
      await this.#gatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Write a raw value into the binding's storage, as an older version might have left it. */
  async putRaw(props: BindingProps, key: string, value: unknown): Promise<void> {
    await this.#gatekeeper(props).putRaw(key, value);
  }

  /** Read a raw value from the binding's storage. */
  async getRaw(props: BindingProps, key: string): Promise<unknown> {
    return this.#gatekeeper(props).getRaw(key);
  }

  async reject(props: BindingProps, actionId: number): Promise<void> {
    await this.#gatekeeper(props).rejectAction(actionId);
  }

  async revert(props: BindingProps, actionId: number): Promise<string | null> {
    const result = await this.#gatekeeper(props).revertAction(actionId);
    return result?.message ?? null;
  }

  /** Admission of a collaborator whose own account does or does not reach the project. */
  async addObserver(props: BindingProps, hasAccess: boolean): Promise<string | null> {
    const verifier = new RpcStub(new TestVerifier(hasAccess)) as unknown as
      Fetcher<GatekeeperUserVerifier>;
    try {
      await this.#gatekeeper(props).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }
}

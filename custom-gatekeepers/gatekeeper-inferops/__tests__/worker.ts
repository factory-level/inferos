// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object that plays the overseer: it instantiates the
// gatekeeper as a facet with props, hands it an approval queue that records what it is told, and
// applies or rejects the actions it collected.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, GatekeeperUserVerifier, GitCache, GitObjectType, GitOid,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { InferOpsProjectGatekeeper } from "../src/inferops.js";
import type { InferOpsProjectSession } from "../src/types.js";

export { default } from "../src/inferops.js";
export * from "../src/inferops.js";
// Vitest's ctx.exports analyzer does not follow `export *`, so the classes reached through
// ctx.exports are named explicitly.
export {
  GatekeeperVendor, InferOpsAccount, InferOpsProjectGatekeeper, InferOpsVerifier, MockInferOps,
} from "../src/inferops.js";

/** The props the Workshop bakes into one project-board binding. */
export type BindingProps = { accountId: string; host: string; projectKey: string };

/** What the recording approval queue was told, in order. */
export type QueueLog = {
  observations: string[];
  actions: Array<{ id: number; title: string; description: string }>;
};

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly log: QueueLog) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.observations.push(description.title);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.log.actions.push({ id, title: description.title, description: description.description });
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

type TestExports = {
  InferOpsProjectGatekeeper(options: { props: BindingProps }):
    DurableObjectClass<InferOpsProjectGatekeeper>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #log: QueueLog = { observations: [], actions: [] };

  #gatekeeper(props: BindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<InferOpsProjectGatekeeper>(
      `${props.accountId}/${props.projectKey}`,
      () => ({ class: exports.InferOpsProjectGatekeeper({ props }) }));
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

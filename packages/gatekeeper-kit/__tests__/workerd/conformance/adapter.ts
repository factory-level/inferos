/**
 * The shared conformance suite's adapter for the kit's own synthetic gatekeeper: the same cases
 * every connection package runs, mapped onto `ConformanceAccount`/`ConformanceResource` over
 * `FakeProvider`. Kit-specific cases stay in `../conformance.test.ts`.
 */

import { env } from "cloudflare:test";
import { RpcStub } from "cloudflare:workers";
import type { ConformanceAdapter } from "../../../src/conformance";
import {
  FixtureQueue,
  observations,
  provider,
  resetProvider,
  submissions,
  type ConformanceAccount,
  type ConformanceResource,
} from "./gatekeeper";

type Fixture = {
  account: DurableObjectStub<ConformanceAccount>;
  resource: DurableObjectStub<ConformanceResource>;
  /** The name of the project the last proposed write creates. */
  name?: string;
};

let seq = 0;

/** The message an RPC call failed with, or `null` when it succeeded. */
async function refusal(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The kit's synthetic gatekeeper, bound to space-1 of a provider holding two spaces. */
export const syntheticAdapter: ConformanceAdapter<Fixture> = {
  name: "gatekeeper-kit synthetic gatekeeper",

  reset() {
    resetProvider();
    provider.projects.set("project-a", { id: "project-a", name: "Alpha", spaceId: "space-1" });
    provider.projects.set("project-b", { id: "project-b", name: "Beta", spaceId: "space-2" });
  },

  async setup() {
    seq += 1;
    const account = env.CONFORMANCE_ACCOUNT.getByName(`shared-account-${seq}`);
    const resource = env.CONFORMANCE_RESOURCE.getByName(`shared-resource-${seq}`);
    const initiation = await account.beginConnect();
    const oauth = await account.beginOAuth(initiation);
    if (!await account.completeConnect(oauth!)) throw new Error("connect failed");
    {
      using queue = new RpcStub(new FixtureQueue());
      await resource.bind(account, queue);
    }
    await resource.scopeTo("space-1");
    return { account, resource };
  },

  async read({ resource }) {
    await resource.searchProjects("Alpha");
  },

  async observations() {
    return observations.map(sent => ({ excludeObservers: sent.excludeObservers ?? [] }));
  },

  async share({ resource }, canSee) {
    // The search behind `read` covers both spaces, so seeing only one is not seeing it.
    provider.access.set("collaborator",
      new Set(canSee ? ["space-1", "space-2"] : ["space-1"]));
    await resource.addObserver("collaborator", "collaborator");
    return { id: "collaborator", admitted: true };
  },

  async proposeWrite(fixture) {
    fixture.name = `Conformance ${crypto.randomUUID()}`;
    return fixture.resource.submit("createProject",
      { ref: `~${fixture.name}`, name: fixture.name, spaceId: "space-1" });
  },

  async submittedActions() {
    return submissions.map(([id]) => id);
  },

  apply({ resource }, actionId) {
    return refusal(() => resource.apply(actionId));
  },

  async effects({ name }) {
    return [...provider.projects.values()].filter(project => project.name === name).length;
  },

  async revoke({ account }) {
    await account.disconnect();
  },

  scope: {
    readOutOfScope: ({ resource }) => refusal(() => resource.openProject("project-b")),
    readUnknown: ({ resource }) => refusal(() => resource.openProject("project-missing")),
  },

  faults: {
    async failNextWrite() {
      provider.controls.unavailableOnce = true;
    },
    async loseNextResponse() {
      provider.controls.timeoutAfterCreate = true;
    },
  },

  notExpressed: {
    staleRevision: "the fake provider's projects carry no revision",
  },
};

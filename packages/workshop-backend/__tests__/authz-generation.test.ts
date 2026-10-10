// The authorization generation (callable-widget contract §4.1, step C5a). Every authorization
// input in the §4.1 table is driven here, through the real code path that changes it, and each must
// raise the generation by the number of writes it makes. The generation never decreases and
// survives a Durable Object restart, and a revoke followed by a regrant raises it twice even though
// the role reads the same afterwards. sharing.test.ts checks the sharing writes' placement after
// their last await; authz-generation-guard.test.ts pins every write site in the source.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). The User DOs, gatekeeper
// facets and the restart's ctx.abort() are the only fakes: a real abort would kill the test DO.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "owner";
const OWNER_USER_ID = "owner-user-id";
const owner = { profileId: OWNER, isOwner: true };

function profile(id: string) {
  return { type: "user" as const, id, name: id };
}

let doCounter = 0;

type Harness = { impl: any; instance: OverseerDurableObject; aborts: string[] };

// Runs `fn` in a fresh real Overseer whose User DOs, gatekeeper facets and abort are fakes.
async function withOverseer(fn: (h: Harness) => Promise<void>, name?: string): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name ?? `authz-generation-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerProfileId = OWNER;
    impl.users = {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        id,
        getGadget: async () => ({ title: "Workspace" }),
        whoami: async () => ({ id: id === OWNER_USER_ID ? OWNER : id, name: "Someone" }),
        deleteGadget: async () => {},
        recordSharedGadgetOpen: async () => {},
        ensureGadgetRegistered: async () => {},
      }),
      getByName: (email: string) => ({
        id: { toString: () => `${email}-user-id` },
        whoamiIfExists: async () => profile(email),
        // The external-message path stops here, after its owner write; nothing later is under test.
        getExternalMessageChatContext: async () => { throw new Error("stop after the owner write"); },
      }),
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.recordGadgetAnalytics = () => {};
    impl.getGatekeeperFacet = () => ({ addObserver: async () => {}, removeObserver: async () => {} });

    // The restart flushes and waits as it really does, but its abort is recorded, not performed.
    let aborts: string[] = [];
    let realCtx = impl.ctx;
    impl.ctx = new Proxy(realCtx, {
      get(target, prop) {
        if (prop === "abort") return (reason: string) => { aborts.push(reason); };
        let value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await fn({ impl, instance, aborts });
  });
}

function seedGatekeeper(impl: any, id: number): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

function seedCollaborator(impl: any, id: string, sharer = OWNER, role = "use"): void {
  impl.storage.collaborators.put(
      { profile: profile(id), addedBy: [{ type: "user", sharer, created: new Date(), role }] });
}

// The owner's first open of a fresh workspace, as the owner's User DO vouches for it.
function openAsOwner(instance: OverseerDurableObject, asOperateSession = false): Promise<any> {
  return instance.open(OWNER_USER_ID, OWNER, new NativeRpcStub<() => void>(() => {}),
      undefined, undefined, asOperateSession);
}

const fakeClientUser = {
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
} as any;

type Row = {
  // The §4.1 row (or the input this step found that the table missed).
  input: string;
  // Authorization writes the drive makes, so the expected rise.
  writes: number;
  setup?: (h: Harness) => Promise<void> | void;
  drive: (h: Harness) => Promise<unknown>;
};

const ROWS: Row[] = [
  {
    input: "direct collaborator grant",
    writes: 1,
    drive: async ({ impl }) => (await impl.getSharingManager())
        .addCollaborator({ caller: owner, profile: profile("a"), role: "use" }),
  },
  {
    input: "collaborator role change",
    writes: 1,
    setup: ({ impl }) => seedCollaborator(impl, "a"),
    drive: async ({ impl }) => (await impl.getSharingManager())
        .addCollaborator({ caller: owner, profile: profile("a"), role: "build" }),
  },
  {
    input: "collaborator removal",
    writes: 1,
    setup: ({ impl }) => seedCollaborator(impl, "a"),
    drive: async ({ impl }) => (await impl.getSharingManager()).removeCollaborator(owner, "a", []),
  },
  {
    input: "re-root of kept users (#reRootKeptUsers)",
    // The severance, then the kept user's fresh edge.
    writes: 2,
    setup: ({ impl }) => { seedCollaborator(impl, "a", OWNER, "build"); seedCollaborator(impl, "b", "a"); },
    drive: async ({ impl }) => (await impl.getSharingManager()).removeCollaborator(owner, "a", ["b"]),
  },
  {
    input: "share-link redemption (new collaborator)",
    writes: 1,
    drive: async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      let { key } = await sharing.createShareLink({ caller: owner, role: "use" });
      let before = impl.authzGeneration();
      await sharing.redeemShareKey(
          { rawKey: key, profileId: "n", fetchProfile: async () => profile("n") });
      return impl.authzGeneration() - before;
    },
  },
  {
    input: "share-link redemption (new edge)",
    writes: 1,
    setup: ({ impl }) => seedCollaborator(impl, "a"),
    drive: async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      let { key } = await sharing.createShareLink({ caller: owner, role: "use" });
      let before = impl.authzGeneration();
      await sharing.redeemShareKey(
          { rawKey: key, profileId: "a", fetchProfile: async () => profile("a") });
      return impl.authzGeneration() - before;
    },
  },
  {
    input: "share-link creation",
    writes: 1,
    drive: async ({ impl }) =>
        (await impl.getSharingManager()).createShareLink({ caller: owner, role: "use" }),
  },
  {
    input: "new share-link key",
    writes: 1,
    drive: async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      let { linkId } = await sharing.createShareLink({ caller: owner, role: "use" });
      let before = impl.authzGeneration();
      await sharing.newShareLinkKey({ caller: owner, linkId });
      return impl.authzGeneration() - before;
    },
  },
  {
    input: "share-link revocation",
    writes: 1,
    drive: async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      let { linkId } = await sharing.createShareLink({ caller: owner, role: "use" });
      let before = impl.authzGeneration();
      sharing.revokeShareLink(owner, linkId, []);
      return impl.authzGeneration() - before;
    },
  },
  {
    input: "ownerInvitesOnly set",
    writes: 1,
    setup: ({ impl }) => seedGatekeeper(impl, 1),
    drive: ({ impl }) => impl.authorizeObservation(
        1, { title: "t", description: "d", ownerInvitesOnly: true }, { from: "user" }),
  },
  {
    input: "containsRestrictedData set",
    writes: 1,
    setup: ({ impl }) => seedGatekeeper(impl, 1),
    drive: ({ impl }) => impl.authorizeObservation(
        1, { title: "t", description: "d", containsRestrictedData: true }, { from: "user" }),
  },
  {
    input: "observer record admitted",
    writes: 1,
    setup: ({ impl }) => { seedGatekeeper(impl, 1); seedCollaborator(impl, "a", OWNER, "build"); },
    drive: ({ impl }) => impl.ensureObserver("a", fakeClientUser, "build", {
      configure: async (needs: { gatekeeperId: number }[]) =>
        needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 10 })),
    }),
  },
  {
    input: "observer record changed (new account choice)",
    writes: 1,
    setup: ({ impl }) => {
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedCollaborator(impl, "a", OWNER, "build");
      impl.storage.observers.put({ profileId: "a", observerId: "obs-a", accountChoices: { 1: 10 } });
    },
    drive: ({ impl }) => impl.ensureObserver("a", fakeClientUser, "build", {
      configure: async (needs: { gatekeeperId: number }[]) =>
        needs.map(need => ({ gatekeeperId: need.gatekeeperId, accountId: 20 })),
    }),
  },
  {
    input: "observer record removed (exclusion teardown)",
    writes: 1,
    setup: ({ impl }) => {
      seedGatekeeper(impl, 1);
      // Mallory has an observer record but no reachable role.
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });
    },
    drive: ({ impl }) => impl.authorizeObservation(
        1, { title: "t", description: "d", excludeObservers: ["obs-m"] }, { from: "user" }),
  },
  {
    input: "observer record removed (lost access)",
    writes: 1,
    setup: ({ impl }) => {
      seedGatekeeper(impl, 1);
      impl.storage.observers.put({ profileId: "a", observerId: "obs-a", accountChoices: { 1: 10 } });
    },
    drive: ({ impl }) => impl.tearDownLostObservers(
        [{ profile: profile("a"), addedBy: [], oldRole: "use", newRole: null }]),
  },
  {
    input: "owner set (first open)",
    writes: 1,
    drive: ({ instance }) => openAsOwner(instance),
  },
  {
    input: "owner set (receiveExternalMessage)",
    writes: 1,
    drive: async ({ instance }) => {
      await expect(instance.receiveExternalMessage({
        prompt: "hi", callerEmail: "ext", title: "T", externalChatKey: "k",
      } as any)).rejects.toThrow(/stop after the owner write/);
    },
  },
  {
    input: "operate session marked (not in the §4.1 table)",
    // The owner write on the first open, then the mark that shuts out every other caller.
    writes: 2,
    drive: ({ instance }) => openAsOwner(instance, true),
  },
  {
    input: "workspace deleted (deleteSelf)",
    // deleteSelf's own bump, then the access restart it schedules.
    writes: 2,
    drive: async ({ impl, instance }) => {
      let client = await openAsOwner(instance);
      // The close notice goes to a real RPC peer in production; there is none here.
      client.notifyClosed = async () => {};
      let before = impl.authzGeneration();
      await client.deleteSelf();
      return impl.authzGeneration() - before;
    },
  },
  {
    input: "access restart",
    writes: 1,
    drive: async ({ impl, aborts }) => {
      await impl.scheduleAccessRestart("test restart");
      expect(aborts).toEqual(["test restart"]);
    },
  },
];

describe("authorization generation", () => {
  for (let row of ROWS) {
    it(`raises for: ${row.input}`, async () => {
      await withOverseer(async h => {
        await row.setup?.(h);
        let before = h.impl.authzGeneration();
        let result = await row.drive(h);
        // Rows that set up more authorization state inside drive return their own delta.
        let delta = typeof result === "number" ? result : h.impl.authzGeneration() - before;
        expect(delta).toBe(row.writes);
      });
    });
  }

  it("is read synchronously and persisted in Overseer storage", async () => {
    await withOverseer(async ({ impl }) => {
      expect(impl.authzGeneration()).toBe(0);
      (await impl.getSharingManager())
          .addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
      // No await between the write and this read.
      expect(impl.authzGeneration()).toBe(1);
      expect(impl.storage.authzGeneration.get()).toBe(1);
    });
  });

  it("an unchanged observer record or flag leaves it alone", async () => {
    await withOverseer(async ({ impl }) => {
      seedGatekeeper(impl, 1);
      seedCollaborator(impl, "a", OWNER, "build");
      impl.storage.observers.put({ profileId: "a", observerId: "obs-a", accountChoices: { 1: 10 } });
      await impl.authorizeObservation(1,
          { title: "t", description: "d", containsRestrictedData: true, ownerInvitesOnly: true },
          { from: "user" });
      let before = impl.authzGeneration();

      // A returning observer re-verifying the same choices, and both flags written again.
      await impl.ensureObserver("a", fakeClientUser, "build");
      await impl.authorizeObservation(1,
          { title: "t", description: "d", containsRestrictedData: true, ownerInvitesOnly: true },
          { from: "user" });
      expect(impl.authzGeneration()).toBe(before);
    });
  });

  it("a revoke followed by a regrant raises it twice", async () => {
    await withOverseer(async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      sharing.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
      let { key, linkId } = await sharing.createShareLink({ caller: owner, role: "use" });
      await sharing.redeemShareKey(
          { rawKey: key, profileId: "b", fetchProfile: async () => profile("b") });

      let before = impl.authzGeneration();
      sharing.removeCollaborator(owner, "a", []);
      sharing.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
      expect(sharing.getEffectiveRole("a")).toBe("use");
      expect(impl.authzGeneration()).toBe(before + 2);

      // The same through a share link: revoke it, then grant b again directly.
      sharing.revokeShareLink(owner, linkId, []);
      sharing.addCollaborator({ caller: owner, profile: profile("b"), role: "use" });
      expect(sharing.getEffectiveRole("b")).toBe("use");
      expect(impl.authzGeneration()).toBe(before + 4);
    });
  });

  it("never decreases and survives a Durable Object restart", async () => {
    let name = `authz-generation-restart-${++doCounter}`;
    let seen: number[] = [];
    await withOverseer(async ({ impl }) => {
      let sharing = await impl.getSharingManager();
      seen.push(impl.authzGeneration());
      sharing.addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
      seen.push(impl.authzGeneration());
      await sharing.createShareLink({ caller: owner, role: "use" });
      seen.push(impl.authzGeneration());
      sharing.removeCollaborator(owner, "a", []);
      seen.push(impl.authzGeneration());
    }, name);

    await abortAllDurableObjects();

    await withOverseer(async ({ impl }) => {
      // A new instance reads the persisted value, and later writes continue from it.
      seen.push(impl.authzGeneration());
      (await impl.getSharingManager())
          .addCollaborator({ caller: owner, profile: profile("a"), role: "use" });
      seen.push(impl.authzGeneration());
    }, name);

    expect(seen).toEqual([0, 1, 2, 3, 3, 4]);
  });
});

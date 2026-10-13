// Tests for the auto-approval policy gate around sensitive data.
//
// Auto-approval requires the author's per-action `autoApprovable` verdict AND a user-enabled rule
// for the action's kind. The restricted-data latch must additionally force manual approval no
// matter what -- even when the rule was enabled before the data was read. (The web-fetch
// restriction has no client-reachable surface, so it is not asserted here.)
//
// A rule also runs under the authority of the person who enabled it, so it stops firing once they
// no longer have Build access: removed, downgraded to Use by a revoked share link, cut off
// transitively by the removal of whoever shared with them, or cut off by an `ownerInvitesOnly`
// observation. Each of those revocations restarts the workspace, so those tests reopen it.
//
// The fixture gatekeeper's session drives this through the real ApprovalQueue funnel:
// `writeValue()` submits a `set-value` action with the given verdict and resolves once the action
// is decided, and `applyAction` succeeds, so the drain's submit -> auto-approve -> apply round
// trip is the real one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, restartWorkspace, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// The kind the fixture tags every write with (and advertises via getAutoApprovableActions).
const SET_VALUE = { tag: "set-value", label: "Set value" };

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

const actionState = (label: string) => testActionState(harness, label);

type Workspace = {
  overseer: RpcStub<Overseer>;
  session: RpcStub<TestSession>;
  gatekeeperId: number;
  label: string;
  owner: string;
  workspaceId: string;
};

async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);
  const overseer = await aliceApi.newGadget();
  const gatekeeper = await overseer.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${thingName}`);
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  return {
    overseer,
    session: await gatekeeper.openSession() as RpcStub<TestSession>,
    gatekeeperId: await gatekeeper.getId(),
    label: accountLabel(account),
    owner: alice,
    workspaceId: (await overseer.getMetadata()).id,
  };
}

async function listWrites(ws: Workspace): Promise<Array<ActionLogEntry & { type: "action" }>> {
  // listActions pages newest-first; sort back to creation order, which the tests reason in.
  const { entries } = await ws.overseer.listActions();
  return entries.filter(
      (a): a is ActionLogEntry & { type: "action" } =>
          a.type === "action" && a.gatekeeperId === ws.gatekeeperId)
      .toSorted((a, b) => a.id - b.id);
}

// The drain runs via ctx.waitUntil after submit, so "did not auto-approve" needs a settle window.
// One further RPC round trip plus a beat is far beyond the drain's synchronous storage work.
async function settle(ws: Workspace): Promise<void> {
  await ws.overseer.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

describe("auto-approval policy", () => {
  it.concurrent("auto-approves a rule-enabled, author-approvable action", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "auto-happy");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      // Resolves once the action is decided -- here, by the drain, with no human involved.
      await expect(ws.session.writeValue(1, { autoApprovable: true }))
          .resolves.toEqual(expect.any(Number));

      const applied = await waitFor("the write to be auto-approved", async () => {
        const [write] = await listWrites(ws);
        return write?.state === "approved" ? write : null;
      });
      expect(applied.autoApproved).toBe(true);
    });
  });

  it.concurrent("a pre-latch auto-approval rule stops firing once the workspace reads sensitive data",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "pre-latch");
      // The catalog lists only connections some gadget binds (pure storage writes; no gadget code
      // runs), so bind this one to make its rule visible below. Unshared, so no restart.
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      await ws.session.readValue(true);

      // Actions still pend, but the rule the user enabled before the latch must not fire.
      // The write resolves only once decided, so it is held rather than awaited here.
      const write = ws.session.writeValue(2, { autoApprovable: true });
      await settle(ws);
      const [held] = await listWrites(ws);
      expect(held.state).toBe("pending");

      // The catalog still names each existing rule's connection so it stays identifiable and
      // revocable in the UI.
      await expect(ws.overseer.listPreApprovableActions()).resolves.toEqual([
        expect.objectContaining({
          gatekeeperId: ws.gatekeeperId, actionKind: SET_VALUE, alreadyEnabled: true,
        }),
      ]);

      // Manual approval still works: the human is the intended path.
      await ws.overseer.approveAction(held.id);
      await expect(write).resolves.toEqual(expect.any(Number));
      const [approved] = await listWrites(ws);
      expect(approved.state).toBe("approved");
      expect(approved.autoApproved).toBeFalsy();
    });
  });

  it.concurrent("removing an auto-approval rule returns eligible writes to manual approval",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "auto-off");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      await ws.session.writeValue(1, { autoApprovable: true });
      await waitFor("the first write to be applied", async () =>
        (await actionState(ws.label)).applyCount === 1 || null);
      await expect(actionState(ws.label)).resolves.toEqual({ pending: [], value: 1, applyCount: 1 });
      const [first] = await listWrites(ws);
      expect(first).toMatchObject({ state: "approved", autoApproved: true });

      await ws.overseer.removeAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE.tag);
      await expect(ws.overseer.listAutoApprovedActionKinds()).resolves.toEqual([]);

      const write = ws.session.writeValue(2, { autoApprovable: true });
      await waitFor("the second write to be submitted", async () =>
        (await listWrites(ws)).length === 2 || null);
      await settle(ws);
      const [, held] = await listWrites(ws);
      expect(held.state).toBe("pending");
      expect(held.autoApproved).toBeFalsy();
      await expect(actionState(ws.label)).resolves.toEqual(
          { pending: [{ id: 2, value: 2 }], value: 1, applyCount: 1 });

      await ws.overseer.approveAction(held.id);
      await expect(write).resolves.toBe(2);
      const [, approved] = await listWrites(ws);
      expect(approved.state).toBe("approved");
      expect(approved.autoApproved).toBeFalsy();
      await expect(actionState(ws.label)).resolves.toEqual({ pending: [], value: 2, applyCount: 2 });
    });
  });

  it.concurrent("enabling a rule applies the eligible writes already pending, and leaves manual ones",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "drain-pending");
      // A fixture write resolves once submitted. Eligible first: the drain stops at the first
      // ineligible pending action.
      await expect(ws.session.writeValue(1, { autoApprovable: true })).resolves.toBe(1);
      await expect(ws.session.writeValue(2)).resolves.toBe(2);
      expect((await listWrites(ws)).map(write => write.state)).toEqual(["pending", "pending"]);
      await expect(actionState(ws.label)).resolves.toEqual(
          { pending: [{ id: 1, value: 1 }, { id: 2, value: 2 }], applyCount: 0 });

      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);

      await waitFor("the eligible write to be approved", async () =>
        (await listWrites(ws))[0]?.state === "approved" || null);
      await settle(ws);
      const [applied, held] = await listWrites(ws);
      expect(applied).toMatchObject({ state: "approved", autoApproved: true });
      expect(held.state).toBe("pending");
      await expect(actionState(ws.label)).resolves.toEqual(
          { pending: [{ id: 2, value: 2 }], value: 1, applyCount: 1 });
    });
  });
});

type Member = Disposable & {
  name: string;
  /**
   * Open the workspace, through `shareKey` when given, answering observer prompts. Each open is on
   * a fresh connection, since a revocation restart closes the connections that reached the old
   * instance; disposing the member closes them.
   */
  open(shareKey?: string): Promise<RpcStub<Overseer>>;
};

// Sign someone up with their own fixture account, which opening a workspace bound to a fixture
// connection asks them to choose.
async function member(publicApi: RpcStub<PublicApi>, ws: Workspace, prefix: string)
    : Promise<Member> {
  const [name] = nextUsernames(prefix);
  const account = await provisionAccount(await signUp(publicApi, name));
  const connections = new DisposableStack();
  return {
    name,
    async open(shareKey) {
      const api = await logIn(connections.use(connect(harness.url)), name);
      using callback = stubFor(
          new ObserverConfigRecorder().alwaysChoose(account.id, MAX_OBSERVER_PROMPTS));
      return await api.openGadget(ws.workspaceId, shareKey, callback);
    },
    [Symbol.dispose]: () => connections.dispose(),
  };
}

// A Build collaborator the owner adds directly, who enables the fixture's rule.
async function enablingCollaborator(publicApi: RpcStub<PublicApi>, ws: Workspace)
    : Promise<Member> {
  const enabler = await member(publicApi, ws, "enabler");
  await ws.overseer.addCollaborator(enabler.name, "build");
  using enablerWs = await enabler.open();
  await enablerWs.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
  return enabler;
}

// A revocation restarts the workspace: wait for the old instance to fall, then reopen it as the
// owner on a fresh connection, which the returned workspace's `close` releases.
async function reopenAfterRestart(ws: Workspace): Promise<Workspace & { close(): void }> {
  await waitFor("the restart to fell the old workspace instance", () =>
    ws.session.readValue().then(() => null, () => true));
  return waitFor("the workspace to come back after the restart", async () => {
    const publicApi = connect(harness.url);
    try {
      const api = await logIn(publicApi, ws.owner);
      const overseer = await api.openGadget(ws.workspaceId);
      const gatekeeper = await overseer.getGatekeeperById(ws.gatekeeperId);
      const session = await gatekeeper.openSession() as RpcStub<TestSession>;
      // Probe with a benign read, so a session felled by the abort retries here.
      await session.readValue();
      return { ...ws, overseer, session, close: () => publicApi[Symbol.dispose]() };
    } catch {
      publicApi[Symbol.dispose]();
      return null;
    }
  });
}

// Submit an eligible write and return its log entry once the drain has had its chance. The write
// is not awaited: a promise that outlives the workspace instance rejects when a restart fells it.
async function submitEligibleWrite(ws: Workspace, value: number) {
  const before = (await listWrites(ws)).length;
  ws.session.writeValue(value, { autoApprovable: true }).catch(() => {});
  await waitFor(`the write of ${value} to be submitted`, async () =>
    (await listWrites(ws)).length > before || null);
  await settle(ws);
  return (await listWrites(ws)).at(-1)!;
}

const decision = (write: ActionLogEntry & { type: "action" }) =>
  ({ state: write.state, autoApproved: write.autoApproved, resolvedBy: write.resolvedBy?.id });
const HELD = { state: "pending", autoApproved: undefined, resolvedBy: undefined };

describe("auto-approval follows the enabler's current access", () => {
  it.concurrent("[1] a removed collaborator's rule no longer applies writes in their name",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-removed");
      using enabler = await enablingCollaborator(publicApi, ws);

      await ws.overseer.removeCollaborator(enabler.name, []);
      const reopened = await reopenAfterRestart(ws);
      try {
        const held = await submitEligibleWrite(reopened, 1);
        expect(decision(held)).toEqual(HELD);
        await expect(actionState(ws.label)).resolves.toEqual(
            { pending: [{ id: 1, value: 1 }], applyCount: 0 });

        // A current Build user (the owner) re-enabling the rule applies the held write once, in
        // their own name.
        await reopened.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
        const applied = await waitFor("the held write to be applied", async () => {
          const write = (await listWrites(reopened)).find(entry => entry.id === held.id);
          return write?.state === "approved" ? write : null;
        });
        expect(decision(applied)).toEqual(
            { state: "approved", autoApproved: true, resolvedBy: ws.owner });
        await expect(actionState(ws.label)).resolves.toEqual(
            { pending: [], value: 1, applyCount: 1 });
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[2] a rule stops firing once its enabler is downgraded to Use by a link revoke",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-downgraded");
      const { key, linkId } = await ws.overseer.createShareLink("build", "build link");
      using enabler = await member(publicApi, ws, "enabler");
      {
        using enablerWs = await enabler.open(key);
        await ws.overseer.addCollaborator(enabler.name, "use");
        await expect(enablerWs.getMetadata()).resolves.toMatchObject({ role: "build" });
        await enablerWs.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      }

      const affected = await ws.overseer.revokeShareLink(linkId, []);
      expect(affected).toContainEqual(expect.objectContaining({
        profile: expect.objectContaining({ id: enabler.name }), oldRole: "build", newRole: "use",
      }));
      const reopened = await reopenAfterRestart(ws);
      try {
        expect(decision(await submitEligibleWrite(reopened, 1))).toEqual(HELD);
        expect((await actionState(ws.label)).applyCount).toBe(0);
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[2b] a rule stops firing once its enabler loses access transitively", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-transitive");
      using sharer = await member(publicApi, ws, "sharer");
      using enabler = await member(publicApi, ws, "enabler");
      await ws.overseer.addCollaborator(sharer.name, "build");
      {
        using sharerWs = await sharer.open();
        await sharerWs.addCollaborator(enabler.name, "build");
        using enablerWs = await enabler.open();
        await enablerWs.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      }

      const affected = await ws.overseer.removeCollaborator(sharer.name, []);
      expect(affected).toContainEqual(expect.objectContaining({
        profile: expect.objectContaining({ id: enabler.name }), oldRole: "build", newRole: null,
      }));
      const reopened = await reopenAfterRestart(ws);
      try {
        expect(decision(await submitEligibleWrite(reopened, 1))).toEqual(HELD);
        expect((await actionState(ws.label)).applyCount).toBe(0);
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[2c] a rule stops firing once an ownerInvitesOnly observation cuts its enabler off",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-owner-invites-only");
      const { key } = await ws.overseer.createShareLink("build", "before ownerInvitesOnly");
      using enabler = await member(publicApi, ws, "enabler");
      {
        using enablerWs = await enabler.open(key);
        await enablerWs.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      }

      // Not restricted: only ownerInvitesOnly is set, so the restricted latch plays no part.
      await expect(ws.session.readValue(false, true)).resolves.toBe(42);
      const reopened = await reopenAfterRestart(ws);
      try {
        await expect(reopened.overseer.getMetadata()).resolves.toMatchObject(
            { ownerInvitesOnly: true, containsRestrictedData: false });
        expect(decision(await submitEligibleWrite(reopened, 1))).toEqual(HELD);
        expect((await actionState(ws.label)).applyCount).toBe(0);
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[3] clearing a manual gate does not apply a queued write in a removed enabler's name",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-queued");
      // The manual gate first, then an eligible write the in-order drain stops behind.
      await expect(ws.session.writeValue(1)).resolves.toBe(1);
      using enabler = await enablingCollaborator(publicApi, ws);
      await submitEligibleWrite(ws, 2);
      expect((await listWrites(ws)).map(decision)).toEqual([HELD, HELD]);

      await ws.overseer.removeCollaborator(enabler.name, []);
      const reopened = await reopenAfterRestart(ws);
      try {
        const [gate] = await listWrites(reopened);
        await reopened.overseer.approveAction(gate.id);
        await waitFor("the gate to be applied", async () =>
          (await actionState(ws.label)).applyCount > 0 || null);
        await settle(reopened);
        const [applied, queued] = await listWrites(reopened);
        expect(decision(applied)).toEqual(
            { state: "approved", autoApproved: false, resolvedBy: ws.owner });
        expect(decision(queued)).toEqual(HELD);
        await expect(actionState(ws.label)).resolves.toEqual(
            { pending: [{ id: 2, value: 2 }], value: 1, applyCount: 1 });
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[4] a rule a current Build user re-enables applies once, in their name", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-reenabled");
      using enabler = await enablingCollaborator(publicApi, ws);

      await ws.overseer.removeCollaborator(enabler.name, []);
      const reopened = await reopenAfterRestart(ws);
      try {
        await reopened.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
        expect(decision(await submitEligibleWrite(reopened, 1))).toEqual(
            { state: "approved", autoApproved: true, resolvedBy: ws.owner });
        await expect(actionState(ws.label)).resolves.toEqual(
            { pending: [], value: 1, applyCount: 1 });
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[5] the listings stop reporting a removed enabler's rule", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-listings");
      // The catalog lists only connections some gadget binds.
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);
      using enabler = await enablingCollaborator(publicApi, ws);
      await expect(ws.overseer.listAutoApprovedActionKinds()).resolves.toEqual(
          [{ gatekeeperId: ws.gatekeeperId, actionKind: SET_VALUE }]);

      await ws.overseer.removeCollaborator(enabler.name, []);
      const reopened = await reopenAfterRestart(ws);
      try {
        await expect(reopened.overseer.listAutoApprovedActionKinds()).resolves.toEqual([]);
        await expect(reopened.overseer.listPreApprovableActions()).resolves.toEqual([
          expect.objectContaining({
            gatekeeperId: ws.gatekeeperId, actionKind: SET_VALUE, alreadyEnabled: false,
          }),
        ]);
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[5b] re-adding a removed enabler does not revive their rule; re-enabling does",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "enabler-readded");
      using enabler = await enablingCollaborator(publicApi, ws);

      await ws.overseer.removeCollaborator(enabler.name, []);
      const reopened = await reopenAfterRestart(ws);
      try {
        // Revocation is reversible: re-adding restores the enabler's access, but not the rule that
        // was deleted when they lost it.
        await reopened.overseer.addCollaborator(enabler.name, "build");
        await expect(reopened.overseer.listAutoApprovedActionKinds()).resolves.toEqual([]);
        const held = await submitEligibleWrite(reopened, 1);
        expect(decision(held)).toEqual(HELD);

        // Enabling it again is a fresh decision by someone who has Build now.
        {
          using enablerWs = await enabler.open();
          await enablerWs.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
        }
        const applied = await waitFor("the held write to be applied", async () => {
          const write = (await listWrites(reopened)).find(entry => entry.id === held.id);
          return write?.state === "approved" ? write : null;
        });
        expect(decision(applied)).toEqual(
            { state: "approved", autoApproved: true, resolvedBy: enabler.name });
        expect((await actionState(ws.label)).applyCount).toBe(1);
      } finally {
        reopened.close();
      }
    });
  });

  it.concurrent("[6b] the owner's rule still fires on a restarted workspace only a collaborator opened",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "owner-cold");
      using builder = await member(publicApi, ws, "builder");
      await ws.overseer.addCollaborator(builder.name, "build");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);

      // Restart without the owner reopening: the new instance learns the owner's profile only
      // through the collaborator's open.
      await restartWorkspace(harness.url, ws.overseer);
      await waitFor("the restart to fell the old workspace instance", () =>
        ws.session.readValue().then(() => null, () => true));
      using builderWs = await waitFor("the collaborator to open the restarted workspace", () =>
        builder.open().then(opened => opened, () => null));
      const session = await (await builderWs.getGatekeeperById(ws.gatekeeperId)).openSession() as
          RpcStub<TestSession>;
      const cold = { ...ws, overseer: builderWs, session };
      expect(decision(await submitEligibleWrite(cold, 1))).toEqual(
          { state: "approved", autoApproved: true, resolvedBy: ws.owner });
      expect((await actionState(ws.label)).applyCount).toBe(1);
    });
  });
});

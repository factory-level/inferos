// Write receipts (FAC-97 part 2): a gatekeeper write can hand its caller the kernel's receipt
// `{actionId, status()}`, so a gadget or agent can tell a queued write from a done one. The status
// is the action log's own outcome (`actionOutcome`), its bounded result and the provider's words.
// The receipt is a capability: there is no lookup by id, so a caller reads only receipts it holds.
// Over the integration-test gatekeeper, held as a gadget holds a session.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const control = <T>(route: string, body: object) => testControl<T>(harness, route, body);

/** A workspace with one test connection, and a session on it held as a gadget holds one. */
async function setUp(tag: string) {
  const stack = new DisposableStack();
  const [username] = nextUsernames(tag);
  const api = await signUp(stack.use(connect(harness.url)), username!);
  stack.use(api);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const ws = stack.use(await api.newGadget()) as RpcStub<Overseer>;
  const gatekeeper = stack.use(await ws.newGatekeeper(account.id, `https://gadgets-test.example/things/${tag}`));
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const session = stack.use(await gatekeeper.openSession()) as RpcStub<TestSession>;
  return Object.assign(stack, { ws, session, label: accountLabel(account) });
}

async function pendingIdFor(ws: RpcStub<Overseer>, value: number) {
  const page = await ws.listActions({ filter: "pending" });
  const entry = page.entries.find(e => e.description.title === `Set the test value to ${value}`);
  if (!entry) throw new Error(`No pending write of ${value}`);
  return entry.id;
}

it("a queued write's receipt says waiting; after approval it says succeeded, with the provider's bounded result", async () => {
  using t = await setUp("receiptok");
  const receipt = await t.session.writeValueWithReceipt(31);
  expect(receipt.actionId).toMatch(/^action-\d+$/);
  expect(await receipt.status()).toEqual({ outcome: "waiting" });

  await control("result-next-apply", { label: t.label, result: { appliedValue: 31, revision: "r3" } });
  await t.ws.approveAction(await pendingIdFor(t.ws, 31));
  expect(await receipt.status()).toEqual({ outcome: "succeeded", result: { appliedValue: 31, revision: "r3" } });
  // Simulation is unchanged: the queued write read as applied all along; the receipt is what tells.
});

it("a provider's refusal reads as failed with the provider's words; a person's rejection reads as rejected", async () => {
  using t = await setUp("receiptrefused");
  const refused = await t.session.writeValueWithReceipt(32);
  await control("fail-next-apply", { label: t.label, reason: "STALE_REVISION: the issue changed since it was read.", outcome: "refused" });
  await expect(t.ws.approveAction(await pendingIdFor(t.ws, 32))).rejects.toThrow("STALE_REVISION");
  expect(await refused.status()).toEqual({ outcome: "failed", reason: "STALE_REVISION: the issue changed since it was read." });

  const declined = await t.session.writeValueWithReceipt(33);
  await t.ws.rejectAction(await pendingIdFor(t.ws, 33));
  expect(await declined.status()).toEqual({ outcome: "rejected" });
});

it("an existing write that ignores the receipt works as before", async () => {
  using t = await setUp("receiptvoid");
  // The fixture's old-style write returns its own staging id and drops the receipt.
  const id = await t.session.writeValue(34);
  expect(typeof id).toBe("number");
  await t.ws.approveAction(await pendingIdFor(t.ws, 34));
  const entry = (await t.ws.listActions({ filter: "action" })).entries.find(e => e.description.title === "Set the test value to 34");
  expect(entry).toMatchObject({ state: "approved" });
});

it("a receipt reads only its own action, and nothing reads a receipt by id", async () => {
  using a = await setUp("receipta");
  using b = await setUp("receiptb");
  const mine = await a.session.writeValueWithReceipt(35);
  const theirs = await b.session.writeValueWithReceipt(36);
  await b.ws.rejectAction(await pendingIdFor(b.ws, 36));
  // Each receipt follows its own action, whatever happens to the other workspace's.
  expect(await mine.status()).toEqual({ outcome: "waiting" });
  expect(await theirs.status()).toEqual({ outcome: "rejected" });
  // No session, connection or workspace method takes a receipt or action id to read a status.
  for (const target of [a.session, a.ws] as unknown as Record<string, unknown>[]) {
    for (const name of ["status", "getReceipt", "receiptStatus", "actionStatus", "getActionStatus", "readReceipt"]) {
      expect(typeof (target as Record<string, unknown>)[name] === "function"
        ? await Promise.resolve((target[name] as (id: string) => unknown)(mine.actionId)).then(() => "answered", () => "refused")
        : "absent").not.toBe("answered");
    }
  }
});

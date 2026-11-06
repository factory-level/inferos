// FAC-116 (inferos ADR 0012, proposed): a person reads back the runs they asked one trigger for,
// after any reconnect (`listRequestedRuns`): their own requests only, newest first, each with its
// outcome as `getRequestedRun` reads it and no report. Nobody else's runs, and no other trigger's.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const PERSON = "operator-profile";
const OTHER = "other-operator-profile";
const GADGET = 3;
const HOOK = 11;
const OTHER_HOOK = 12;
const CONNECTION = 7;
const commit = (n: number) => n.toString(16).padStart(40, "0");
const head = (id: number) => (id === GADGET ? commit(1) : undefined);

async function withImpl<T>(name: string, fn: (impl: any) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) =>
    fn((instance as any).impl));
}

/** Two live triggers on one published definition, each with a control listing PERSON and OTHER. */
function triggers(impl: any) {
  impl.storage.gatekeepers.put({
    id: CONNECTION, resourceTitle: "Scheduled Tasks", class: {} as any,
    creationSpec: { type: "gatekeeper", vendorId: "scheduler", resourceUrl: "scheduler://tasks", typeUrlPattern: "scheduler://*" },
  });
  let store = impl.workflowDefinitionStore();
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, head);
  store.publish(ADA, saved.id, 1);
  for (let hook of [HOOK, OTHER_HOOK]) {
    impl.storage.boundHooks.put({
      id: hook, actionId: 1, gatekeeperId: CONNECTION, gadgetId: GADGET, vendorId: "scheduler",
      controller: null, callback: null, description: { title: `Trigger ${hook}` }, enabled: true,
    });
    store.pinTrigger(ADA.id, hook, GADGET, { definitionId: saved.id, revision: 1 });
    store.setControl(ADA, hook, { label: "Run refunds", invokers: [PERSON, OTHER] });
  }
  return store;
}

/** One run `profileId` asked trigger `hook` for, fired at `at`; returns its invocation and delivery ids. */
function asked(impl: any, store: any, profileId: string, hook: number, at: Date) {
  let invocation = store.beginInvocation(profileId, hook, null);
  let delivery = store.fire(hook, GADGET, head, () => true, invocation.id)!;
  let stored = impl.storage.workflowDeliveries.get(delivery.deliveryId);
  impl.storage.workflowDeliveries.put({ ...stored, at });
  return { invocationId: invocation.id as string, deliveryId: delivery.deliveryId as number };
}

describe("the runs a person asked a trigger for, read back (FAC-116)", () => {
  it("lists the caller's own runs of that trigger, newest first, each with its outcome and no report", async () => {
    let name = `requested-runs-${crypto.randomUUID()}`;
    await withImpl(name, impl => {
      let store = triggers(impl);
      let now = Date.now();
      let older = asked(impl, store, PERSON, HOOK, new Date(now - 2000));
      let newer = asked(impl, store, PERSON, HOOK, new Date(now - 1000));
      let others = asked(impl, store, OTHER, HOOK, new Date(now - 500));
      let elsewhere = asked(impl, store, PERSON, OTHER_HOOK, new Date(now - 100));
      store.recordResult(older.deliveryId, { outcome: "succeeded", report: { summary: "refunded 3" } });

      let mine = impl.listRequestedRuns(PERSON, HOOK);
      expect(mine.map((run: any) => run.invocationId)).toEqual([newer.invocationId, older.invocationId]);
      expect(mine.map((run: any) => run.outcome)).toEqual(["queued", "succeeded"]);
      // Exactly what getRequestedRun reads of each: no report, nothing of anyone else's.
      expect(mine[1]).toEqual(impl.getRequestedRun(PERSON, older.invocationId));
      expect(JSON.stringify(mine)).not.toContain("refunded");
      expect(impl.listRequestedRuns(OTHER, HOOK).map((run: any) => run.invocationId)).toEqual([others.invocationId]);
      expect(impl.listRequestedRuns(PERSON, OTHER_HOOK).map((run: any) => run.invocationId)).toEqual([elsewhere.invocationId]);
      expect(impl.listRequestedRuns("someone-else", HOOK)).toEqual([]);
      expect(impl.listRequestedRuns(PERSON, 999)).toEqual([]);
    });
  });

  it("reads the same after a reconnect, from storage alone", async () => {
    let name = `requested-runs-reconnect-${crypto.randomUUID()}`;
    let invocationId = await withImpl(name, impl => {
      let store = triggers(impl);
      let made = asked(impl, store, PERSON, HOOK, new Date());
      store.recordResult(made.deliveryId, { outcome: "failed", reason: "runtime-error" });
      return made.invocationId;
    });
    // A fresh call to the workspace: the person came back later.
    expect(await withImpl(name, impl => impl.listRequestedRuns(PERSON, HOOK)))
      .toMatchObject([{ invocationId, outcome: "failed", reason: "runtime-error" }]);
  });

  it("returns at most the newest REQUESTED_RUNS_MAX", async () => {
    let name = `requested-runs-bound-${crypto.randomUUID()}`;
    await withImpl(name, impl => {
      let store = triggers(impl);
      let now = Date.now();
      // One real request, then copies of its delivery under fresh ids: the per-person rate
      // refuses 25 real requests in a row.
      let first = asked(impl, store, PERSON, HOOK, new Date(now - 100_000));
      let stored = impl.storage.workflowDeliveries.get(first.deliveryId);
      let ids = [first.invocationId];
      for (let i = 1; i < 25; i++) {
        let invocationId = crypto.randomUUID();
        impl.storage.workflowDeliveries.put({
          ...stored, id: 5000 + i, at: new Date(now - 100_000 + i * 1000),
          invocation: { ...stored.invocation, id: invocationId },
          run: { ...stored.run, runId: crypto.randomUUID() },
        });
        ids.push(invocationId);
      }
      let listed = impl.listRequestedRuns(PERSON, HOOK);
      expect(listed).toHaveLength(20);
      expect(listed.map((run: any) => run.invocationId)).toEqual(ids.slice(5).toReversed());
    });
  });
});

// FAC-124 #416 round 1: a real Overseer wakes for the definitions it must sweep. An idle workspace
// whose only work is a new dynamic definition gets an alarm at its expiry; unpinning a definition
// that already expired sets the alarm, and running it deletes the definition.
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
const GADGET = 3;
const HOOK = 11;
const head = (id: number) => (id === GADGET ? "1".padStart(40, "0") : undefined);

async function withImpl<T>(fn: (impl: any) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`expiry-alarm-${crypto.randomUUID()}`),
    async (instance: OverseerDurableObject) => fn((instance as any).impl));
}

describe("the alarm for dynamic definitions (FAC-124)", () => {
  it("wakes an idle workspace at a new dynamic definition's expiry", async () => {
    await withImpl(async impl => {
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
      let made = impl.workflowDefinitionStore().save(ADA, { title: "One-off", gadgetId: GADGET, retain: false }, head, "build");
      expect(await impl.ctx.storage.getAlarm()).toBe(made.expiresAt.getTime());
      // Saving it again retains it: nothing left to wake for.
      impl.workflowDefinitionStore().save(ADA, { id: made.id, title: "Kept", gadgetId: GADGET }, head, "build");
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("sets the alarm when an expired definition's pin goes, and the alarm deletes it", async () => {
    await withImpl(async impl => {
      let expired = Date.now() - 60_000;
      impl.storage.workflowDefinitions.put({
        id: "gone", title: "One-off", owner: ADA, published: null, expiresAt: new Date(expired),
        revisions: [{ revision: 1, source: { kind: "gadget", gadgetId: GADGET, commitId: head(GADGET) }, savedAt: new Date(expired - 1) }],
      });
      impl.storage.workflowTriggerPins.put({ hookId: HOOK, definitionId: "gone", revision: 1, mode: "pinned" });
      // While pinned it is scheduled: nothing to wake for.
      impl.workflowDefinitionStore().sweepExpired();
      expect(impl.storage.workflowDefinitions.get("gone")).toBeDefined();

      impl.workflowDefinitionStore().pinTrigger(ADA.id, HOOK, GADGET, null);
      let alarm = await impl.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(Date.now());
      await impl.runAlarmTasks();
      expect(impl.storage.workflowDefinitions.get("gone")).toBeUndefined();
    });
  });

  it("builds the legacy history index on the first alarm sweep", async () => {
    await withImpl(async impl => {
      let old = new Date(0);
      for (let id = 0; id < 1_000; id++) {
        impl.storage.workflowDeliveries.put({
          id,
          hookId: HOOK,
          definitionId: "legacy-definition",
          revision: 1,
          commitId: head(GADGET),
          at: old,
          historyOwnerProfileId: ADA.id,
          result: { outcome: "succeeded", settledAt: old },
        });
      }
      impl.storage.nextWorkflowDeliveryId.put(1_000);
      impl.storage.workflowDeliveryCount.put(null);

      await impl.runAlarmTasks();

      // The alarm runs the regular and final temporary sweeps; both use the same built index and
      // each removes at most one 100-record batch from the legacy backlog.
      expect(impl.storage.workflowDeliveryCount.get()).toEqual({ count: 800, indexed: true });
      expect([...impl.storage.workflowDeliveryExpiries.list()]).toHaveLength(800);
    });
  });
});

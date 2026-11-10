// FAC-111 acceptance 2: a run admitted in a real Overseer Durable Object reloads after the object
// restarts (`abortAllDurableObjects`, as the FAC-139 restart checks do for the Workers) with the
// same company, requester, executor and starting revision, read from its stored record alone:
// no editable page, chat or current pin is consulted, and the trigger re-pinned to a new revision
// meanwhile changes nothing about the run.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { WorkspaceWorkflowDefinitionStore } from "../src/workflow-definition-store.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const OPERATOR = "operator-profile";
const COMPANY = "0b7e2c3a-1f00-4a00-8000-00000000000a";
const GADGET = 3;
const HOOK = 11;
const commit = (n: number) => n.toString(16).padStart(40, "0");

/** Runs `fn` with the workspace's own workflow store, in a fresh stub of the named Overseer. */
async function withStore<T>(name: string, fn: (store: WorkspaceWorkflowDefinitionStore) => T): Promise<T> {
  let stub = env.TEST_OVERSEER.getByName(name);
  return runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: { workflowDefinitionStore(): WorkspaceWorkflowDefinitionStore } }).impl;
    return fn(impl.workflowDefinitionStore());
  });
}

describe("an admitted run across a Durable Object restart (FAC-111)", () => {
  it("reloads with the same scope and starting revision from its record alone", async () => {
    let name = `workflow-run-restart-${crypto.randomUUID()}`;
    const headAt1 = (id: number) => (id === GADGET ? commit(1) : undefined);
    let { runId, definitionId, before } = await withStore(name, store => {
      let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, headAt1, "build");
      store.publish(ADA, saved.id, 1);
      store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
      store.setControl(ADA, HOOK, { label: "Issue refund", invokers: [OPERATOR] });
      let invocation = store.beginInvocation(OPERATOR, HOOK, COMPANY);
      let delivery = store.fire(HOOK, GADGET, headAt1, () => "build" as const, invocation.id)!;
      return { runId: delivery.run!.runId, definitionId: saved.id, before: store.run(delivery.run!.runId) };
    });
    expect(before).toMatchObject({ company: COMPANY, revision: 1, commitId: commit(1) });

    await abortAllDurableObjects();

    let reloaded = await withStore(name, store => store.run(runId));
    expect(reloaded).toEqual(before);

    // The definition moves on and the trigger is re-pinned; another restart; the run is unchanged.
    const headAt2 = (id: number) => (id === GADGET ? commit(2) : undefined);
    await withStore(name, store => {
      store.save(ADA, { id: definitionId, title: "Refund", gadgetId: GADGET }, headAt2, "build");
      store.publish(ADA, definitionId, 2);
      store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId, revision: 2 });
    });
    await abortAllDurableObjects();
    expect(await withStore(name, store => store.run(runId))).toEqual(before);
  });
});

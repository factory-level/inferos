// FAC-116 (inferos ADR 0012, proposed): a requested run's first final result is delivered to its
// requester's page, at most once per invocation, when the published page they're shown wires it to
// a navigation the console shows; the requester and their role are re-checked first, and
// `delivery.canvas` records whether it moved the page. Over a real Overseer Durable Object, with
// the requester's user DO and the published console stood in for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { canvasRunEvent, parseCanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsole } from "@gadgets/workshop-shared/operate-console";
import type { RunNavigationOutcome, RunNavigationRequest } from "@gadgets/workshop-shared/operate-session";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADA = { type: "user" as const, id: "ada-profile", name: "Ada" };
const PERSON = "operator-profile";
const GADGET = 3;
const HOOK = 11;
const CONNECTION = 7;
const commit = (n: number) => n.toString(16).padStart(40, "0");
const head = (id: number) => (id === GADGET ? commit(1) : undefined);

const CONSOLE = {
  id: "intake", revision: "3", title: "Intake", fullChat: "off", published: null,
  views: [
    { id: "v-form", title: "Form", type: "rollup", screens: ["form", "review"] },
    { id: "v-done", title: "Done", type: "screen", screen: "done" },
  ],
} as unknown as OperateConsole;

/** Screen "form": the trigger's success goes to "done", its failure to "review". */
const FORM = parseCanvasPage({
  schemaVersion: 2, id: "form", revision: "0", title: "Form", children: ["main"], attachments: [], nodes: [
    { nodeType: "object", id: "main", title: "Main", columns: 1, children: ["w"], attachments: [] },
    { nodeType: "widget", id: "w", kind: "inferos.gadget", version: 1, targetRef: `gadget:${GADGET}`, size: "normal", params: {},
      attachments: [
        { id: "on-done", version: 1, on: canvasRunEvent("run-succeeded", HOOK), effect: { kind: "navigate", page: "done" } },
        { id: "on-fail", version: 1, on: canvasRunEvent("run-failed", HOOK), effect: { kind: "navigate", page: "review" } },
      ] },
  ],
});

let restore: (() => void)[] = [];
afterEach(() => { for (let undo of restore.splice(0)) undo(); });

function onPrototype(impl: any, name: string, value: unknown) {
  let proto = Object.getPrototypeOf(impl);
  let had = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  restore.push(() => {
    if (had) Object.defineProperty(proto, name, had);
    else delete proto[name];
  });
}

async function withImpl<T>(name: string, fn: (impl: any) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) =>
    fn((instance as any).impl));
}

type Setup = { console?: Partial<{ consoleId: string; revision: string; workspaceId: string }>; answer?: RunNavigationOutcome };

/**
 * A live trigger whose control lists PERSON, who owns the workspace; one run they asked for; and
 * their page showing screen "form" of the published console, with each move recorded.
 */
function setUp(impl: any, options: Setup = {}) {
  let calls: RunNavigationRequest[] = [];
  let fetched: string[] = [];
  let workspaceId = impl.ctx.id.toString();
  let user = {
    getOperatePage: async () => ({
      seq: 5, state: { flow: null, console: { workspaceId, consoleId: "intake", source: "published", revision: "3",
        viewId: "v-form", screenId: "form", ...options.console } },
    }),
    applyRunNavigation: async (request: RunNavigationRequest) => { calls.push(request); return options.answer ?? "shown"; },
  };
  impl.users = {
    idFromName: (name: string) => ({ name, toString: () => `user:${name}` }),
    get: (id: { name: string }) => { fetched.push(id.name); return user; },
  };
  impl.ownerId = `user:${PERSON}`;
  // As the console store reads them: this workspace publishes only console "intake".
  onPrototype(impl, "publishedConsoleForRun", (consoleId: string) => consoleId === "intake"
    ? { saved: CONSOLE, page: (screenId: string) => (screenId === "form" ? FORM : null) }
    : { saved: null, page: () => null });
  impl.storage.gatekeepers.put({
    id: CONNECTION, resourceTitle: "Scheduled Tasks", class: {} as any,
    creationSpec: { type: "gatekeeper", vendorId: "scheduler", resourceUrl: "scheduler://tasks", typeUrlPattern: "scheduler://*" },
  });
  impl.storage.boundHooks.put({
    id: HOOK, actionId: 1, gatekeeperId: CONNECTION, gadgetId: GADGET, vendorId: "scheduler",
    controller: null, callback: null, description: { title: "Refunds" }, enabled: true,
  });
  let store = impl.workflowDefinitionStore();
  let saved = store.save(ADA, { title: "Refund", gadgetId: GADGET }, head);
  store.publish(ADA, saved.id, 1);
  store.pinTrigger(ADA.id, HOOK, GADGET, { definitionId: saved.id, revision: 1 });
  store.setControl(ADA, HOOK, { label: "Run refunds", invokers: [PERSON] });
  let invocation = store.beginInvocation(PERSON, HOOK, null);
  let delivery = store.fire(HOOK, GADGET, head, () => true, invocation.id)!;
  let deliveryId = delivery.deliveryId as number;
  let canvas = () => impl.storage.workflowDeliveries.get(deliveryId)?.delivery?.canvas;
  /** Settle the run to `outcome`, deliver it, and wait for the delivery to finish. */
  let settle = async (outcome: string) => {
    store.recordResult(deliveryId, { outcome });
    impl.deliverRunToCanvas(deliveryId);
    await vi.waitFor(() => expect(canvas()).not.toBe("pending"));
  };
  return { calls, fetched, store, invocationId: invocation.id as string, deliveryId, canvas, settle };
}

describe("a requested run's result reaching its requester's page (FAC-116)", () => {
  it("moves the requester's open page once, to the screen the result is wired to, and records it delivered", async () => {
    await withImpl(`run-delivery-${crypto.randomUUID()}`, async impl => {
      let t = setUp(impl);
      await t.settle("succeeded");
      expect(t.calls).toEqual([{
        workspaceId: impl.ctx.id.toString(), consoleId: "intake", revision: "3", pageSeq: 5,
        invocationId: t.invocationId, attachmentId: "on-done", move: { type: "openView", viewId: "v-done" },
      }]);
      expect(t.canvas()).toBe("delivered");
      // Only the person who asked is reached.
      expect(t.fetched).toEqual([PERSON]);
    });
  });

  it("shows a screen of the same view in place for a failure", async () => {
    await withImpl(`run-delivery-failed-${crypto.randomUUID()}`, async impl => {
      let t = setUp(impl);
      await t.settle("failed");
      expect(t.calls.map(call => call.move)).toEqual([{ type: "showScreen", screenId: "review" }]);
    });
  });

  it("delivers once: a duplicate, and an out-of-order later outcome, move nothing more", async () => {
    await withImpl(`run-delivery-once-${crypto.randomUUID()}`, async impl => {
      let t = setUp(impl);
      await t.settle("succeeded");
      impl.deliverRunToCanvas(t.deliveryId);
      // A later reconciliation changes the outcome; the page already moved for this run.
      t.store.recordResult(t.deliveryId, { outcome: "uncertain", reason: "action-unknown" });
      impl.deliverRunToCanvas(t.deliveryId);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(t.calls).toHaveLength(1);
      expect(t.canvas()).toBe("delivered");
    });
  });

  it("moves nothing for a requester taken off the trigger's control, and records it undelivered", async () => {
    await withImpl(`run-delivery-revoked-${crypto.randomUUID()}`, async impl => {
      let t = setUp(impl);
      t.store.setControl(ADA, HOOK, { label: "Run refunds", invokers: ["someone-else"] });
      await t.settle("succeeded");
      expect(t.calls).toEqual([]);
      expect(t.canvas()).toBe("undelivered");
    });
  });

  it("records it undelivered when no page was open, and keeps nothing for a result still waiting", async () => {
    await withImpl(`run-delivery-closed-${crypto.randomUUID()}`, async impl => {
      let t = setUp(impl, { answer: "not-open" });
      t.store.recordResult(t.deliveryId, { outcome: "waiting" });
      impl.deliverRunToCanvas(t.deliveryId);
      expect(t.canvas()).toBeUndefined();
      await t.settle("succeeded");
      expect(t.calls).toHaveLength(1);
      expect(t.canvas()).toBe("undelivered");
    });
  });

  it("leaves the result in history only when the page shows another console or revision", async () => {
    for (let shown of [{ consoleId: "other" }, { revision: "2" }, { workspaceId: "another-workspace" }]) {
      await withImpl(`run-delivery-elsewhere-${crypto.randomUUID()}`, async impl => {
        let t = setUp(impl, { console: shown });
        await t.settle("succeeded");
        expect(t.calls, JSON.stringify(shown)).toEqual([]);
        expect(t.canvas(), JSON.stringify(shown)).toBeUndefined();
        expect(impl.storage.workflowDeliveries.get(t.deliveryId)?.delivery?.history).toBe("delivered");
      });
    }
  });
});

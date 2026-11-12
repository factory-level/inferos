// A workspace's deployment readiness (FAC-144): the decision (workspaceReadiness) over synthetic
// inputs, the inputs a real OverseerDurableObject reads from its own storage and its owner's
// gatekeeper vendors, and who may ask. Nothing here calls InferOps. Fixtures are synthetic only.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkspaceReadiness } from "@gadgets/workshop-shared/api";
import {
  RECORDS_PATTERN, WORKFLOW_POLICY_PATTERN, workspaceReadiness, type ReadinessInputs,
} from "../src/workspace-readiness";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const BOARD = "inferops://acme.operations/project/board/ENG";
const TABLE = "inferops://acme.operations/object/table/70000000-0000-4000-8000-000000000001";
const POLICY = "inferops://acme.operations/project/workflow/ENG";
const ALL = ["inferops://*/project/board/*", RECORDS_PATTERN, WORKFLOW_POLICY_PATTERN];

/** A workspace with everything: a connected account, both kinds bound, one published console. */
const complete = (): ReadinessInputs => ({
  connections: [
    { id: 1, vendorId: "inferops", resourceUrl: BOARD, connected: true },
    { id: 2, vendorId: "inferops", resourceUrl: TABLE, connected: true },
    { id: 3, vendorId: "inferops", resourceUrl: POLICY, connected: true },
  ],
  boundConnectionIds: new Set([2, 3]),
  publishedConsoles: 1,
  inferopsPatterns: ALL,
});

const statuses = (readiness: WorkspaceReadiness) =>
  Object.fromEntries(readiness.items.map(item => [item.name, item.status]));

describe("the decision (workspaceReadiness)", () => {
  it("is deployment-ready only when every item is, each with no action left", () => {
    let readiness = workspaceReadiness(complete());
    expect(readiness.deploymentReady).toBe(true);
    expect(statuses(readiness)).toEqual({
      "inferops-connection": "ready", "records-binding": "ready", "workflow-policy-binding": "ready",
      "published-console": "ready",
    });
    expect(readiness.items.every(item => item.action === null)).toBe(true);
  });

  it("answers the same again for the same workspace, and never changes its inputs", () => {
    let inputs = complete();
    let before = structuredClone({ ...inputs, boundConnectionIds: [...inputs.boundConnectionIds] });
    expect(workspaceReadiness(inputs)).toEqual(workspaceReadiness(inputs));
    expect({ ...inputs, boundConnectionIds: [...inputs.boundConnectionIds] }).toEqual(before);
  });

  it("is never ready with a kind turned off for the deployment, even when it is bound", () => {
    for (let off of [RECORDS_PATTERN, WORKFLOW_POLICY_PATTERN]) {
      let readiness = workspaceReadiness({ ...complete(), inferopsPatterns: ALL.filter(p => p !== off) });
      expect(readiness.deploymentReady).toBe(false);
      let name = off === RECORDS_PATTERN ? "records-binding" : "workflow-policy-binding";
      expect(readiness.items.find(item => item.name === name)).toMatchObject({
        status: "blocked", detail: expect.stringContaining("turned off for this deployment"),
      });
    }
  });

  it("asks for each missing piece: no binding, no connected account, no published console", () => {
    let unbound = workspaceReadiness({ ...complete(), boundConnectionIds: new Set([2]) });
    expect(statuses(unbound)["workflow-policy-binding"]).toBe("attention");
    expect(unbound.items.find(item => item.name === "workflow-policy-binding")?.action).toContain("configure");
    expect(unbound.deploymentReady).toBe(false);

    let unconnected = workspaceReadiness({
      ...complete(), connections: complete().connections.map(c => ({ ...c, connected: false })),
    });
    expect(statuses(unconnected)["inferops-connection"]).toBe("attention");
    expect(unconnected.deploymentReady).toBe(false);

    let unpublished = workspaceReadiness({ ...complete(), publishedConsoles: 0 });
    expect(statuses(unpublished)["published-console"]).toBe("attention");
    expect(unpublished.deploymentReady).toBe(false);
  });

  it("is blocked, not merely waiting, with no InferOps gatekeeper or with consoles turned off", () => {
    let none = workspaceReadiness({ ...complete(), inferopsPatterns: null });
    expect(statuses(none)).toMatchObject({
      "inferops-connection": "blocked", "records-binding": "blocked", "workflow-policy-binding": "blocked",
    });
    expect(none.deploymentReady).toBe(false);
    let off = workspaceReadiness({ ...complete(), publishedConsoles: null });
    expect(statuses(off)["published-console"]).toBe("blocked");
    expect(off.deploymentReady).toBe(false);
  });

  it("counts only an InferOps connection of the kind: another vendor's, or a board, binds nothing here", () => {
    let readiness = workspaceReadiness({
      ...complete(),
      connections: [
        { id: 1, vendorId: "inferops", resourceUrl: BOARD, connected: true },
        { id: 2, vendorId: "github", resourceUrl: TABLE, connected: true },
      ],
      boundConnectionIds: new Set([1, 2]),
    });
    expect(statuses(readiness)).toMatchObject({ "records-binding": "attention", "workflow-policy-binding": "attention" });
  });
});

const FLAGS = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
let counter = 0;

/** A real Overseer W whose owner's InferOps gatekeeper offers `patterns`, with `flags` on. */
async function inWorkspace(patterns: string[] | null, flags: Record<string, string | undefined>,
    fn: (impl: any) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`readiness-${++counter}`), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let realEnv = impl.env;
    impl.env = new Proxy(realEnv, { get: (target, prop) => prop in flags ? flags[prop as string] : Reflect.get(target, prop) });
    impl.users = {
      idFromName: (id: string) => ({ toString: () => id }),
      idFromString: (id: string) => id,
      get: () => ({
        listGatekeeperVendors: async () => patterns === null ? [] : [{
          id: "inferops", description: {}, supportedResources: patterns.map(urlPattern => ({ urlPattern })),
        }],
      }),
    };
    impl.ownerId = "owner";
    impl.storage.ownerId.put("owner");
    await fn(impl);
  });
}

const gatekeeper = (id: number, resourceUrl: string, connected = true) => ({
  id, resourceTitle: "x", class: {} as any,
  creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl, typeUrlPattern: "" },
  ...(connected ? { connectedBy: { userId: "owner", accountId: 1 } } : {}),
});

describe("what a workspace reads (OverseerImpl.workspaceReadinessInputs)", () => {
  it("reads its connections, bound edges only, published consoles and the gatekeeper's offer", () =>
    inWorkspace(ALL, FLAGS, async impl => {
      impl.storage.gatekeepers.put(gatekeeper(41, TABLE));
      impl.storage.gatekeepers.put(gatekeeper(42, POLICY));
      impl.storage.gatekeepers.put(gatekeeper(43, BOARD, false));
      let commit = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", "export {};\n"]]), {
        parents: [], author: { name: "Builder", email: "builder@example.com" }, message: "synthetic",
        timestamp: new Date(1700000000_000),
      });
      let record = impl.createGadget("Records", "RECORDS", undefined, undefined, commit);
      record.bindings = {
        TABLE: { target: 41 },
        // A provisional edge (a chat's, not yet accepted) binds nothing yet.
        POLICY: { target: 42, pending: { chatId: 7 } },
      };
      impl.storage.gadgets.put(record);
      impl.storage.consoles.put({ id: "floor", revision: "1", title: "Floor", views: [], widgets: [],
        published: { revision: "1", content: { title: "Floor", views: [], widgets: [] } } });
      impl.storage.consoles.put({ id: "draft", revision: "0", title: "Draft", views: [], widgets: [], published: null });

      let inputs = await impl.workspaceReadinessInputs();
      expect([...inputs.boundConnectionIds]).toEqual([41]);
      expect(inputs.publishedConsoles).toBe(1);
      expect(inputs.inferopsPatterns).toEqual(ALL);
      expect(inputs.connections.find((c: any) => c.id === 43)).toMatchObject({ vendorId: "inferops", connected: false });

      let readiness = workspaceReadiness(inputs);
      expect(statuses(readiness)).toEqual({
        "inferops-connection": "ready", "records-binding": "ready", "workflow-policy-binding": "attention",
        "published-console": "ready",
      });
      // Asking again changes nothing and answers the same.
      let before = [...impl.storage.gatekeepers.list()].length + [...impl.storage.gadgets.list()].length;
      expect(workspaceReadiness(await impl.workspaceReadinessInputs())).toEqual(readiness);
      expect([...impl.storage.gatekeepers.list()].length + [...impl.storage.gadgets.list()].length).toBe(before);
    }));

  it("reads a switched-off kind as blocked, and consoles turned off as null", () =>
    inWorkspace(ALL.filter(p => p !== WORKFLOW_POLICY_PATTERN), {}, async impl => {
      let inputs = await impl.workspaceReadinessInputs();
      expect(inputs.publishedConsoles).toBeNull();
      expect(statuses(workspaceReadiness(inputs))).toMatchObject({
        "workflow-policy-binding": "blocked", "published-console": "blocked",
      });
    }));

  it("reads no InferOps gatekeeper as null", () =>
    inWorkspace(null, FLAGS, async impl => {
      expect((await impl.workspaceReadinessInputs()).inferopsPatterns).toBeNull();
    }));
});

describe("who may ask (Overseer.getWorkspaceReadiness)", () => {
  const REFUSED = "You don't have permission to share or publish configuration other people use.";
  const inputs = complete();

  async function session(role: "build" | "use", holdsBuild = true) {
    let opened = false;
    let overseer = await openFakeOverseer({}, {
      role,
      impl: {
        env: { SHARED_CONFIGURATION_GATEKEEPER: "inferops" },
        isSharedConfiguration: async () => true,
        workspaceReadinessInputs: async () => inputs,
        storage: { containsRestrictedData: { get: () => false }, title: { get: () => "W" }, operateSession: { get: () => false } },
        users: {
          idFromString: (id: string) => id,
          get: () => ({
            whoami: async () => ({ type: "user", id: "ada", name: "Ada" }),
            recordSharedGadgetOpen: async () => {},
            holdsSharedConfiguration: async () => !opened || holdsBuild,
          }),
        },
      },
    });
    opened = true;
    return overseer;
  }

  it("answers a builder with the shared workspace's build authority", async () => {
    expect(await (await session("build")).getWorkspaceReadiness()).toEqual(workspaceReadiness(inputs));
  });

  it("refuses a builder whose shared-configuration authority says no", async () => {
    await expect((await session("build", false)).getWorkspaceReadiness()).rejects.toThrow(REFUSED);
  });

  it("refuses a use session", async () => {
    await expect((await session("use")).getWorkspaceReadiness()).rejects.toThrow();
  });
});

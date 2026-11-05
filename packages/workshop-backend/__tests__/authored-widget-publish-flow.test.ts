import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { readBlueprintVersionToInstall } from "../src/blueprint-install.js";
import { blueprintVersionMetadata } from "../src/blueprint-archive.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}

let nextId = 0;

async function withClient<T>(run: (impl: any, client: Overseer) => Promise<T>): Promise<T> {
  const stub = env.TEST_OVERSEER.getByName(`authored-widget-flow-${++nextId}`);
  return runInDurableObject(stub, async instance => {
    const impl = (instance as unknown as {impl: any}).impl;
    const ownerId = impl.users.newUniqueId().toString();
    impl.ownerId = ownerId;
    impl.defaultGadgetId = 1;
    impl.storage.defaultGadgetId.put(1);
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.requireSharedConfiguration = async () => {};
    impl.recordGadgetAnalytics = () => {};
    const owner = impl.users.idFromString(ownerId);
    impl.users.get = () => ({
      id: owner,
      whoami: async () => ({id: "owner-profile", name: "Owner"}),
    });
    const index = new Map<string, string>();
    const versions = new Map<string, {body: Uint8Array, metadata?: Record<string, string>}>();
    impl.env = {
      ...impl.env,
      BLUEPRINTS: {
        get: async (key: string) => index.get(key) ?? null,
        put: async (key: string, value: string) => { index.set(key, value); },
        delete: async (key: string) => { index.delete(key); },
      },
      BLUEPRINT_CONTENT: {
        put: async (key: string, body: Uint8Array, options?: {customMetadata?: Record<string, string>}) => {
          versions.set(key, {body: new Uint8Array(body), metadata: options?.customMetadata});
        },
        get: async (key: string) => {
          const item = versions.get(key);
          return item ? {body: new Response(item.body).body, customMetadata: item.metadata} : null;
        },
        delete: async (key: string) => { versions.delete(key); },
      },
    };
    const client = await instance.open(
      ownerId, "owner-profile", new NativeRpcStub<() => void>(() => {}));
    return run(impl, client);
  });
}

describe("authored widget publication through the Overseer client", () => {
  it("refuses create/update on build errors without changing the published version", async () => {
    await withClient(async (impl, client) => {
      const sourceCommit = await impl.gitStore.writeFilesAsCommit(
        new Map([["client.tsx", "export default function Widget(){ return <div/> }"]]), {
          parents: [], author: {name: "Owner", email: "owner@example.com"},
          message: "widget source", timestamp: new Date(1_700_000_000_000),
        });
      const compiledCommit = await impl.gitStore.writeFilesAsCommit(
        new Map([["client.tsx", "export default function Widget(){ return <div/> }"],
                 ["client.js", "export default 1"]]), {
          parents: [sourceCommit], author: {name: "Owner", email: "owner@example.com"},
          message: "compiled widget", timestamp: new Date(1_700_000_001_000),
        });
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(1_700_000_000_000),
        bindingName: "widget", commitId: sourceCommit, bindings: {},
      });
      let buildFails = true;
      impl.compileAuthoredWidgetCommit = async (commitId: string) => {
        if (buildFails) throw new Error("Build failed: it ran out of resources; try fewer or smaller files.");
        return compiledCommit;
      };
      let propagated = 0;
      impl.propagateBlueprint = async (record: any, snapshot: Uint8Array) => {
        propagated++;
        impl.storage.blueprints.put(record);
        await impl.env.BLUEPRINTS.put(record.id, JSON.stringify({
          metadata: record.metadata, ownerId: impl.ownerId, gadgetId: "1",
        }));
        await impl.env.BLUEPRINT_CONTENT.put(`${record.id}/${record.metadata.version}`, snapshot, {
          customMetadata: blueprintVersionMetadata(record.metadata.kind, record.metadata.dataContract),
        });
      };

      const gadget = await client.getGadget(1);
      await expect(gadget.createBlueprint()).rejects.toThrow("Build failed");
      expect([...impl.storage.blueprints.list()]).toHaveLength(0);
      expect(propagated).toBe(0);
      expect(impl.storage.gadgets.get(1).commitId).toBe(sourceCommit);

      buildFails = false;
      await gadget.createBlueprint("published", "version one");
      const [recordBefore] = [...impl.storage.blueprints.list()];
      expect(recordBefore.metadata.version).toBe(1);
      expect(recordBefore.commitId).toBe(compiledCommit);
      expect(impl.storage.gadgets.get(1).commitId).toBe(sourceCommit);
      const snapshotBefore = structuredClone(recordBefore);
      const installBefore = await readBlueprintVersionToInstall(
        impl.env, recordBefore.id, {});
      expect(installBefore.install.version).toBe(1);

      buildFails = true;
      await expect(client.updateBlueprint(recordBefore.id, {
        updateCode: true, title: "must not be applied",
      })).rejects.toThrow("Build failed");
      expect(impl.storage.blueprints.get(recordBefore.id)).toEqual(snapshotBefore);
      expect(propagated).toBe(1);
      expect(impl.storage.gadgets.get(1).commitId).toBe(sourceCommit);
      await expect(readBlueprintVersionToInstall(impl.env, recordBefore.id, {})).resolves
        .toMatchObject({install: {version: 1}, code: installBefore.code});
    });
  });

  it("serves another RPC while publication compilation is delayed", async () => {
    await withClient(async (impl, client) => {
      const sourceCommit = await impl.gitStore.writeFilesAsCommit(
        new Map([["client.tsx", "export default function Widget(){ return <div/> }"]]), {
          parents: [], author: {name: "Owner", email: "owner@example.com"},
          message: "widget source", timestamp: new Date(1_700_000_000_000),
        });
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(1_700_000_000_000),
        bindingName: "widget", commitId: sourceCommit, bindings: {},
      });
      let entered!: () => void;
      let release!: () => void;
      const compiling = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      impl.compileAuthoredWidgetCommit = async (commitId: string) => {
        entered();
        await wait;
        return commitId;
      };
      impl.propagateBlueprint = async () => {};
      impl.snapshotCode = async () => new Uint8Array([1]);

      const gadget = await client.getGadget(1);
      const publishing = gadget.createBlueprint();
      await compiling;
      const start = performance.now();
      await client.listBlueprints();
      const elapsed = performance.now() - start;
      release();
      await publishing;
      expect(elapsed).toBeLessThan(500);
    });
  });

  it("refuses a concurrent code publish that would overwrite the same version", async () => {
    await withClient(async (impl, client) => {
      const sourceCommit = await impl.gitStore.writeFilesAsCommit(
        new Map([["client.tsx", "export default function Widget(){ return <div/> }"]]), {
          parents: [], author: {name: "Owner", email: "owner@example.com"},
          message: "widget source", timestamp: new Date(1_700_000_000_000),
        });
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(1_700_000_000_000),
        bindingName: "widget", commitId: sourceCommit, bindings: {},
      });
      impl.compileAuthoredWidgetCommit = async (commitId: string) => commitId;

      const versions = new Map<number, string>();
      impl.snapshotCode = async (commitId: string) => new TextEncoder().encode(commitId);
      impl.propagateBlueprint = async (record: any, snapshot: Uint8Array) => {
        impl.storage.blueprints.put(record);
        versions.set(record.metadata.version, new TextDecoder().decode(snapshot));
      };

      const gadget = await client.getGadget(1);
      const blueprint = await gadget.createBlueprint();

      let releaseBuilds!: () => void;
      const buildsReleased = new Promise<void>(resolve => { releaseBuilds = resolve; });
      let bothBuildsStarted!: () => void;
      const buildsStarted = new Promise<void>(resolve => { bothBuildsStarted = resolve; });
      let buildCount = 0;
      impl.compileAuthoredWidgetCommit = async () => {
        const build = ++buildCount;
        if (build === 2) bothBuildsStarted();
        await buildsReleased;
        return `compiled-${build}`;
      };

      const first = client.updateBlueprint(blueprint.id, {updateCode: true});
      const second = client.updateBlueprint(blueprint.id, {updateCode: true});
      await buildsStarted;
      releaseBuilds();

      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
      expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({
          message: "The Blueprint changed while building; publish again.",
        }),
      });

      const record = impl.storage.blueprints.get(blueprint.id);
      expect(record?.metadata.version).toBe(2);
      expect(record?.commitId).toBe("compiled-1");
      expect(versions).toEqual(new Map([[1, sourceCommit], [2, "compiled-1"]]));
    });
  });
});

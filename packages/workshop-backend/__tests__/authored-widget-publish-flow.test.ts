import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { AuthoredWidgetBuildDurableObject } from "../src/authored-widget-build.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { readBlueprintVersionToInstall } from "../src/blueprint-install.js";
import { blueprintVersionMetadata } from "../src/blueprint-archive.js";
import { compileAuthoredWidgetSources } from "../src/authored-widget-publication.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_AUTHORED_WIDGET_BUILD: DurableObjectNamespace<AuthoredWidgetBuildDurableObject>;
  }
}

let nextId = 0;

async function withClient<T>(run: (impl: any, client: Overseer, instance: OverseerDurableObject) => Promise<T>): Promise<T> {
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
        operateSessionWorkspaceId: async () => stub.id.toString(),
        recordSharedGadgetOpen: async () => {},
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
      const transport = new NativeRpcStub<() => void>(() => {});
      const client = await instance.open(ownerId, "owner-profile", transport);
      try {
        return await run(impl, client, instance);
      } finally {
        client[Symbol.dispose]();
        transport[Symbol.dispose]();
      }
  });
}

describe("authored widget publication through the Overseer client", () => {
  it("builds a chat draft without changing its gadget head or published state", async () => {
    await withClient(async (impl, client) => {
      impl.env = { ...impl.env, AUTHORED_WIDGET_BUILD_ENABLED: "true" };
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(0), bindingName: "widget", bindings: {},
      });
      impl.storage.chatMeta.put({ id: 51, title: "Draft", started: new Date(0), lastActive: new Date(0) });
      impl.checkChatExistsAndMaterializeChanges = vi.fn();
      impl.readGadgetFiles = vi.fn(async () => new Map([
        ["client.tsx", "export default function Widget(){ return <div/> }"],
      ]));
      impl.authoredWidgetBuildNamespace = {
        newUniqueId: () => "preview-build",
        get: () => ({ compile: async () => ({ clientJs: "compiled preview", durationMs: 7, clientBytes: 16 }) }),
      };
      const writeCommit = vi.spyOn(impl.gitStore, "writeFilesAsCommit");
      const r2Write = vi.spyOn(impl.env.BLUEPRINT_CONTENT, "put");
      const gadgetBefore = structuredClone(impl.storage.gadgets.get(1));
      const blueprintsBefore = [...impl.storage.blueprints.list()];

      const result = await client.previewAuthoredWidget(1, 51);

      expect(result.jsCode.length).toBeGreaterThan(0);
      expect(result.measurements.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.measurements.clientBytes).toBe(new TextEncoder().encode(result.jsCode).byteLength);
      expect(impl.checkChatExistsAndMaterializeChanges).toHaveBeenCalledWith(51);
      expect(writeCommit).not.toHaveBeenCalled();
      expect(r2Write).not.toHaveBeenCalled();
      expect(impl.storage.gadgets.get(1)).toEqual(gadgetBefore);
      expect([...impl.storage.blueprints.list()]).toEqual(blueprintsBefore);
    });
  });

  it("compiles a minimal draft through the real build Durable Object in workerd", async () => {
    await withClient(async (impl, client) => {
      impl.env = { ...impl.env, AUTHORED_WIDGET_BUILD_ENABLED: "true" };
      impl.authoredWidgetBuildNamespace = env.TEST_AUTHORED_WIDGET_BUILD;
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(0), bindingName: "widget", bindings: {},
      });
      impl.storage.chatMeta.put({ id: 51, title: "Draft", started: new Date(0), lastActive: new Date(0) });
      impl.checkChatExistsAndMaterializeChanges = vi.fn();
      impl.readGadgetFiles = vi.fn(async () => new Map([
        ["client.tsx", "export default function Widget(){ return <div>workerd preview</div> }"],
      ]));

      await expect(client.previewAuthoredWidget(1, 51)).resolves.toMatchObject({
        jsCode: expect.stringContaining("workerd preview"),
        measurements: { clientBytes: expect.any(Number), durationMs: expect.any(Number) },
      });
    });
  }, 30_000);

  it.each([
    ["invalid TSX", "export default function {", "Invalid TypeScript syntax."],
    ["node import", 'import fs from "node:fs"; export default function Widget(){ return null }', "Unapproved package import."],
    ["non-literal dynamic import", "const name = './x'; void import(name); export default function Widget(){ return null }", "Dynamic import refused."],
    ["eval", 'eval("1"); export default function Widget(){ return null }', "Dynamic code loading refused."],
    ["Function constructor", 'new Function("return 1")(); export default function Widget(){ return null }', "Denied global."],
    ["require", 'require("react"); export default function Widget(){ return null }', "Dynamic code loading refused."],
    ["import.meta", "const url = import.meta.url; export default function Widget(){ return null }", "import.meta refused."],
    ...["Bun", "Deno", "EventSource", "Function", "global", "globalThis", "localStorage", "navigator",
      "self", "sessionStorage", "WebSocket", "window", "XMLHttpRequest", "fetch", "process"]
      .map(name => [`${name} global`, `${name}; export default function Widget(){ return null }`, "Denied global."]),
    ["denied member", "globalThis['fetch']('/private'); export default function Widget(){ return null }", "Denied global."],
    ["document defaultView", "document.defaultView; export default function Widget(){ return null }", "Denied global."],
    ["computed document defaultView", "document['defaultView']; export default function Widget(){ return null }", "Denied global."],
    ["document computed member", "const key = 'cookie'; document[key]; export default function Widget(){ return null }", "Denied global."],
    ["missing default export", "export const Widget = () => null", "Missing default component export."],
  ])("refuses %s in the real workerd build Durable Object", async (_label, source, message) => {
    const stub = env.TEST_AUTHORED_WIDGET_BUILD.get(env.TEST_AUTHORED_WIDGET_BUILD.newUniqueId());
    await runInDurableObject(stub, async build => {
      await expect(compileAuthoredWidgetSources({
        sources: { "client.tsx": source },
        builds: { newUniqueId: () => "local-build", get: () => build },
        onFailure: () => {},
      })).rejects.toThrow(message);
    });
  }, 30_000);

  it("rejects an unsafe draft path before allocating a build object", async () => {
    await withClient(async (impl, client) => {
      impl.env = { ...impl.env, AUTHORED_WIDGET_BUILD_ENABLED: "true" };
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Widget", created: new Date(0), bindingName: "widget", bindings: {},
      });
      impl.storage.chatMeta.put({ id: 51, title: "Draft", started: new Date(0), lastActive: new Date(0) });
      impl.checkChatExistsAndMaterializeChanges = vi.fn();
      impl.readGadgetFiles = vi.fn(async () => new Map([
        ["client.tsx", "export default function Widget(){ return <div/> }"],
        ["notes/../private.ts", "private"],
      ]));
      const newUniqueId = vi.fn(() => "preview-build");
      impl.authoredWidgetBuildNamespace = {
        newUniqueId,
        get: () => { throw new Error("must not allocate a build object"); },
      };

      await expect(client.previewAuthoredWidget(1, 51)).rejects.toThrow("Invalid source path.");
      expect(newUniqueId).not.toHaveBeenCalled();
    });
  });

  it("denies preview when disabled, to use-role collaborators, and to operate sessions", async () => {
    await withClient(async (impl, client, instance) => {
      await expect(client.previewAuthoredWidget(1, 1)).rejects.toThrow("Authored widget preview is disabled.");

      impl.getSharingManager = async () => ({}) as never;
      impl.authorizeCollaborator = async () => "use";
      let useClient = await instance.open(
        impl.users.newUniqueId().toString(), "collaborator-profile", new NativeRpcStub<() => void>(() => {}));
      await expect(useClient.previewAuthoredWidget(1, 1)).rejects.toThrow("Unauthorized");

      let operateClient = await instance.open(
        impl.ownerId, "owner-profile", new NativeRpcStub<() => void>(() => {}), undefined, undefined, true);
      await expect(operateClient.previewAuthoredWidget(1, 1)).rejects.toThrow("Unauthorized: an operate session");
    });
  });

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

  it("preserves metadata edits made while a code publish is building", async () => {
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
      impl.snapshotCode = async (commitId: string) => new TextEncoder().encode(commitId);
      const versions = new Map<number, string>();
      impl.propagateBlueprint = async (record: any, snapshot: Uint8Array) => {
        impl.storage.blueprints.put(record);
        versions.set(record.metadata.version, new TextDecoder().decode(snapshot));
      };

      const gadget = await client.getGadget(1);
      const blueprint = await gadget.createBlueprint("published", "initial description");

      let releaseBuild!: () => void;
      const buildReleased = new Promise<void>(resolve => { releaseBuild = resolve; });
      let buildStarted!: () => void;
      const started = new Promise<void>(resolve => { buildStarted = resolve; });
      impl.compileAuthoredWidgetCommit = async () => {
        buildStarted();
        await buildReleased;
        return "compiled-next";
      };

      const publishing = client.updateBlueprint(blueprint.id, {updateCode: true});
      await started;
      await client.updateBlueprint(blueprint.id, {title: "edited during build"});
      releaseBuild();
      await publishing;

      expect(impl.storage.blueprints.get(blueprint.id)).toMatchObject({
        commitId: "compiled-next",
        metadata: {title: "edited during build", version: 2},
      });
      expect(versions.get(2)).toBe("compiled-next");
    });
  });
});

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AuthenticatedApi, BlueprintBindingAssignment, GadgetClient, Overseer, PublicApi, WorkpieceId,
  WorkspaceKind,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { workspaceKindStarter } from "@gadgets/workshop-shared/workspace-kind";
import {
  startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_CONFIG } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder, signUp,
  stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

// Publish to Operate (#155): an operate space is a workspace, and Build's published versions are
// installed into it as gadgets by anyone with build access to it, under their own authority. Each
// install is pinned; only an explicit upgrade moves it, and only between versions declaring the
// same data contract. Mock dependencies are refused unless the space is marked test-only.

type Counter = { add(n: number): Promise<number>; total(): Promise<number> };

const COUNTER_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async add(n) {
    const total = ((await this.ctx.storage.get("total")) ?? 0) + n;
    await this.ctx.storage.put("total", total);
    return total;
  }
  async total() { return (await this.ctx.storage.get("total")) ?? 0; }
}
`;
const COUNTER_UI = `document.body.textContent = "Total: " + await gadget.total();\n`;

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    enableGadgetExecution: true,
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
  publicApi = connect(harness.url);
});

afterAll(async () => {
  try {
    publicApi?.[Symbol.dispose]();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/**
 * A person on a connection of their own, as their browser would be. A workspace restart (see
 * `settle`) fells every connection holding that workspace, so people must not share one.
 */
const person = async (prefix: string) => {
  const name = nextUsernames(prefix)[0]!;
  return { name, api: await signUp(connect(harness.url), name) };
};

const thingUrl = (thing: string) => `https://gadgets-test.example/things/${thing}`;

/** The person's test-gatekeeper account, minted with no auth flow. */
async function testAccount(api: RpcStub<AuthenticatedApi>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account", async () =>
    (await listConnectedAccounts(api)).find(account => account.vendorId === TEST_VENDOR_ID) ?? null);
}

/** A workspace's workpieces as its subscription reports them, held for the harness's life. */
async function watch(workspace: RpcStub<Overseer>) {
  const workpieces = new WorkpieceRecorder();
  await workspace.subscribeToWorkpieces(stubFor(workpieces));
  await workpieces.loaded;
  const gadget = (id: WorkpieceId) => {
    const summary = workpieces.summaries.get(id);
    if (summary?.type !== "gadget") throw new Error(`No gadget ${id}`);
    return summary;
  };
  /** The text of `path` at gadget `id`'s head, as last reported. */
  const text = async (id: WorkpieceId, path: string) => {
    const head = gadget(id).commitId;
    if (head === undefined) throw new Error("No head");
    const [file] = await workspace.readFilesAtCommit(head, [path]);
    return file?.[1]?.kind === "text" ? file[1].text : undefined;
  };
  const gadgetCount = () => [...workpieces.summaries.values()].filter(s => s.type === "gadget").length;
  return { workpieces, gadget, text, gadgetCount };
}

/** Builds a workspace of `kind` with one gadget holding `files` on mainline; `commit` edits it. */
async function build(author: RpcStub<AuthenticatedApi>, kind: WorkspaceKind, files: Record<string, string>) {
  const workspace = await author.newGadget(kind);
  const watched = await watch(workspace);
  const gadget = workspace.createGadget("Built", undefined, "BUILT");
  const gadgetId = await gadget.getId();
  const head = () => waitFor("the gadget's head", async () =>
    watched.workpieces.summaries.get(gadgetId)?.type === "gadget"
      ? watched.gadget(gadgetId).commitId ?? null : null);
  const content = (entries: Record<string, string>): CodeContent =>
    new Map([[gadgetId, new Map(Object.entries(entries))]]);
  let current: Record<string, string> = {};
  const commit = async (next: Record<string, string>) => {
    const base = await head();
    const chatId = await workspace.newChat("Build", null);
    await workspace.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "build", seq: 1,
      pins: [{ gadgetId, baseCommit: base }],
      change: diffFiles(content(current), content({ ...current, ...next })),
    });
    expect(await workspace.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    await waitFor("the merged head", async () => (await head()) !== base || null);
    current = { ...current, ...next };
  };
  await commit(files);
  return { workspace, gadget, commit };
}

/** Publishes version 1, declaring `dataContract` (or none), and waits until it is readable. */
async function publish(gadget: RpcStub<GadgetClient>, title: string, dataContract?: number) {
  const blueprint = await gadget.createBlueprint(title, `${title} for Operate`, undefined,
      dataContract === undefined ? undefined : { dataContract });
  await waitFor("the published blueprint", () => publicApi.getBlueprint(blueprint.id));
  return blueprint.id;
}

/** Republishes the source's current code as `version`, declaring `dataContract` (or none). */
async function republish(workspace: RpcStub<Overseer>, blueprintId: string, version: number,
                         dataContract?: number) {
  await workspace.updateBlueprint(blueprintId,
      dataContract === undefined ? { updateCode: true } : { updateCode: true, dataContract });
  await waitFor(`version ${version} of the blueprint`, async () =>
    (await publicApi.getBlueprint(blueprintId))?.metadata.version === version || null);
}

const appFiles = (version: string) =>
  ({ "server.js": COUNTER_SERVER, "client.js": COUNTER_UI, "version.txt": version });

/**
 * A space owned by one person and shared for building with an installer. A use-only viewer is
 * shared it too, and is checked to be refused everything that installs or authors there, while
 * the space holds no bindings: once it does, opening it would also need their own accounts.
 */
async function space(prefix: string, blueprintId: string) {
  const owner = await person(`${prefix}owner`);
  const installer = await person(`${prefix}installer`);
  const viewer = await person(`${prefix}viewer`);
  const ownerSpace = await owner.api.newGadget("app");
  const spaceId = (await ownerSpace.getMetadata()).id;
  expect(await ownerSpace.addCollaborator(installer.name, "build")).toBeTruthy();
  expect(await ownerSpace.addCollaborator(viewer.name, "use")).toBeTruthy();
  {
    using used = await viewer.api.openGadget(spaceId);
    expect(await used.getMetadata()).toMatchObject({ role: "use" });
    await expect(used.createGadget("Mine")).rejects.toThrow(/Unauthorized/);
    await expect(used.installBlueprint(blueprintId, {})).rejects.toThrow(/Unauthorized/);
    await expect(used.upgradeInstall(1, 0)).rejects.toThrow(/Unauthorized/);
    await expect(used.setTestOnly(true)).rejects.toThrow(/Unauthorized/);
  }
  const built = await installer.api.openGadget(spaceId);
  expect(await built.getMetadata()).toMatchObject({ role: "build" });
  const s = { owner, installer, viewer, ownerSpace, spaceId, built, watched: await watch(built),
    /**
     * Waits out the restart that a build collaborator's new connection causes (every build
     * session is severed so it re-verifies; see Overseer.scheduleAccessRestart), then reopens the
     * space for the owner and the installer on fresh connections, as their browsers reconnect. The
     * installer verifies the space's connections with `accountId`, an account of their own.
     */
    async settle(accountId: number): Promise<void> {
      await waitFor("the restart to fell the space", () =>
        s.built.getMetadata().then(() => null, () => true));
      const reopen = (name: string, verifyWith?: number) => waitFor(`${name} to reopen the space`, async () => {
        try {
          using callback = verifyWith === undefined ? undefined
            : stubFor(new ObserverConfigRecorder().alwaysChoose(verifyWith, MAX_OBSERVER_PROMPTS));
          const workspace = await (await logIn(connect(harness.url), name))
            .openGadget(spaceId, undefined, callback);
          await workspace.getMetadata();
          return workspace;
        } catch {
          return null;
        }
      });
      s.ownerSpace = await reopen(owner.name);
      s.built = await reopen(installer.name, accountId);
      s.watched = await watch(s.built);
    },
  };
  return s;
}

describe("Publish to Operate", () => {
  it("installs into another person's space as a build collaborator, pinned until an explicit upgrade",
      async () => {
    const author = await person("spaceauthor");
    const authorAccount = await testAccount(author.api);
    const source = await build(author.api, "app", appFiles("v1"));
    using data = await source.workspace.newGatekeeper(authorAccount.id, thingUrl("space-source"));
    if (!data) throw new Error("Failed to connect the author's thing");
    await source.gadget.bind("DATA", await data.getId());
    await source.gadget.setBlueprintAnnotation("DATA", { title: "Data", description: "" });
    const blueprintId = await publish(source.gadget, "Counter", 1);
    expect((await publicApi.getBlueprint(blueprintId))?.metadata).toMatchObject({ version: 1, dataContract: 1 });

    const s = await space("pin", blueprintId);
    const installerAccount = await testAccount(s.installer.api);
    const gadgetId = await s.built.installBlueprint(blueprintId,
        { DATA: { type: "gatekeeper", accountId: installerAccount.id, resourceUrl: thingUrl("space-mine") } },
        { version: 1, kind: "app" });
    await s.settle(installerAccount.id);
    expect(s.watched.gadget(gadgetId).installedFrom)
      .toEqual({ blueprintId, version: 1, kind: "app", dataContract: 1 });
    expect(await s.watched.text(gadgetId, "version.txt")).toBe("v1");
    // The space is still the owner's, and the binding is the installer's own resource.
    expect((await s.ownerSpace.getMetadata()).installedFrom).toBeUndefined();
    {
      using gadget = await s.built.getGadget(gadgetId);
      using binding = await gadget.getBinding("DATA");
      expect(await binding?.getCreationSpec()).toMatchObject({
        type: "gatekeeper", vendorId: TEST_VENDOR_ID, resourceUrl: thingUrl("space-mine"),
      });
    }

    // Assigned through the space's existing composition: a screen and a console over it.
    const screen = await s.built.createCanvas({ title: "Counter", sections: [{ id: "main", title: "Now",
      columns: 1, widgets: [{ id: "counter", version: 1, kind: "inferos.gadget",
        targetRef: `gadget:${gadgetId}`, params: {}, size: "normal" }] }] });
    const consoleDef = await s.built.createConsole({ title: "Shift", fullChat: "off",
      views: [{ id: "counter", title: "Counter", type: "screen", screen: screen.id }] });
    expect((await s.ownerSpace.listConsoles()).map(listed => listed.id)).toEqual([consoleDef.id]);

    const counter = async () => {
      using gadget = await s.built.getGadget(gadgetId);
      return await gadget.connectToGadget() as unknown as RpcStub<Counter>;
    };
    {
      using api = await counter();
      expect(await api.add(3)).toBe(3);
    }

    // Editing and republishing the source changes nothing the space runs.
    await source.commit({ "version.txt": "v2" });
    await republish(source.workspace, blueprintId, 2, 1);
    expect(await s.watched.text(gadgetId, "version.txt")).toBe("v1");
    expect(s.watched.gadget(gadgetId).installedFrom?.version).toBe(1);

    // The explicit upgrade, between equal data contracts, keeps the install's data and binding.
    const head = s.watched.gadget(gadgetId).commitId;
    await s.built.upgradeInstall(2, gadgetId);
    await waitFor("the upgraded head", async () => s.watched.gadget(gadgetId).commitId !== head || null);
    expect(await s.watched.text(gadgetId, "version.txt")).toBe("v2");
    expect(s.watched.gadget(gadgetId).installedFrom).toMatchObject({ version: 2, dataContract: 1 });
    {
      using api = await counter();
      expect(await api.total()).toBe(3);
    }

    // A version declaring another data contract needs migration; one declaring none is unknown.
    await source.commit({ "version.txt": "v3" });
    await republish(source.workspace, blueprintId, 3, 2);
    await expect(s.built.upgradeInstall(3, gadgetId)).rejects.toThrow(/needs migration/);
    await source.commit({ "version.txt": "v4" });
    await republish(source.workspace, blueprintId, 4);
    expect((await publicApi.getBlueprint(blueprintId))?.metadata.dataContract).toBeUndefined();
    await expect(s.built.upgradeInstall(4, gadgetId)).rejects.toThrow(/declares no data contract/);
    expect(await s.watched.text(gadgetId, "version.txt")).toBe("v2");
    expect(s.watched.gadget(gadgetId).installedFrom?.version).toBe(2);

    // An install of a version with no contract can't be upgraded either, even to an equal code.
    const unknown = await s.built.installBlueprint(blueprintId,
        { DATA: { type: "gatekeeper", accountId: installerAccount.id, resourceUrl: thingUrl("space-mine") } },
        { version: 4 });
    await s.settle(installerAccount.id);
    await expect(s.built.upgradeInstall(2, unknown)).rejects.toThrow(/version 4 declares no data contract/);
    // A data contract is declared only with a new version.
    await expect(source.workspace.updateBlueprint(blueprintId, { title: "Renamed", dataContract: 1 }))
      .rejects.toThrow(/only with a new version/);
  });

  it("refuses a wrong kind, a revoked binding and an unreadable source before creating anything", async () => {
    const author = await person("refuseauthor");
    const authorAccount = await testAccount(author.api);
    const source = await build(author.api, "widget",
        { ...workspaceKindStarter("widget")!, "version.txt": "v1" });
    using data = await source.workspace.newGatekeeper(authorAccount.id, thingUrl("refuse-source"));
    if (!data) throw new Error("Failed to connect the author's thing");
    await source.gadget.bind("DATA", await data.getId());
    await source.gadget.setBlueprintAnnotation("DATA", { title: "Data", description: "" });
    const blueprintId = await publish(source.gadget, "Status", 1);

    const s = await space("refuse", blueprintId);
    const installerAccount = await testAccount(s.installer.api);
    const assign = (accountId: number): Record<string, BlueprintBindingAssignment> =>
      ({ DATA: { type: "gatekeeper", accountId, resourceUrl: thingUrl("refuse-mine") } });
    const before = s.watched.gadgetCount();

    await expect(s.built.installBlueprint(blueprintId, assign(installerAccount.id), { kind: "app" }))
      .rejects.toThrow(/is a widget, not a app/);
    // The installer's account is gone: the binding can't resolve under their authority, and no
    // one else's account stands in for it.
    await s.installer.api.disconnectAccount(installerAccount.id);
    await expect(s.built.installBlueprint(blueprintId, assign(installerAccount.id)))
      .rejects.toThrow(/No such account/);
    // A source the installer can no longer read (its owner deleted it) installs nothing either.
    await source.workspace.deleteBlueprint(blueprintId);
    await waitFor("the deleted blueprint", async () => (await publicApi.getBlueprint(blueprintId)) === null || null);
    await expect(s.built.installBlueprint(blueprintId, {})).rejects.toThrow(/Blueprint not found/);
    expect(s.watched.gadgetCount()).toBe(before);
  });

  it("refuses mock dependencies in a normal space, and accepts them in a test-only one", async () => {
    const author = await person("mockauthor");
    const authorAccount = await testAccount(author.api);
    await author.api.addModel({ type: "agent", id: "space-model", name: "Space model" }, SCRIPTED_MODEL_CONFIG);
    const source = await build(author.api, "app", appFiles("v1"));
    using data = await source.workspace.newGatekeeper(authorAccount.id, thingUrl("mock-free-source"));
    if (!data) throw new Error("Failed to connect the author's thing");
    await source.gadget.bind("DATA", await data.getId());
    await source.gadget.setBlueprintAnnotation("DATA", { title: "Data", description: "" });
    using model = await source.workspace.newAiModelGatekeeper("space-model");
    await source.gadget.bind("MODEL", await model.getId());
    await source.gadget.setBlueprintAnnotation("MODEL", { title: "Model", description: "" });
    const blueprintId = await publish(source.gadget, "Assistant", 1);

    const s = await space("mock", blueprintId);
    const installerAccount = await testAccount(s.installer.api);
    // The installer's own models: one registered as a mock (by its metadata, not its name), one not.
    await s.installer.api.addModel({ type: "agent", id: "real-model", name: "Mock-sounding name" },
        SCRIPTED_MODEL_CONFIG);
    await s.installer.api.addModel({ type: "agent", id: "scripted-model", name: "Helper" },
        { ...SCRIPTED_MODEL_CONFIG, mock: true });
    const assign = (thing: string, modelId: string): Record<string, BlueprintBindingAssignment> => ({
      DATA: { type: "gatekeeper", accountId: installerAccount.id, resourceUrl: thingUrl(thing) },
      MODEL: { type: "aiModel", modelId },
    });
    const before = s.watched.gadgetCount();

    await expect(s.built.installBlueprint(blueprintId, assign("mock-demo", "real-model")))
      .rejects.toThrow(/not test-only.*the binding "DATA" names mock data/);
    await expect(s.built.installBlueprint(blueprintId, assign("real-thing", "scripted-model")))
      .rejects.toThrow(/the binding "MODEL" uses the mock model "Helper"/);
    expect(s.watched.gadgetCount()).toBe(before);
    // Real dependencies install, whatever their names sound like.
    await s.built.installBlueprint(blueprintId, assign("real-thing", "real-model"));
    await s.settle(installerAccount.id);

    // Marked test-only (by a build collaborator), the space accepts them and records which.
    await s.built.setTestOnly(true);
    expect(await s.ownerSpace.getMetadata()).toMatchObject({ testOnly: true });
    const mocked = await s.built.installBlueprint(blueprintId, assign("mock-demo", "scripted-model"));
    await s.settle(installerAccount.id);
    expect(s.watched.gadget(mocked).installedFrom?.mockDependencies?.toSorted()).toEqual(["DATA", "MODEL"]);
    // While it holds them, the space stays test-only.
    await expect(s.ownerSpace.setTestOnly(false)).rejects.toThrow(/must stay test-only/);
    expect((await s.ownerSpace.getMetadata()).testOnly).toBe(true);
  });
});

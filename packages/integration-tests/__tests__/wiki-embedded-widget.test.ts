import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, OperateSession, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// A published console's widget embedded in a Wiki page (FAC-12, inferops ADR 0013 W11): the page
// names it by its source gadget, the kernel resolves that to the console's current publication's
// frozen install, and a reader who may read the workspace's published consoles opens it with no
// operate session, as the same instance Operate runs, so the two share its state (no clone). A
// person with no access reaches nothing; a republish, an unpublished console or a widget no longer
// listed is said so; a capability kept from an older revision, or past the reader's access, stops.
// The operate session's own workspace is refused both. Over the real kernel, as
// operate-widget-registry.test.ts.

const widgetFiles = (version: string): Record<string, string> => ({
  "server.js": `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async version() { return ${JSON.stringify(version)}; }
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
`,
  "client.js": `document.body.textContent = ${JSON.stringify(version)};\n`,
});
type Counter = { version(): Promise<string>; bump(): Promise<number> };

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
let reader: RpcStub<AuthenticatedApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
  publicApi = connect(harness.url);
  reader = await signUp(publicApi, nextUsernames("embedreader")[0]!);
});

afterAll(async () => {
  try {
    reader?.[Symbol.dispose]();
    publicApi?.[Symbol.dispose]();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function watch(workspace: RpcStub<Overseer>) {
  const workpieces = new WorkpieceRecorder();
  await workspace.subscribeToWorkpieces(stubFor(workpieces));
  await workpieces.loaded;
  const head = (gadgetId: WorkpieceId) => waitFor(`gadget ${gadgetId}'s head`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  return { workpieces, head };
}

async function commit(workspace: RpcStub<Overseer>, watched: Awaited<ReturnType<typeof watch>>,
    gadgetId: WorkpieceId, previous: Record<string, string>, next: Record<string, string>) {
  const content = (files: Record<string, string>): CodeContent => new Map([[gadgetId, new Map(Object.entries(files))]]);
  const base = await watched.head(gadgetId);
  const chatId = await workspace.newChat("Edit", null);
  await workspace.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{ gadgetId, baseCommit: base }],
    change: diffFiles(content(previous), content(next)),
  });
  return await workspace.mergeChanges(chatId);
}

/** A widget built and published as blueprint version 1, with no data contract. */
async function publishWidget(author: RpcStub<AuthenticatedApi>) {
  const workspace = await author.newGadget("widget");
  const watched = await watch(workspace);
  const gadget = workspace.createGadget("Counter", undefined, "COUNTER");
  const gadgetId = await gadget.getId();
  expect(await commit(workspace, watched, gadgetId, {}, widgetFiles("v1"))).toEqual({ outcome: "merged" });
  const blueprint = await gadget.createBlueprint("Counter", "A counter widget");
  await waitFor("the published blueprint", () => reader.getBlueprintInfo(blueprint.id));
  return blueprint.id;
}

const consoleOf = (screenId: string, widgets: ConsoleWidgetEntry[]): OperateConsoleContent => ({
  title: "Floor", views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off", widgets,
});

async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole, seq: number) {
  const page = await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title,
    source: "published", revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, seq);
  return page.seq;
}

/** An operations space with a published console offering one widget, shared for use with an operator. */
async function publishedSpace(prefix: string, api: RpcStub<PublicApi> = publicApi) {
  const [builderName, operatorName, strangerName] = nextUsernames(`${prefix}builder`, `${prefix}operator`, `${prefix}stranger`);
  const builder = await signUp(api, builderName!);
  const operator = await signUp(api, operatorName!);
  const stranger = await signUp(api, strangerName!);
  const author = await signUp(publicApi, nextUsernames(`${prefix}author`)[0]!);
  const blueprintId = await publishWidget(author);
  const space = await builder.newGadget("app");
  const spaceId = (await space.getMetadata()).id;
  expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
  const installed = await space.installBlueprint(blueprintId, {}, { version: 1, kind: "widget" });
  const screen = await space.createCanvas({ title: "Shift", sections: [{ id: "main", title: "Now", columns: 1, widgets: [{
    id: `w${installed}`, version: 1, kind: "inferos.gadget", targetRef: `gadget:${installed}`, params: {}, size: "normal",
  }] }] });
  const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId, version: 1, label: "Counter", state: "resettable" };
  const created = await space.createConsole(consoleOf(screen.id, [entry]));
  const published = await space.publishConsole(created.id, created.revision);
  const frozen = published.published!.content.widgets![0]!.gadgetId;
  return { builder, operator, operatorName: operatorName!, stranger, space, spaceId, installed, screen, entry, created, published, frozen, blueprintId };
}

describe("a published console's widget embedded in a Wiki page", () => {
  it("resolves by its source gadget and opens without an operate session, as the same instance Operate runs", async () => {
    const s = await publishedSpace("embedsame");
    using used = await s.operator.openGadget(s.spaceId);
    const resolved = await used.resolveEmbeddedWidget(s.created.id, s.installed);
    expect(resolved).toEqual({ status: "available", consoleId: s.created.id, revision: s.published.revision,
      gadgetId: s.frozen, label: "Counter", blueprintId: s.blueprintId, version: 1 });

    // No operate session has the console open: getConsoleWidget refuses, the embed doesn't.
    await expect(used.getConsoleWidget(s.created.id, s.published.revision, s.frozen)).rejects.toThrow(/not open/);
    using embedded = await used.getEmbeddedWidget(s.created.id, s.published.revision, s.frozen);
    expect(await embedded.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    const fromPage = await embedded.connectToGadget() as unknown as RpcStub<Counter>;
    expect(await fromPage.bump()).toBe(1);

    // Operate runs the very same install: its state continues, never a copy.
    using session = await s.operator.getOperateSession();
    await openConsole(session, s.spaceId, s.published, 0);
    using operated = await used.getConsoleWidget(s.created.id, s.published.revision, s.frozen);
    const fromOperate = await operated.connectToGadget() as unknown as RpcStub<Counter>;
    expect(await fromOperate.bump()).toBe(2);
    expect(await fromPage.bump()).toBe(3);

    // Only a published console's frozen install is named: never the draft install, nor another id.
    await expect(used.getEmbeddedWidget(s.created.id, s.published.revision, s.installed)).rejects.toThrow(/does not offer/);
    await expect(used.getEmbeddedWidget(s.created.id, "0", s.frozen)).rejects.toThrow(/changed/);
  });

  it("names nothing for a widget the console doesn't list, an unpublished or unknown console", async () => {
    const s = await publishedSpace("embedmissing");
    using used = await s.operator.openGadget(s.spaceId);
    expect(await used.resolveEmbeddedWidget(s.created.id, s.frozen)).toEqual({ status: "unavailable", reason: "not-offered" });
    expect(await used.resolveEmbeddedWidget("no-such-console", s.installed)).toEqual({ status: "unavailable", reason: "not-published" });
    const draftOnly = await s.space.createConsole(consoleOf(s.screen.id, [s.entry]));
    expect(await used.resolveEmbeddedWidget(draftOnly.id, s.installed)).toEqual({ status: "unavailable", reason: "not-published" });
  });

  it("follows a republish to its new frozen install, and stops a capability kept from the old one", async () => {
    const s = await publishedSpace("embedrepublish");
    using used = await s.operator.openGadget(s.spaceId);
    using kept = await used.getEmbeddedWidget(s.created.id, s.published.revision, s.frozen);
    const republished = await s.space.publishConsole(s.created.id, s.published.revision);
    const resolved = await used.resolveEmbeddedWidget(s.created.id, s.installed);
    expect(resolved).toMatchObject({ status: "available", revision: republished.revision });
    expect(resolved.status === "available" && resolved.gadgetId).not.toBe(s.frozen);
    await expect(kept.getUiBundle()).rejects.toThrow(/changed/);
  });

  it("reaches nothing for a person with no access, and stops once the reader's access is removed", async () => {
    // A refused open and a removed collaborator end sessions, so this case has a connection of its own.
    using api = connect(harness.url);
    const s = await publishedSpace("embedaccess", api);
    await expect(s.stranger.openGadget(s.spaceId)).rejects.toThrow();
    using used = await s.operator.openGadget(s.spaceId);
    using kept = await used.getEmbeddedWidget(s.created.id, s.published.revision, s.frozen);
    expect(await kept.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    await s.space.removeCollaborator(s.operatorName, []);
    await expect(kept.getUiBundle()).rejects.toThrow();
    await expect(s.operator.openGadget(s.spaceId)).rejects.toThrow();
  });

  it("is refused to the operate session's own workspace", async () => {
    const s = await publishedSpace("embedsession");
    using session = await s.operator.getOperateSession();
    using own = await session.getWorkspace();
    await expect(own.resolveEmbeddedWidget(s.created.id, s.installed)).rejects.toThrow(/Unauthorized|denied|not/i);
    await expect(own.getEmbeddedWidget(s.created.id, s.published.revision, s.frozen)).rejects.toThrow(/Unauthorized|denied|not/i);
  });
});

// FAC-13: from a definition the widget search found (its blueprint id and version) to the instances
// a person may open, named as an embed names them and opened only through the embed's own path.
describe("the instances of a published widget definition", () => {
  it("lists what the publications offer, to the use and build roles alike, and opens only that", async () => {
    const s = await publishedSpace("instances");
    const expected = [{ consoleId: s.created.id, consoleTitle: "Floor", revision: s.published.revision,
      sourceGadgetId: s.installed, gadgetId: s.frozen, label: "Counter", blueprintId: s.blueprintId, version: 1 }];
    using used = await s.operator.openGadget(s.spaceId);
    expect(await used.listWidgetInstances(s.blueprintId, 1)).toEqual(expected);
    expect(await s.space.listWidgetInstances(s.blueprintId, 1)).toEqual(expected);

    // A console only drafted lists nothing more; nor does another version or definition.
    await s.space.createConsole(consoleOf(s.screen.id, [s.entry]));
    expect(await used.listWidgetInstances(s.blueprintId, 1)).toEqual(expected);
    expect(await used.listWidgetInstances(s.blueprintId, 2)).toEqual([]);
    expect(await used.listWidgetInstances("no-such-blueprint", 1)).toEqual([]);
    await expect(used.listWidgetInstances("", 1)).rejects.toThrow(/Name a widget definition/);
    await expect(used.listWidgetInstances(s.blueprintId, 0)).rejects.toThrow(/Name a widget definition/);

    // What it lists opens through the embed's path; an id it doesn't list, such as the draft install, doesn't.
    using opened = await used.getEmbeddedWidget(s.created.id, s.published.revision, s.frozen);
    expect(await opened.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    await expect(used.getEmbeddedWidget(s.created.id, s.published.revision, s.installed)).rejects.toThrow(/does not offer/);
    await expect(used.getEmbeddedWidget(s.created.id, s.published.revision, (s.frozen + 1000) as WorkpieceId))
      .rejects.toThrow(/does not offer/);
  });

  it("follows a republish, and lists nothing once the console is gone", async () => {
    const s = await publishedSpace("instancesgone");
    using used = await s.operator.openGadget(s.spaceId);
    const republished = await s.space.publishConsole(s.created.id, s.published.revision);
    const [after] = await used.listWidgetInstances(s.blueprintId, 1);
    expect(after).toMatchObject({ revision: republished.revision, sourceGadgetId: s.installed });
    expect(after!.gadgetId).not.toBe(s.frozen);
    const current = (await s.space.listConsoles()).find(c => c.id === s.created.id)!;
    await s.space.deleteConsole(current.id, current.revision);
    expect(await used.listWidgetInstances(s.blueprintId, 1)).toEqual([]);
  });

  it("reaches nothing for a person with no access, and is refused to the operate session's own workspace", async () => {
    using api = connect(harness.url);
    const s = await publishedSpace("instancesaccess", api);
    await expect(s.stranger.openGadget(s.spaceId)).rejects.toThrow();
    using session = await s.operator.getOperateSession();
    using own = await session.getWorkspace();
    await expect(own.listWidgetInstances(s.blueprintId, 1)).rejects.toThrow(/Unauthorized|denied|not/i);
  });
});

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, OperateSession, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// A console's widget registry (MVP-26 slice 1): a widget installed into an operations space is
// registered with a console, and publishing the console gives each entry a frozen install that its
// operators run, whatever later happens to the registered install, until the next publication.

type Tally = { bump(): Promise<number> };
type Versioned = Tally & { version(): Promise<string>; tally(): Promise<RpcStub<Tally>> };

const widgetFiles = (version: string): Record<string, string> => ({
  "server.js": `import { DurableObject, RpcTarget } from "cloudflare:workers";
class Tally extends RpcTarget {
  constructor(gadget) { super(); this.gadget = gadget; }
  async bump() { return await this.gadget.bump(); }
}
export class Gadget extends DurableObject {
  async version() { return ${JSON.stringify(version)}; }
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
  tally() { return new Tally(this); }
}
`,
  "client.js": `document.body.textContent = ${JSON.stringify(version)};\n`,
});

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
  reader = await signUp(publicApi, nextUsernames("registryreader")[0]!);
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

/** Watches `workspace`'s gadgets, for their heads. */
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

/** Merges `next` over `previous` as gadget `gadgetId`'s files in `workspace`, through a chat. */
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

/** A widget built and published by `author` as blueprint version 1, with no data contract. */
async function publishWidget(author: RpcStub<AuthenticatedApi>) {
  const workspace = await author.newGadget("widget");
  const watched = await watch(workspace);
  const gadget = workspace.createGadget("Status", undefined, "STATUS");
  const gadgetId = await gadget.getId();
  expect(await commit(workspace, watched, gadgetId, {}, widgetFiles("v1"))).toEqual({ outcome: "merged" });
  const blueprint = await gadget.createBlueprint("Status", "A status widget");
  await waitFor("the published blueprint", () => reader.getBlueprintInfo(blueprint.id));
  const republish = async (version: string, number: number) => {
    await commit(workspace, watched, gadgetId, widgetFiles("v1"), widgetFiles(version));
    await workspace.updateBlueprint(blueprint.id, { updateCode: true });
    await waitFor(`version ${number}`, async () =>
      (await reader.getBlueprintInfo(blueprint.id))?.metadata.version === number || null);
  };
  return { blueprintId: blueprint.id, republish };
}

/** An operations space owned by a builder, shared for use with an operator. */
async function operationsSpace(prefix: string) {
  const [builderName, operatorName] = nextUsernames(`${prefix}builder`, `${prefix}operator`);
  const builder = await signUp(publicApi, builderName!);
  const operator = await signUp(publicApi, operatorName!);
  const space = await builder.newGadget("app");
  const spaceId = (await space.getMetadata()).id;
  expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
  const watched = await watch(space);
  return { builder, operator, space, spaceId, watched };
}

const screenWith = (space: RpcStub<Overseer>, gadgetIds: WorkpieceId[]) => space.createCanvas({
  title: "Shift",
  sections: [{ id: "main", title: "Now", columns: 1, widgets: gadgetIds.map(id => ({
    id: `w${id}`, version: 1 as const, kind: "inferos.gadget" as const, targetRef: `gadget:${id}`, params: {}, size: "normal" as const,
  })) }],
});

const consoleOf = (screenId: string, widgets: ConsoleWidgetEntry[]): OperateConsoleContent => ({
  title: "Floor", views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off", widgets,
});

/** Opens `shown`'s published revision in the operator's operate session, returning the new seq. */
async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole, seq: number) {
  const page = await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title,
    source: "published", revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, seq);
  return page.seq;
}

/** The frozen installs `watched` currently lists for console `consoleId`. */
const frozenOf = (watched: Awaited<ReturnType<typeof watch>>, consoleId: string) =>
  [...watched.workpieces.summaries.values()].flatMap(summary =>
    summary.type === "gadget" && summary.frozenFor?.consoleId === consoleId ? [summary.id] : []).toSorted();

describe("a console's widget registry", () => {
  it("runs each published revision's frozen install, through that console only", async () => {
    const author = await signUp(publicApi, nextUsernames("registryauthor")[0]!);
    const widget = await publishWidget(author);
    const s = await operationsSpace("registry");
    const installed = await s.space.installBlueprint(widget.blueprintId, {}, { version: 1, kind: "widget" });
    const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId: widget.blueprintId, version: 1, label: "Status", state: "resettable" };

    // Registration and placement are checked when the console is saved.
    const screen = await screenWith(s.space, [installed]);
    await expect(s.space.createConsole(consoleOf(screen.id, []))).rejects.toThrow(/does not offer/);
    await expect(s.space.createConsole(consoleOf(screen.id, [{ ...entry, version: 2 }]))).rejects.toThrow(/not .* version 2/);
    // Only the resettable declaration exists; RPC validation refuses anything else.
    await expect(s.space.createConsole(consoleOf(screen.id, [{ ...entry, state: "kept" as "resettable" }])))
      .rejects.toThrow(/widgets/);
    const created = await s.space.createConsole(consoleOf(screen.id, [entry]));
    const published = await s.space.publishConsole(created.id, created.revision);
    const frozen = published.published!.content.widgets![0]!;
    expect(frozen).toMatchObject({ label: "Status", blueprintId: widget.blueprintId, version: 1,
      frozen: { sourceGadgetId: installed, commitId: await s.watched.head(installed) } });
    expect(frozen.gadgetId).not.toBe(installed);
    expect(await waitFor("the frozen install", async () => s.watched.workpieces.summaries.get(frozen.gadgetId) ?? null)).toMatchObject(
      { frozenFor: { consoleId: created.id, revision: published.revision, sourceGadgetId: installed } });

    // The operator reaches the widget only through the published console, which shows the frozen
    // install; the workspace's gadgets are not theirs to open.
    using used = await s.operator.openGadget(s.spaceId);
    using session = await s.operator.getOperateSession();
    const [shown] = await used.listConsoles();
    expect(shown?.widgets?.map(offered => offered.gadgetId)).toEqual([frozen.gadgetId]);
    const usedScreen = await used.getConsoleScreen(created.id, screen.id, "published");
    expect(usedScreen?.sections[0]?.widgets[0]?.targetRef).toBe(`gadget:${frozen.gadgetId}`);
    await expect(used.getGadget(installed)).rejects.toThrow(/widget/);
    await expect(used.getGadget(frozen.gadgetId)).rejects.toThrow(/widget/);
    await expect(used.getConsoleWidget(created.id, published.revision, frozen.gadgetId)).rejects.toThrow(/not open/);
    let seq = await openConsole(session, s.spaceId, published, 0);
    await expect(used.getConsoleWidget(created.id, "0", frozen.gadgetId)).rejects.toThrow(/changed/);
    await expect(used.getConsoleWidget(created.id, published.revision, installed)).rejects.toThrow(/does not offer/);
    using handle = await used.getConsoleWidget(created.id, published.revision, frozen.gadgetId);
    expect(await handle.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    // Runtime state still changes; only authoring is frozen. The server capability, and one it
    // returns, are kept across the session changes below.
    const server = await handle.connectToGadget() as unknown as RpcStub<Versioned>;
    const tally = await server.tally();
    expect(await server.version()).toBe("v1");
    expect(await server.bump()).toBe(1);
    expect(await tally.bump()).toBe(2);

    // Another console doesn't acquire it.
    const other = await s.space.createConsole(consoleOf((await screenWith(s.space, [])).id, []));
    const otherPublished = await s.space.publishConsole(other.id, other.revision);
    await expect(used.getConsoleWidget(other.id, otherPublished.revision, frozen.gadgetId)).rejects.toThrow(/does not offer/);

    // A kept capability follows the person's session: once they move to console B, A's widget is
    // refused although A is still published, and it works again when they return to A.
    seq = await openConsole(session, s.spaceId, otherPublished, seq);
    await expect(handle.getUiBundle()).rejects.toThrow(/not open/);
    await expect(server.bump()).rejects.toThrow(/not open/);
    await expect(tally.bump()).rejects.toThrow(/not open/);
    await expect(used.getConsoleWidget(created.id, published.revision, frozen.gadgetId)).rejects.toThrow(/not open/);
    seq = await openConsole(session, s.spaceId, published, seq);
    expect(await handle.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    expect(await server.bump()).toBe(3);
    expect(await tally.bump()).toBe(4);

    // Nothing changes the frozen install: not its title, removal, an upgrade or a chat's edit.
    {
      using frozenGadget = await s.space.getGadget(frozen.gadgetId);
      await expect(frozenGadget.setTitle("Renamed")).rejects.toThrow(/frozen/);
      await expect(frozenGadget.remove()).rejects.toThrow(/frozen/);
      await expect(frozenGadget.createBlueprint("Copy")).rejects.toThrow(/frozen/);
    }
    await expect(s.space.upgradeInstall(1, frozen.gadgetId)).rejects.toThrow(/frozen/);
    // A chat can't even propose an edit to it, nor run it from a chat.
    await expect(commit(s.space, s.watched, frozen.gadgetId, widgetFiles("v1"), widgetFiles("edited")))
      .rejects.toThrow(/frozen/);
    {
      const chatId = await s.space.newChat("Look", null);
      using frozenGadget = await s.space.getGadget(frozen.gadgetId);
      await expect(frozenGadget.getUiBundle(chatId)).rejects.toThrow(/frozen/);
      await expect(frozenGadget.connectToGadget(chatId)).rejects.toThrow(/frozen/);
    }

    // Editing the registered install, or registering a new version beside it in the draft, doesn't
    // reach the operator until the console is published again. (A registered widget declares no
    // data contract, so a new version is a new install rather than an upgrade.)
    expect(await commit(s.space, s.watched, installed, widgetFiles("v1"), widgetFiles("edited")))
      .toEqual({ outcome: "merged" });
    await widget.republish("v2", 2);
    await expect(s.space.upgradeInstall(2, installed)).rejects.toThrow(/data contract/);
    const second = await s.space.installBlueprint(widget.blueprintId, {}, { version: 2, kind: "widget" });
    const draft = await s.space.replaceConsole(created.id, published.revision, consoleOf(screen.id,
        [entry, { gadgetId: second, blueprintId: widget.blueprintId, version: 2, label: "Status v2", state: "resettable" }]));
    expect((await used.listConsoles()).find(listed => listed.id === created.id)?.widgets?.map(offered => offered.label))
      .toEqual(["Status"]);
    expect(await handle.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
    {
      using api = await handle.connectToGadget() as unknown as RpcStub<Versioned>;
      expect(await api.version()).toBe("v1");
    }

    // Republishing freezes the install as it is now, and the old revision's capability stops working.
    const republished = await s.space.publishConsole(created.id, draft.revision);
    const [refrozen, added] = republished.published!.content.widgets!;
    expect(refrozen!.gadgetId).not.toBe(frozen.gadgetId);
    await expect(handle.getUiBundle()).rejects.toThrow(/changed/);
    await expect(server.bump()).rejects.toThrow(/changed/);
    await expect(tally.bump()).rejects.toThrow(/changed/);
    tally[Symbol.dispose](); server[Symbol.dispose]();
    await waitFor("the old frozen install's removal", async () =>
      s.watched.workpieces.summaries.has(frozen.gadgetId) ? null : true);
    seq = await openConsole(session, s.spaceId, republished, seq);
    using current = await used.getConsoleWidget(created.id, republished.revision, refrozen!.gadgetId);
    expect(await current.getUiBundle()).toEqual({ jsCode: widgetFiles("edited")["client.js"] });
    {
      // A new publication starts the widget's state again, as its declaration allows.
      using api = await current.connectToGadget() as unknown as RpcStub<Versioned>;
      expect(await api.version()).toBe("edited");
      expect(await api.bump()).toBe(1);
    }
    {
      using next = await used.getConsoleWidget(created.id, republished.revision, added!.gadgetId);
      using api = await next.connectToGadget() as unknown as RpcStub<Versioned>;
      expect(await api.version()).toBe("v2");
    }

    // The operator can neither register nor publish.
    await expect(used.replaceConsole(created.id, republished.revision, consoleOf(screen.id, []))).rejects.toThrow(/Unauthorized/);
    await expect(used.publishConsole(created.id, republished.revision)).rejects.toThrow(/Unauthorized/);

    // Deleting the console removes its frozen install.
    await s.space.deleteConsole(created.id, republished.revision);
    await waitFor("the frozen installs' removal", async () =>
      s.watched.workpieces.summaries.has(refrozen!.gadgetId) || s.watched.workpieces.summaries.has(added!.gadgetId)
        ? null : true);
  });

  it("keeps the live publication when a publish is refused or loses a race", async () => {
    const author = await signUp(publicApi, nextUsernames("raceauthor")[0]!);
    const widget = await publishWidget(author);
    const s = await operationsSpace("race");
    const installed = await s.space.installBlueprint(widget.blueprintId, {}, { version: 1, kind: "widget" });
    const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId: widget.blueprintId, version: 1, label: "Status", state: "resettable" };
    const screen = await screenWith(s.space, [installed]);
    const created = await s.space.createConsole(consoleOf(screen.id, [entry]));
    const published = await s.space.publishConsole(created.id, created.revision);
    const live = published.published!.content.widgets![0]!.gadgetId;
    await waitFor("the frozen install", async () => frozenOf(s.watched, created.id).length === 1 || null);

    // Two publishes of one revision: one wins, and only its frozen install survives.
    const draft = await s.space.replaceConsole(created.id, published.revision, consoleOf(screen.id, [{ ...entry, label: "Again" }]));
    const outcomes = await Promise.allSettled([
      s.space.publishConsole(created.id, draft.revision), s.space.publishConsole(created.id, draft.revision)]);
    const won = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    expect(won).toHaveLength(1);
    const winner = won[0]!.published!.content.widgets![0]!.gadgetId;
    await waitFor("only the winner's frozen install", async () =>
      JSON.stringify(frozenOf(s.watched, created.id)) === JSON.stringify([winner]) || null);
    expect(winner).not.toBe(live);

    // A refused publication (the registered install is gone) creates nothing and keeps what
    // operators have.
    const current = won[0]!;
    const workpiecesBefore = s.watched.workpieces.summaries.size;
    {
      using source = await s.space.getGadget(installed);
      await source.remove();
    }
    await waitFor("the install's removal", async () => s.watched.workpieces.summaries.has(installed) ? null : true);
    await expect(s.space.publishConsole(created.id, current.revision)).rejects.toThrow(/not a gadget/);
    expect((await s.space.getConsole(created.id, "published"))?.widgets?.map(offered => offered.gadgetId)).toEqual([winner]);
    expect(frozenOf(s.watched, created.id)).toEqual([winner]);
    expect(s.watched.workpieces.summaries.size).toBe(workpiecesBefore - 1);
    using used = await s.operator.openGadget(s.spaceId);
    using session = await s.operator.getOperateSession();
    await openConsole(session, s.spaceId, (await used.getConsole(created.id, "published"))!, 0);
    using kept = await used.getConsoleWidget(created.id, current.revision, winner);
    expect(await kept.getUiBundle()).toEqual({ jsCode: widgetFiles("v1")["client.js"] });
  });

  it("refuses a whole-workspace widget install to the use role outside a console", async () => {
    const author = await signUp(publicApi, nextUsernames("wholeauthor")[0]!);
    const widget = await publishWidget(author);
    const [ownerName, viewerName] = nextUsernames("wholeowner", "wholeviewer");
    const owner = await signUp(publicApi, ownerName!);
    const viewer = await signUp(publicApi, viewerName!);
    const workspace = await owner.newGadgetFromBlueprint(widget.blueprintId, {}, { kind: "widget" });
    const metadata = await workspace.getMetadata();
    expect(await workspace.addCollaborator(viewerName!, "use")).toBeTruthy();
    using shared = await viewer.openGadget(metadata.id);
    await expect(shared.getGadget(metadata.defaultGadgetId!)).rejects.toThrow(/widget/);
  });

  it("refuses a widget that may not be frozen, and a gadget that is not a widget", async () => {
    const author = await signUp(publicApi, nextUsernames("refusalauthor")[0]!);
    const s = await operationsSpace("refusal");

    // A version declaring a data contract keeps durable state, which a publication would reset.
    const workspace = await author.newGadget("widget");
    const watched = await watch(workspace);
    const gadget = workspace.createGadget("Durable", undefined, "DURABLE");
    const gadgetId = await gadget.getId();
    await commit(workspace, watched, gadgetId, {}, widgetFiles("v1"));
    const durable = await gadget.createBlueprint("Durable", "", undefined, { dataContract: 1 });
    await waitFor("the published blueprint", () => reader.getBlueprintInfo(durable.id));
    const installed = await s.space.installBlueprint(durable.id, {}, { version: 1 });
    const screen = await screenWith(s.space, [installed]);
    await expect(s.space.createConsole(consoleOf(screen.id,
        [{ gadgetId: installed, blueprintId: durable.id, version: 1, label: "Durable", state: "resettable" }])))
      .rejects.toThrow(/data contract/);

    // A gadget that is no install can't be registered under a blueprint it doesn't run.
    const own = await s.space.createGadget("Own", undefined, "OWN").getId();
    await expect(s.space.createConsole(consoleOf((await screenWith(s.space, [own])).id,
        [{ gadgetId: own, blueprintId: durable.id, version: 1, label: "Own", state: "resettable" }])))
      .rejects.toThrow(/not a blueprint install/);
  });

  it("publishes a widget only if its files make one", async () => {
    const author = await signUp(publicApi, nextUsernames("kindauthor")[0]!);
    const workspace = await author.newGadget("widget");
    const watched = await watch(workspace);
    const gadget = workspace.createGadget("Half", undefined, "HALF");
    const gadgetId = await gadget.getId();
    const uiOnly = { "client.js": widgetFiles("v1")["client.js"]! };
    await commit(workspace, watched, gadgetId, {}, uiOnly);
    await expect(gadget.createBlueprint("Half")).rejects.toThrow(/cannot be published as a widget.*server/);

    // Published as an app, it can't become a widget version either.
    await workspace.setKind("app");
    const app = await gadget.createBlueprint("Half");
    await workspace.setKind("widget");
    await expect(workspace.updateBlueprint(app.id, { updateCode: true })).rejects.toThrow(/cannot be published as a widget/);
  });
});

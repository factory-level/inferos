import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { BoundViewEntry, HostBoardEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// Console bound views (MVP-26, bound-view contract PR 2c) against the real kernel: a view-only
// widget install is registered as a bound view over the console's host board, never as a widget;
// publication freezes the spec of the source's commit at publication, and that publication
// outlives later edits and the source's deletion. Synthetic data only; no board is read here.

const ENG = "inferops://acme.operations/project/board/ENG";
const spec = (title: string) => JSON.stringify({ version: 1, title, requirements: ["board"],
  root: { type: "count", label: "Open", of: { requirement: "board", collection: "issues" } } });

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true",
        INFEROPS_HOST_BOARDS: "true", INFEROPS_BOUND_VIEWS: "true" };
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

describe("a console's bound views", () => {
  it("registers a view only as a bound view, freezes its commit's spec, and outlives the source", async () => {
    const [authorName, builderName] = nextUsernames("bvauthor", "bvbuilder");
    const author = await signUp(publicApi, authorName!);
    const builder: RpcStub<AuthenticatedApi> = await signUp(publicApi, builderName!);

    // A view-only widget, published as blueprint version 1.
    const workspace = await author.newGadget("widget");
    const authored = await watch(workspace);
    const gadget = workspace.createGadget("Open issues", undefined, "OPEN");
    const authoredId = await gadget.getId();
    expect(await commit(workspace, authored, authoredId, {}, { "view.json": spec("Open") })).toEqual({ outcome: "merged" });
    const blueprint = await gadget.createBlueprint("Open issues", "A bound view");
    await waitFor("the published blueprint", () => builder.getBlueprintInfo(blueprint.id));

    const space = await builder.newGadget("app");
    const watched = await watch(space);
    const installed = await space.installBlueprint(blueprint.id, {}, { version: 1, kind: "widget" });
    const screen = await space.createCanvas({ title: "Floor", sections: [] });
    const board: HostBoardEntry = { kind: "host-board", label: "Board", requirement: { name: "board", resource: "inferops-board", target: ENG } };
    const entry: BoundViewEntry = { kind: "bound-view", gadgetId: installed, blueprintId: blueprint.id, version: 1, label: "Open", requirements: ["board"] };
    const content = (boundViews: BoundViewEntry[] = [entry]): OperateConsoleContent => ({ title: "Floor", fullChat: "off",
      views: [{ id: "floor", title: "Floor", type: "screen", screen: screen.id }], hostBoards: [board], boundViews });

    // A view is not a widget: the ordinary registry refuses it.
    await expect(space.createConsole({ ...content([]), widgets: [{ gadgetId: installed, blueprintId: blueprint.id, version: 1,
      label: "Open", state: "resettable" }] })).rejects.toThrow(/view with no code; offer it as a bound view/);
    // Save refusals: an inexact or missing requirement, a forged provenance, a forged id.
    await expect(space.createConsole(content([{ ...entry, requirements: ["Board"] }]))).rejects.toThrow(/not the name of one/);
    await expect(space.createConsole(content([{ ...entry, requirements: [] }]))).rejects.toThrow(/reads 1-4/);
    await expect(space.createConsole(content([{ ...entry, version: 2 }]))).rejects.toThrow(/not .* version 2/);
    await expect(space.createConsole(content([{ ...entry, gadgetId: installed + 1000 }]))).rejects.toThrow(/not a gadget of this workspace/);
    await expect(space.createConsole(content([{ ...entry, id: "forged" }]))).rejects.toThrow(/not this console's/);

    const created = await space.createConsole(content());
    const head = await watched.head(installed);
    const published = await space.publishConsole(created.id, created.revision);
    const frozen = published.published!.content.boundViews![0]!;
    expect(frozen).toEqual({ ...created.boundViews![0], frozen: { sourceGadgetId: installed, commitId: head, specText: spec("Open") } });

    // An edit to the source reaches no one until a republish; gaining client.js refuses one.
    expect(await commit(space, watched, installed, { "view.json": spec("Open") }, { "view.json": spec("Edited") }))
      .toEqual({ outcome: "merged" });
    expect((await space.getConsole(created.id, "published"))!.boundViews).toEqual([frozen]);
    expect(await commit(space, watched, installed, { "view.json": spec("Edited") }, { "view.json": spec("Edited"), "client.js": "" }))
      .toEqual({ outcome: "merged" });
    await expect(space.publishConsole(created.id, published.revision)).rejects.toThrow(/not a view-only widget.*client\.js/);
    expect((await space.getConsole(created.id, "published"))!.boundViews).toEqual([frozen]);
    expect(await commit(space, watched, installed, { "view.json": spec("Edited"), "client.js": "" }, { "view.json": spec("Edited") }))
      .toEqual({ outcome: "merged" });
    const republished = await space.publishConsole(created.id, published.revision);
    expect(republished.published!.content.boundViews![0]!.frozen).toEqual(
      { sourceGadgetId: installed, commitId: await watched.head(installed), specText: spec("Edited") });

    // Deleting the source leaves the publication; republishing it is refused.
    {
      using source = await space.getGadget(installed);
      await source.remove();
    }
    await waitFor("the source's removal", async () => watched.workpieces.summaries.has(installed) ? null : true);
    const live = await space.getConsole(created.id, "published");
    expect(live!.boundViews).toEqual(republished.published!.content.boundViews);
    await expect(space.publishConsole(created.id, republished.revision)).rejects.toThrow(/not a gadget of this workspace/);
    expect(await space.getConsole(created.id, "published")).toEqual(live);
  });
});

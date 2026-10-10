import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, OperateSession, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { BoundViewEntry, ConsoleRef, HostBoardEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// Console bound views (MVP-26, bound-view contract PR 2c) against the real kernel: a view-only
// widget install is registered as a bound view over the console's host board, never as a widget;
// publication freezes the spec of the source's commit at publication, and that publication
// outlives later edits and the source's deletion. Delivery (PR 2d) hands the caller's own operate
// session plain data only: a publication's frozen spec, or a draft's spec read from its source at a
// pinned commit. Synthetic data only; no board is read here.

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

async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole,
    source: "published" | "draft" = "published") {
  const seq = (await session.listEvents(0, 200)).at(-1)?.seq ?? 0;
  await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title, source,
    revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, seq);
}

const refOf = (shown: OperateConsole, source: "published" | "draft" = "published"): ConsoleRef =>
  ({ consoleId: shown.id, source, revision: shown.revision });

describe("delivering a console's bound views", () => {
  it("gives the caller's own session the frozen spec and mapping, or a draft's spec pinned by commit, and nothing else", async () => {
    const [authorName, builderName, operatorName] = nextUsernames("bvdauthor", "bvdbuilder", "bvdoperator");
    const author = await signUp(publicApi, authorName!);
    const builder = await signUp(publicApi, builderName!);
    const operator = await signUp(publicApi, operatorName!);

    const workspace = await author.newGadget("widget");
    const authored = await watch(workspace);
    const gadget = workspace.createGadget("Open issues", undefined, "OPEN");
    const authoredId = await gadget.getId();
    await commit(workspace, authored, authoredId, {}, { "view.json": spec("Open") });
    const blueprint = await gadget.createBlueprint("Open issues", "A bound view");
    await waitFor("the published blueprint", () => builder.getBlueprintInfo(blueprint.id));

    const space = await builder.newGadget("app");
    const watched = await watch(space);
    const installed = await space.installBlueprint(blueprint.id, {}, { version: 1, kind: "widget" });
    const screen = await space.createCanvas({ title: "Floor", sections: [] });
    const content: OperateConsoleContent = { title: "Floor", fullChat: "off",
      views: [{ id: "floor", title: "Floor", type: "screen", screen: screen.id }],
      hostBoards: [{ kind: "host-board", label: "Board", requirement: { name: "board", resource: "inferops-board", target: ENG } }],
      boundViews: [{ kind: "bound-view", gadgetId: installed, blueprintId: blueprint.id, version: 1, label: "Open", requirements: ["board"] }] };
    const created = await space.createConsole(content);
    const published = await space.publishConsole(created.id, created.revision);
    const other = await space.publishConsole(...await space.createConsole(content).then(b => [b.id, b.revision] as const));
    const head = await watched.head(installed);
    expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
    const { id: workspaceId } = await space.getMetadata();
    const entryId = published.boundViews![0]!.id!;
    const moved = (from: string) => waitFor("the source's next head", async () => {
      const summary = watched.workpieces.summaries.get(installed);
      return summary?.type === "gadget" && summary.commitId !== undefined && summary.commitId !== from ? summary.commitId : null;
    });
    const mapping = [{ name: "board", hostBoardEntryId: published.hostBoards![0]!.id! }];

    // The operator, through their own session showing the published console.
    const session = await operator.getOperateSession();
    await openConsole(session, workspaceId, published);
    expect(await session.getConsoleBoundView(refOf(published), entryId)).toEqual({ consoleRef: refOf(published), entryId,
      commitId: head, specText: spec("Open"), requirements: mapping });
    expect(await session.getConsoleBoundView(refOf(published), entryId, { commitId: head }))
      .toMatchObject({ commitId: head, specText: spec("Open") });

    // A source edit after publication changes nothing delivered.
    await commit(space, watched, installed, { "view.json": spec("Open") }, { "view.json": spec("Edited") });
    const edited = await moved(head);
    expect(await session.getConsoleBoundView(refOf(published), entryId)).toMatchObject({ commitId: head, specText: spec("Open") });

    // Refusals: console B, a stale or forged revision, a forged entry, another source, another commit.
    const refused = /not open in your operate session with bound view/;
    await expect(session.getConsoleBoundView(refOf(other), other.boundViews![0]!.id!)).rejects.toThrow(refused);
    await expect(session.getConsoleBoundView({ ...refOf(published), revision: "0" }, entryId)).rejects.toThrow(refused);
    await expect(session.getConsoleBoundView(refOf(published), "forged")).rejects.toThrow(refused);
    await expect(session.getConsoleBoundView(refOf(published), published.hostBoards![0]!.id!)).rejects.toThrow(refused);
    await expect(session.getConsoleBoundView(refOf(published, "draft"), entryId)).rejects.toThrow(refused);
    await expect(session.getConsoleBoundView(refOf(published), entryId, { commitId: edited })).rejects.toThrow(refused);
    // A republish leaves the old revision stale.
    const republished = await space.publishConsole(published.id, published.revision);
    await expect(session.getConsoleBoundView(refOf(published), entryId)).rejects.toThrow(refused);
    await openConsole(session, workspaceId, republished);
    expect(await session.getConsoleBoundView(refOf(republished), entryId))
      .toMatchObject({ commitId: edited, specText: spec("Edited") });

    // The draft method is build-only: the use role and the operate session are denied it outright.
    {
      using used = await operator.openGadget(workspaceId);
      await expect(used.getConsoleBoundViewDraft(published.id, republished.revision, entryId)).rejects.toThrow(/Unauthorized/);
      using own = await session.getWorkspace();
      await expect(own.getConsoleBoundViewDraft(published.id, republished.revision, entryId)).rejects.toThrow(/operate session/);
    }

    // The builder's draft preview reads the source's current commit, or the one it pins.
    const draft = (await space.getConsole(published.id, "draft"))!;
    const preview = await builder.getOperateSession();
    await openConsole(preview, workspaceId, draft, "draft");
    expect(await preview.getConsoleBoundView(refOf(draft, "draft"), entryId)).toEqual({ consoleRef: refOf(draft, "draft"), entryId,
      commitId: edited, specText: spec("Edited"), requirements: mapping });
    await commit(space, watched, installed, { "view.json": spec("Edited") }, { "view.json": spec("Again") });
    const again = await moved(edited);
    expect(await preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: edited }))
      .toMatchObject({ commitId: edited, specText: spec("Edited") });
    expect(await preview.getConsoleBoundView(refOf(draft, "draft"), entryId)).toMatchObject({ commitId: again, specText: spec("Again") });
    // A commit that is not view-only is refused, current or pinned; an earlier one still reads.
    await commit(space, watched, installed, { "view.json": spec("Again") }, { "view.json": spec("Again"), "client.js": "" });
    const mixed = await moved(again);
    await expect(preview.getConsoleBoundView(refOf(draft, "draft"), entryId)).rejects.toThrow(/not a view-only widget/);
    await expect(preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: mixed })).rejects.toThrow(/not a view-only widget/);
    await expect(preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: "0".repeat(40) })).rejects.toThrow();
    expect(await preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: again }))
      .toMatchObject({ commitId: again, specText: spec("Again") });
    // A pin must be in the source's own history: an older ancestor reads, while another gadget's
    // view-only commit in this workspace, reading the same requirement, is refused.
    expect(await preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: head }))
      .toMatchObject({ commitId: head, specText: spec("Open") });
    const stranger = await space.createGadget("Stranger", undefined, "STRANGER").getId();
    await commit(space, watched, stranger, {}, { "view.json": spec("Stranger") });
    const strangerHead = await watched.head(stranger);
    await expect(preview.getConsoleBoundView(refOf(draft, "draft"), entryId, { commitId: strangerHead }))
      .rejects.toThrow(/not in the recent history of bound view/);
    await expect(space.getConsoleBoundViewDraft(draft.id, draft.revision, entryId, strangerHead))
      .rejects.toThrow(/not in the recent history of bound view/);
    // The operator cannot open the draft in their session, so cannot preview it.
    await expect(openConsole(session, workspaceId, draft, "draft")).rejects.toThrow(/no longer available to you/);
    await expect(session.getConsoleBoundView(refOf(draft, "draft"), entryId)).rejects.toThrow(refused);
  });
});

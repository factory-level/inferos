import { expect, it } from "vitest";
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, signUp } from "../src/rpc-client.js";

const withHarness = async (durable: boolean, run: (url: URL) => Promise<void>) => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: String(durable) };
  } });
  try {
    await run(harness.url);
  } finally {
    await harness.server.close(); network.uninstall(); expect(network.getUnmockedCalls()).toEqual([]);
  }
};

it("denies consoles unless durable views are enabled", () => withHarness(false, async url => {
  using api = connect(url);
  using owner = await signUp(api, "consolesdisabled");
  using workspace = await owner.newGadget();
  await expect(workspace.listConsoles()).rejects.toThrow(/disabled/);
  await expect(workspace.createConsole({
    title: "Console", fullChat: "off", views: [{ id: "a", title: "A", type: "screen", screen: "a" }],
  })).rejects.toThrow(/disabled/);
}));

it("stores consoles over the workspace's own screens, with revisions", () => withHarness(true, async url => {
  using api = connect(url);
  using owner = await signUp(api, "consolesowner");
  using workspace = await owner.newGadget();
  await workspace.newChat("Console workspace", null);
  const board = await workspace.createCanvas({ title: "Board", sections: [] });
  const activity = await workspace.createCanvas({ title: "Activity", sections: [] });

  const created = await workspace.createConsole({
    title: "  Operations lead  ", fullChat: "available",
    views: [
      { id: "overview", title: "Overview", type: "rollup", screens: [board.id, activity.id] },
      { id: "board", title: "Board", type: "screen", screen: board.id },
    ],
  });
  expect(created).toMatchObject({ title: "Operations lead", revision: "0", fullChat: "available", published: null });
  expect(await workspace.listConsoles()).toEqual([created]);

  const replaced = await workspace.replaceConsole(created.id, "0", { ...created, fullChat: "only" });
  expect(replaced).toMatchObject({ id: created.id, revision: "1", fullChat: "only" });
  await expect(workspace.replaceConsole(created.id, "0", created)).rejects.toThrow(/reload/);
  await expect(workspace.deleteConsole(created.id, "0")).rejects.toThrow(/reload/);

  // Views must reference screens of this workspace.
  using other = await owner.newGadget();
  const foreign = await other.createCanvas({ title: "Elsewhere", sections: [] });
  await expect(workspace.createConsole({
    title: "Bad", fullChat: "off", views: [{ id: "x", title: "X", type: "screen", screen: foreign.id }],
  })).rejects.toThrow(/not a screen/);
  await expect(workspace.createConsole({ title: "Empty", fullChat: "off", views: [] })).rejects.toThrow(/1-12 views/);
  expect(await other.listConsoles()).toEqual([]);

  await workspace.deleteConsole(created.id, "1");
  expect(await workspace.listConsoles()).toEqual([]);
}));

const consoleChanged = (caught: unknown) => {
  expect(getOperateSessionErrorCode(caught)).toBe(OPERATE_SESSION_ERROR_CODES.consoleChanged);
  return true;
};

it("lets a use-role operator use only the published revision, while a builder previews the draft", () =>
  withHarness(true, async url => {
    using api = connect(url);
    using owner = await signUp(api, "consolesbuilder");
    using workspace = await owner.newGadget();
    await workspace.newChat("Console workspace", null);
    const board = await workspace.createCanvas({ title: "Board", sections: [] });
    const activity = await workspace.createCanvas({ title: "Activity", sections: [] });
    const elsewhere = await workspace.createCanvas({ title: "Elsewhere", sections: [] });
    const created = await workspace.createConsole({
      title: "Operations lead", fullChat: "available",
      views: [
        { id: "overview", title: "Overview", type: "rollup", screens: [board.id, activity.id] },
        { id: "board", title: "Board", type: "screen", screen: board.id },
      ],
    });
    expect(created.published).toBeNull();
    const { id: workspaceId } = await workspace.getMetadata();

    using operatorApi = await signUp(api, "consolesoperator");
    if (!await workspace.addCollaborator("consolesoperator", "use")) throw new Error("Failed to share");
    // Listed for them as soon as it is shared, before they ever open it: their Operate home finds
    // its consoles only through this listing.
    expect((await operatorApi.listGadgets()).find(listed => listed.id === workspaceId))
      .toMatchObject({ role: "use", owner: expect.objectContaining({ name: expect.any(String) }) });
    using useWorkspace = await operatorApi.openGadget(workspaceId);
    using session = await operatorApi.getOperateSession();
    const open = { type: "openConsole", workspaceId, consoleId: created.id, title: created.title,
      source: "published", revision: "1", fullChat: "available", viewId: "overview" } as const;

    // An unpublished draft is invisible to the operator: not listed, its screens unreadable, and it
    // can't be opened.
    expect(await useWorkspace.listConsoles()).toEqual([]);
    expect(await useWorkspace.getConsole(created.id, "published")).toBeNull();
    expect(await useWorkspace.listCanvases()).toEqual([]);
    expect(await useWorkspace.getCanvas(board.id)).toBeNull();
    await expect(session.dispatch(open, 0)).rejects.toSatisfy(consoleChanged);

    // Publishing makes the draft what operators use, read-only, at a new revision.
    const denied = /Unauthorized: this collaborator only has permission/;
    await expect(useWorkspace.publishConsole(created.id, "0")).rejects.toThrow(denied);
    const published = await workspace.publishConsole(created.id, "0");
    expect(published).toMatchObject({ revision: "1", published: { revision: "1", content: { title: "Operations lead" } } });
    const operatorView = published;
    expect(await useWorkspace.listConsoles()).toEqual([operatorView]);
    expect(await useWorkspace.getConsole(created.id, "published")).toEqual(operatorView);
    await expect(useWorkspace.createConsole(created)).rejects.toThrow(denied);
    await expect(useWorkspace.replaceConsole(created.id, "1", created)).rejects.toThrow(denied);
    await expect(useWorkspace.deleteConsole(created.id, "1")).rejects.toThrow(denied);

    // It reads the screens the published console shows, read-only, and no other.
    expect((await useWorkspace.listCanvases()).map(screen => screen.id).toSorted())
      .toEqual([board.id, activity.id].toSorted());
    expect(await useWorkspace.getCanvas(board.id)).toEqual(board);
    expect(await useWorkspace.getConsoleScreen(created.id, board.id, "published")).toEqual(board);
    expect(await useWorkspace.getCanvas(elsewhere.id)).toBeNull();
    await expect(useWorkspace.editCanvas(board.id, board.revision, [{ type: "rename", title: "Denied" }]))
      .rejects.toThrow(denied);
    await expect(useWorkspace.deleteCanvas(board.id, board.revision)).rejects.toThrow(denied);

    // A view, full chat setting or revision the console does not have is refused, and nothing changes.
    await expect(session.dispatch({ ...open, viewId: "missing" }, 0)).rejects.toSatisfy(consoleChanged);
    await expect(session.dispatch({ ...open, fullChat: "only" }, 0)).rejects.toSatisfy(consoleChanged);
    await expect(session.dispatch({ ...open, revision: "0" }, 0)).rejects.toSatisfy(consoleChanged);
    await expect(session.dispatch({ ...open, consoleId: "missing" }, 0)).rejects.toSatisfy(consoleChanged);
    let page = await session.dispatch(open, 0);
    expect(page.state.console).toMatchObject({
      consoleId: created.id, source: "published", revision: "1", viewId: "overview", screenId: null,
    });

    // Screens must belong to the shown view; null (back to the view) always applies.
    await expect(session.dispatch({ type: "showScreen", screenId: elsewhere.id }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "showScreen", screenId: activity.id }, page.seq);
    page = await session.dispatch({ type: "showScreen", screenId: null }, page.seq);
    await expect(session.dispatch({ type: "openView", viewId: "missing" }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "openView", viewId: "board" }, page.seq);
    await expect(session.dispatch({ type: "showScreen", screenId: activity.id }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "openView", viewId: "overview" }, page.seq);

    // Draft edits, to the console and to a screen it shows, leave the operator's console as published.
    const draft = await workspace.replaceConsole(created.id, "1", { ...created, views: [created.views[1]!] });
    const renamed = await workspace.editCanvas(board.id, board.revision, [{ type: "rename", title: "Board v2" }]);
    expect(draft).toMatchObject({ revision: "2", published: { revision: "1" } });
    expect(await useWorkspace.listConsoles()).toEqual([operatorView]);
    expect(await useWorkspace.getCanvas(board.id)).toEqual(board);
    page = await session.dispatch({ type: "showScreen", screenId: activity.id }, page.seq);

    // The operator can't preview the draft; the builder can, and sees the edits.
    await expect(useWorkspace.getConsole(created.id, "draft")).rejects.toThrow(denied);
    await expect(useWorkspace.getConsoleScreen(created.id, board.id, "draft")).rejects.toThrow(denied);
    await expect(session.dispatch({ ...open, source: "draft", revision: "2", viewId: "board" }, page.seq))
      .rejects.toSatisfy(consoleChanged);
    expect(await workspace.getConsole(created.id, "draft")).toEqual(draft);
    expect(await workspace.getConsoleScreen(created.id, board.id, "draft")).toEqual(renamed);
    expect(await workspace.getConsoleScreen(created.id, board.id, "published")).toEqual(board);
    using builderSession = await owner.getOperateSession();
    let preview = await builderSession.dispatch({ ...open, source: "draft", revision: "2", viewId: "board" }, 0);
    expect(preview.state.console).toMatchObject({ source: "draft", revision: "2", viewId: "board" });

    // Publishing again: two publishes at the same revision can't both win.
    const republished = await workspace.publishConsole(created.id, "2");
    await expect(workspace.publishConsole(created.id, "2")).rejects.toThrow(/reload/);
    expect(await useWorkspace.getCanvas(board.id)).toEqual(renamed);
    expect(await useWorkspace.getCanvas(activity.id)).toBeNull();
    expect(republished).toMatchObject({ revision: "3", published: { revision: "3" } });
    expect(await useWorkspace.listConsoles()).toEqual([republished]);

    // The operator's open console moves on at its next navigation: refused once, then reopened.
    await expect(session.dispatch({ type: "openView", viewId: "board" }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ ...open, revision: "3", viewId: "board" }, page.seq);
    expect(page.state.console).toMatchObject({ revision: "3", viewId: "board" });

    // Deleting the console removes its published revision too.
    await workspace.deleteConsole(created.id, "3");
    expect(await useWorkspace.listConsoles()).toEqual([]);
    expect(await useWorkspace.getCanvas(board.id)).toBeNull();

    // Someone without access to the console's workspace cannot open it.
    using strangerApi = await signUp(api, "consolesstranger");
    using strangerSession = await strangerApi.getOperateSession();
    await expect(strangerSession.dispatch({ ...open, viewId: "board" }, 0)).rejects.toSatisfy(consoleChanged);
  }));

it("gives every publish a new revision: one winner per expected revision, and a screen-only republish moves open consoles", () =>
  withHarness(true, async url => {
    using api = connect(url);
    using owner = await signUp(api, "consolesrepublisher");
    using workspace = await owner.newGadget();
    await workspace.newChat("Console workspace", null);
    const board = await workspace.createCanvas({ title: "Board", sections: [] });
    const created = await workspace.createConsole({
      title: "Operations lead", fullChat: "off", views: [{ id: "board", title: "Board", type: "screen", screen: board.id }],
    });
    const { id: workspaceId } = await workspace.getMetadata();
    using operatorApi = await signUp(api, "consolesrepublishop");
    if (!await workspace.addCollaborator("consolesrepublishop", "use")) throw new Error("Failed to share");
    using useWorkspace = await operatorApi.openGadget(workspaceId);

    // Two publishes with the same expected revision: exactly one wins.
    const first = await workspace.publishConsole(created.id, created.revision);
    expect(first.published?.revision).toBe(first.revision);
    expect(first.revision).not.toBe(created.revision);

    using session = await operatorApi.getOperateSession();
    let page = await session.dispatch({ type: "openConsole", workspaceId, consoleId: created.id, title: created.title,
      source: "published", revision: first.revision, fullChat: "off", viewId: "board" }, 0);

    // The losing publish, made after a screen edit, changes nothing operators see.
    const renamed = await workspace.editCanvas(board.id, board.revision, [{ type: "rename", title: "Board v2" }]);
    await expect(workspace.publishConsole(created.id, created.revision)).rejects.toThrow(/reload/);
    expect(await useWorkspace.getConsole(created.id, "published")).toEqual(first);
    expect(await useWorkspace.getConsoleScreen(created.id, board.id, "published")).toEqual(board);
    page = await session.dispatch({ type: "openView", viewId: "board" }, page.seq);

    // A screen-only republish changes the publication identity, so the open console is refused on
    // its next move, and reopening it reads the new screen snapshot.
    const second = await workspace.publishConsole(created.id, first.revision);
    expect(second.published?.revision).toBe(second.revision);
    expect(second.revision).not.toBe(first.revision);
    await expect(session.dispatch({ type: "openView", viewId: "board" }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "openConsole", workspaceId, consoleId: created.id, title: created.title,
      source: "published", revision: second.revision, fullChat: "off", viewId: "board" }, page.seq);
    expect(page.state.console).toMatchObject({ revision: second.revision });
    expect(await useWorkspace.getConsole(created.id, "published")).toEqual(second);
    expect(await useWorkspace.getConsoleScreen(created.id, board.id, "published")).toEqual(renamed);
  }));

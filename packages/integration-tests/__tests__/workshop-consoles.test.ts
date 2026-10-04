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
  expect(created).toMatchObject({ title: "Operations lead", revision: "0", fullChat: "available" });
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

it("lets a use-role operator read consoles, and checks console navigation against the current definition", () =>
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
    const { id: workspaceId } = await workspace.getMetadata();

    // A use-role operator lists the consoles read-only, without Build.
    using operatorApi = await signUp(api, "consolesoperator");
    if (!await workspace.addCollaborator("consolesoperator", "use")) throw new Error("Failed to share");
    using useWorkspace = await operatorApi.openGadget(workspaceId);
    expect(await useWorkspace.listConsoles()).toEqual([created]);
    const denied = /Unauthorized: this collaborator only has permission/;
    await expect(useWorkspace.createConsole(created)).rejects.toThrow(denied);
    await expect(useWorkspace.replaceConsole(created.id, "0", created)).rejects.toThrow(denied);
    await expect(useWorkspace.deleteConsole(created.id, "0")).rejects.toThrow(denied);

    // It reads the screens a console shows, read-only, and no other.
    expect((await useWorkspace.listCanvases()).map(screen => screen.id).toSorted())
      .toEqual([board.id, activity.id].toSorted());
    expect(await useWorkspace.getCanvas(board.id)).toEqual(board);
    expect(await useWorkspace.getCanvas(elsewhere.id)).toBeNull();
    await expect(useWorkspace.editCanvas(board.id, board.revision, [{ type: "rename", title: "Denied" }]))
      .rejects.toThrow(denied);
    await expect(useWorkspace.deleteCanvas(board.id, board.revision)).rejects.toThrow(denied);

    using session = await operatorApi.getOperateSession();
    const open = { type: "openConsole", workspaceId, consoleId: created.id, title: created.title,
      fullChat: "available", viewId: "overview" } as const;
    // A view or full chat setting the console does not have is refused, and nothing changes.
    await expect(session.dispatch({ ...open, viewId: "missing" }, 0)).rejects.toSatisfy(consoleChanged);
    await expect(session.dispatch({ ...open, fullChat: "only" }, 0)).rejects.toSatisfy(consoleChanged);
    await expect(session.dispatch({ ...open, consoleId: "missing" }, 0)).rejects.toSatisfy(consoleChanged);
    let page = await session.dispatch(open, 0);
    expect(page.state.console).toMatchObject({ consoleId: created.id, viewId: "overview", screenId: null });

    // Screens must belong to the shown view; null (back to the view) always applies.
    await expect(session.dispatch({ type: "showScreen", screenId: elsewhere.id }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "showScreen", screenId: activity.id }, page.seq);
    page = await session.dispatch({ type: "showScreen", screenId: null }, page.seq);
    await expect(session.dispatch({ type: "openView", viewId: "missing" }, page.seq)).rejects.toSatisfy(consoleChanged);
    page = await session.dispatch({ type: "openView", viewId: "board" }, page.seq);
    await expect(session.dispatch({ type: "showScreen", screenId: activity.id }, page.seq)).rejects.toSatisfy(consoleChanged);

    // The check reads the definition as it is now, not as the session copied it in.
    await workspace.replaceConsole(created.id, "0", { ...created, views: [created.views[1]!] });
    await expect(session.dispatch({ type: "openView", viewId: "overview" }, page.seq)).rejects.toSatisfy(consoleChanged);
    // A screen the console stopped showing is no longer readable to the operator.
    expect(await useWorkspace.getCanvas(activity.id)).toBeNull();
    expect((await useWorkspace.listCanvases()).map(screen => screen.id)).toEqual([board.id]);

    // Someone without access to the console's workspace cannot open it.
    using strangerApi = await signUp(api, "consolesstranger");
    using strangerSession = await strangerApi.getOperateSession();
    await expect(strangerSession.dispatch({ ...open, viewId: "board" }, 0)).rejects.toSatisfy(consoleChanged);
  }));

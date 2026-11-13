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

it("refuses a console that belongs to no workspace unless durable views are enabled", () => withHarness(false, async url => {
  using api = connect(url);
  using owner = await signUp(api, "fcdisabled");
  await expect(owner.newConsole("Operations lead")).rejects.toThrow(/disabled/);
  expect(await owner.listMyConsoles()).toEqual([]);
}));

it("creates a console by name for a person with no workspace, with a page and a draft", () => withHarness(true, async url => {
  using api = connect(url);
  using owner = await signUp(api, "fcowner");
  const summary = await owner.newConsole("  Field operations  ");
  expect(summary).toMatchObject({ title: "Field operations", role: "build", published: false });

  // The console is listed on its own, and never among the person's workspaces.
  expect(await owner.listGadgets()).toEqual([]);
  expect((await owner.listMyConsoles()).map(listed => listed.id)).toEqual([summary.id]);
  // Its id names no workspace.
  await expect(owner.openGadget(summary.id)).rejects.toThrow();

  using authoring = await owner.openConsoleAuthoring(summary.id);
  const draft = await authoring.getConsole("draft");
  const [page] = await authoring.listCanvases();
  expect(draft).toMatchObject({ title: "Field operations", revision: "0", published: null,
    views: [{ id: "overview", type: "screen", screen: page.id }] });
  expect(await authoring.getConsole("published")).toBeNull();

  // Pages are the console's own; the draft is replaced at its revision.
  const board = await authoring.createCanvas({ title: "Board", sections: [] });
  const saved = await authoring.replaceConsole("0", { ...draft!, title: "Field ops",
    views: [...draft!.views, { id: "board", title: "Board", type: "screen", screen: board.id }] });
  expect(saved).toMatchObject({ revision: "1", title: "Field ops" });
  await expect(authoring.replaceConsole("0", saved)).rejects.toThrow(/reload/);
  expect((await owner.listMyConsoles())[0]).toMatchObject({ title: "Field ops" });

  // What only a workspace holds is refused.
  await expect(authoring.createCanvas({ title: "Gadget", sections: [{ id: "s", title: "S", columns: 1,
    widgets: [{ id: "w", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {} }] }] }))
    .rejects.toThrow(/not enabled/);
  await expect(authoring.replaceConsole("1", { ...saved,
    flows: [{ id: "f", flowId: "missing" }] } as never)).rejects.toThrow();
  expect(await authoring.validateConsoleDraft()).toEqual([]);

  // Nobody else can open it, and a refusal lists nothing for them.
  using stranger = await signUp(api, "fcstranger");
  await expect(stranger.openConsoleReading(summary.id)).rejects.toThrow(/access/);
  await expect(stranger.openConsoleAuthoring(summary.id)).rejects.toThrow(/access/);
  expect(await stranger.listMyConsoles()).toEqual([]);
}));

it("publishes for the people it is shared with, who read only the published revision", () => withHarness(true, async url => {
  using api = connect(url);
  using owner = await signUp(api, "fcpublisher");
  const { id } = await owner.newConsole("Dispatch");
  using authoring = await owner.openConsoleAuthoring(id);
  const [page] = await authoring.listCanvases();

  using operator = await signUp(api, "fcoperator");
  expect(await authoring.addCollaborator("nobodyatall", "use")).toBeNull();
  expect(await authoring.addCollaborator("fcoperator", "use")).toMatchObject({ role: "use" });
  // Listed for them at once, on their own console list and not among their workspaces.
  expect(await operator.listMyConsoles()).toMatchObject([{ id, title: "Dispatch", role: "use", published: false }]);
  expect(await operator.listGadgets()).toEqual([]);

  using reading = await operator.openConsoleReading(id);
  expect(await reading.getConsole()).toBeNull();
  await expect(operator.openConsoleAuthoring(id)).rejects.toThrow(/access/);

  const published = await authoring.publishConsole("0");
  expect(published).toMatchObject({ revision: "1", published: { revision: "1" } });
  expect(await reading.getConsole()).toMatchObject({ title: "Dispatch", revision: "1" });
  expect(await reading.getConsoleScreen(page.id)).toMatchObject({ title: "Overview" });
  expect(await reading.getConsolePage(page.id)).toMatchObject({ id: page.id });
  expect(await operator.listMyConsoles()).toMatchObject([{ id, published: true }]);

  // Later edits stay draft until the next publish.
  await authoring.editCanvas(page.id, "0", [{ type: "rename", title: "Today" }]);
  await authoring.replaceConsole("1", { ...published, title: "Dispatch desk" });
  expect(await reading.getConsole()).toMatchObject({ title: "Dispatch", revision: "1" });
  expect(await reading.getConsoleScreen(page.id)).toMatchObject({ title: "Overview" });

  // A removed person is refused at their next call, on the capability they already hold.
  await authoring.removeCollaborator("fcoperator");
  await expect(reading.getConsole()).rejects.toThrow(/access/);
  expect(await operator.listMyConsoles()).toEqual([]);
}));

const consoleChanged = (error: unknown) => getOperateSessionErrorCode(error) === OPERATE_SESSION_ERROR_CODES.consoleChanged;

it("opens in the operate session of a person it is shared with, by its own id and no workspace", () => withHarness(true, async url => {
  using api = connect(url);
  using owner = await signUp(api, "fcsessionowner");
  const { id } = await owner.newConsole("Dispatch");
  using authoring = await owner.openConsoleAuthoring(id);
  const [page] = await authoring.listCanvases();
  using operator = await signUp(api, "fcsessionoperator");
  await authoring.addCollaborator("fcsessionoperator", "use");
  using session = await operator.getOperateSession();
  const open = { type: "openConsole", home: "console", consoleId: id, title: "Dispatch",
    source: "published", revision: "1", fullChat: "available", viewId: "overview" } as const;

  // Nothing opens before it is published, and a draft never opens in a session.
  await expect(session.dispatch(open, 0)).rejects.toSatisfy(consoleChanged);
  await authoring.publishConsole("0");
  await expect(session.dispatch({ ...open, source: "draft" }, 0)).rejects.toSatisfy(consoleChanged);
  await expect(session.dispatch({ ...open, viewId: "missing" }, 0)).rejects.toSatisfy(consoleChanged);
  await expect(session.dispatch({ ...open, revision: "0" }, 0)).rejects.toSatisfy(consoleChanged);

  let state = await session.dispatch(open, 0);
  expect(state.state.console).toEqual({ home: "console", consoleId: id, title: "Dispatch", source: "published",
    revision: "1", fullChat: "available", viewId: "overview", screenId: null });
  // The operator still has no workspace beyond their own hidden session.
  expect(await operator.listGadgets()).toEqual([]);

  await expect(session.dispatch({ type: "showScreen", screenId: "elsewhere" }, state.seq)).rejects.toSatisfy(consoleChanged);
  state = await session.dispatch({ type: "showScreen", screenId: page.id }, state.seq);
  expect(state.state.console).toMatchObject({ screenId: page.id });

  // Once it is published again, the next move is refused until the session reopens on the new revision.
  await authoring.publishConsole("1");
  await expect(session.dispatch({ type: "openView", viewId: "overview" }, state.seq)).rejects.toSatisfy(consoleChanged);
  state = await session.dispatch({ ...open, revision: "2" }, state.seq);
  expect(state.state.console).toMatchObject({ revision: "2" });

  // Someone it is not shared with cannot open it in their session.
  using stranger = await signUp(api, "fcsessionstranger");
  using theirs = await stranger.getOperateSession();
  await expect(theirs.dispatch({ ...open, revision: "2" }, 0)).rejects.toSatisfy(consoleChanged);
}));

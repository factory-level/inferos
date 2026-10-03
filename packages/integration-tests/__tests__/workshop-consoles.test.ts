import { expect, it } from "vitest";
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

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

it("denies flows unless durable views are enabled", () => withHarness(false, async url => {
  using api = connect(url);
  using owner = await signUp(api, "flowsdisabled");
  using workspace = await owner.newGadget();
  await expect(workspace.listFlows()).rejects.toThrow(/disabled/);
  await expect(workspace.createFlow({ title: "Flow", steps: ["a"] })).rejects.toThrow(/disabled/);
}));

it("stores ordered flows over the workspace's own screens, with revisions", () => withHarness(true, async url => {
  using api = connect(url);
  using owner = await signUp(api, "flowsowner");
  using workspace = await owner.newGadget();
  await workspace.newChat("Flow workspace", null);
  const intake = await workspace.createCanvas({ title: "Intake", sections: [] });
  const triage = await workspace.createCanvas({ title: "Triage", sections: [] });

  const flow = await workspace.createFlow({ title: "  Admission  ", steps: [triage.id, intake.id] });
  expect(flow).toMatchObject({ title: "Admission", steps: [triage.id, intake.id], revision: "0" });
  expect(await workspace.listFlows()).toEqual([flow]);

  // Order is the author's, and a step may repeat.
  const reordered = await workspace.replaceFlow(flow.id, "0", { title: "Admission", steps: [intake.id, triage.id, intake.id] });
  expect(reordered).toMatchObject({ id: flow.id, revision: "1", steps: [intake.id, triage.id, intake.id] });
  await expect(workspace.replaceFlow(flow.id, "0", { title: "Stale", steps: [intake.id] })).rejects.toThrow(/reload/);
  await expect(workspace.deleteFlow(flow.id, "0")).rejects.toThrow(/reload/);

  // Steps must be screens of this workspace, and a flow needs at least one.
  using other = await owner.newGadget();
  const foreign = await other.createCanvas({ title: "Elsewhere", sections: [] });
  await expect(workspace.createFlow({ title: "Bad", steps: [foreign.id] })).rejects.toThrow(/not a screen/);
  await expect(workspace.createFlow({ title: "Empty", steps: [] })).rejects.toThrow(/1-32 steps/);
  await expect(workspace.createFlow({ title: "", steps: [intake.id] })).rejects.toThrow(/title/);
  expect(await other.listFlows()).toEqual([]);

  await workspace.deleteFlow(flow.id, "1");
  expect(await workspace.listFlows()).toEqual([]);
}));

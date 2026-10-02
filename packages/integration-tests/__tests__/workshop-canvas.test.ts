import { expect, it } from "vitest";
import { startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, signUp } from "../src/rpc-client.js";

it.each([[undefined, undefined], ['true', 'false'], ['false', 'true']])("denies stored canvases unless both installation flags are enabled: %s/%s", async (composable, durable) => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: composable ?? 'false', DURABLE_VIEWS: durable ?? 'false' };
  } });
  try {
    using api = connect(harness.url);
    using owner = await signUp(api, "canvasdisabled");
    using workspace = await owner.newGadget();
    await expect(workspace.listCanvases()).rejects.toThrow(/disabled/);
    await expect(workspace.getCanvas('unknown')).rejects.toThrow(/disabled/);
    await expect(workspace.createCanvas({ title: "View", sections: [] })).rejects.toThrow(/disabled/);
    await expect(workspace.editCanvas('unknown', '0', [{ type: 'rename', title: 'New' }])).rejects.toThrow(/disabled/);
    await expect(workspace.deleteCanvas('unknown', '0')).rejects.toThrow(/disabled/);
  } finally {
    await harness.server.close(); network.uninstall(); expect(network.getUnmockedCalls()).toEqual([]);
  }
});

it("stores workspace-scoped compositions with atomic revisions, reconnect recovery and default-deny sharing", async () => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: 'true', DURABLE_VIEWS: 'true' };
  } });
  try {
    using api = connect(harness.url);
    using owner = await signUp(api, "canvasowner");
    using collaborator = await signUp(api, "canvasbuilder");
    using viewer = await signUp(api, "canvasviewer");
    using outsider = await signUp(api, "canvasoutsider");
    using workspace = await owner.newGadget();
    await workspace.newChat("Canvas workspace", null);
    const workspaceId = (await workspace.getMetadata()).id;
    const first = await workspace.createCanvas({ title: "Operations", sections: [] });
    expect(first).toMatchObject({ schemaVersion: 1, revision: '0', title: 'Operations', sections: [] });
    expect(first.id).toMatch(/^[a-f0-9-]{36}$/);
    const edits = await Promise.allSettled([
      workspace.editCanvas(first.id, '0', [{ type: 'rename', title: 'Editor A' }]),
      workspace.editCanvas(first.id, '0', [{ type: 'rename', title: 'Editor B' }]),
    ]);
    expect(edits.filter(edit => edit.status === 'fulfilled')).toHaveLength(1);
    expect(edits.filter(edit => edit.status === 'rejected')).toHaveLength(1);
    expect((await workspace.getCanvas(first.id))?.revision).toBe('1');
    using otherWorkspace = await owner.newGadget();
    expect(await otherWorkspace.getCanvas(first.id)).toBeNull();
    await expect(otherWorkspace.editCanvas(first.id, '1', [{ type: 'rename', title: 'Wrong workspace' }])).rejects.toThrow(/not found/);
    await expect(outsider.openGadget(workspaceId)).rejects.toThrow();
    const buildLink = await workspace.createShareLink('build', 'canvas builder');
    using buildSession = await collaborator.openGadget(workspaceId, buildLink.key);
    const updated = await buildSession.editCanvas(first.id, '1', [{ type: 'rename', title: 'Collaborative composition' }]);
    expect(updated.revision).toBe('2');
    await expect(workspace.editCanvas(first.id, '2', [
      { type: 'rename', title: 'Must roll back' },
      { type: 'removeSection', sectionId: 'missing' },
    ])).rejects.toThrow(/missing section/);
    expect(await workspace.getCanvas(first.id)).toEqual(updated);
    const useLink = await workspace.createShareLink('use', 'UI only');
    using useSession = await viewer.openGadget(workspaceId, useLink.key);
    await expect(useSession.listCanvases()).rejects.toThrow(/Unauthorized/);
    await expect(useSession.getCanvas(first.id)).rejects.toThrow(/Unauthorized/);
    await expect(useSession.editCanvas(first.id, '2', [{ type: 'rename', title: 'Denied' }])).rejects.toThrow(/Unauthorized/);
    using reconnectedApi = connect(harness.url);
    using reconnectedOwner = await logIn(reconnectedApi, "canvasowner");
    using reconnectedWorkspace = await reconnectedOwner.openGadget(workspaceId);
    expect(await reconnectedWorkspace.getCanvas(first.id)).toEqual(updated);
    await expect(workspace.deleteCanvas(first.id, '1')).rejects.toThrow(/Canvas changed/);
    expect(await workspace.listCanvases()).toEqual([updated]);
    await workspace.deleteCanvas(first.id, '2');
    expect(await workspace.getCanvas(first.id)).toBeNull();
    const reimported = await workspace.createCanvas({ title: updated.title, sections: updated.sections });
    expect(reimported.id).not.toBe(first.id);
    expect(reimported.revision).toBe('0');
    await Promise.all(Array.from({ length: 63 }, (_, index) => workspace.createCanvas({ title: `View ${index}`, sections: [] })));
    await expect(workspace.createCanvas({ title: 'Over quota', sections: [] })).rejects.toThrow(/limit reached/);
    expect(await workspace.listCanvases()).toHaveLength(64);
  } finally {
    await harness.server.close(); network.uninstall(); expect(network.getUnmockedCalls()).toEqual([]);
  }
});


it("retains definitions across Worker reloads while disabled operations remain unavailable", async () => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: 'true', DURABLE_VIEWS: 'true' };
  } });
  try {
    const saved = await (async () => {
      using api = connect(harness.url);
      using owner = await signUp(api, "canvasreload");
      using workspace = await owner.newGadget();
      await workspace.newChat("Retained canvas", null);
      return { workspaceId: (await workspace.getMetadata()).id,
        view: await workspace.createCanvas({ title: "Survives reload", sections: [] }) };
    })();
    const setEnabled = (enabled: boolean) => harness.server.update(options => ({ ...options,
      workers: options.workers.map(worker => {
        if (!("config" in worker)) throw new Error("Expected inline harness config");
        return { ...worker, config: { ...worker.config, vars: { ...worker.config.vars,
          COMPOSABLE_VIEWS: 'true', DURABLE_VIEWS: String(enabled) } } };
      }),
    }));
    await setEnabled(false);
    {
      using api = connect((await harness.server.listen()).url);
      using owner = await logIn(api, "canvasreload");
      using workspace = await owner.openGadget(saved.workspaceId);
      await expect(workspace.getCanvas(saved.view.id)).rejects.toThrow(/disabled/);
      await expect(workspace.deleteCanvas(saved.view.id, '0')).rejects.toThrow(/disabled/);
    }
    await setEnabled(true);
    {
      using api = connect((await harness.server.listen()).url);
      using owner = await logIn(api, "canvasreload");
      using workspace = await owner.openGadget(saved.workspaceId);
      expect(await workspace.getCanvas(saved.view.id)).toEqual(saved.view);
    }
  } finally {
    await harness.server.close(); network.uninstall(); expect(network.getUnmockedCalls()).toEqual([]);
  }
});

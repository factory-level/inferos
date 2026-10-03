import type { RpcStub } from "capnweb";
import { expect, it } from "vitest";
import type { OperateSession, OperateSessionUpdate } from "@gadgets/workshop-shared/api";
import { DEFAULT_CANVAS_CATALOG, type CanvasWidget } from "@gadgets/workshop-shared/canvas";
import type { OperateRef } from "@gadgets/workshop-shared/operate-session";
import { startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { callbackStubFor, connect, logIn, nextUsernames, signUp } from "../src/rpc-client.js";

it.each([[undefined, undefined], ['true', 'false'], ['false', 'true']])("denies stored canvases unless both installation flags are enabled: %s/%s", async (composable, durable) => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: composable ?? 'false', DURABLE_VIEWS: durable ?? 'false' };
  } });
  try {
    using api = connect(harness.url);
    expect((await api.getServerConfig()).canvasFeatures).toEqual({ composableViews: composable === "true", durableViews: false, catalog: DEFAULT_CANVAS_CATALOG });
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
    expect((await api.getServerConfig()).canvasFeatures).toEqual({ composableViews: true, durableViews: true, catalog: DEFAULT_CANVAS_CATALOG });
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

// The release slice of #34: the one private Kanban view, whose board card is a live InferOps
// reference, keeps its definition through a restart, refuses stale edits and stays private.
const DEMO_BOARD = "inferops://demo.local/project/board/DEMO";
const boardCard = (showCompleted: boolean): CanvasWidget => ({
  id: "demo-board", version: 1, kind: "inferops.project-board", targetRef: DEMO_BOARD,
  params: { workflow: "software", showCompleted }, size: "wide",
});

/** The working set a fresh window onto `session` shows, from the first snapshot it delivers. */
async function currentPage(session: RpcStub<OperateSession>) {
  const first = Promise.withResolvers<OperateSessionUpdate>();
  using subscriber = callbackStubFor((update: OperateSessionUpdate) => { first.resolve(update); });
  using _subscription = await session.subscribe(subscriber);
  return (await first.promise).state;
}

it("keeps a private Kanban view with a live board reference through stale edits, other users and a Worker restart", async () => {
  const network = new NetworkInterceptor(); network.install();
  const harness = await startHarness({ gatekeepers: [], patchWorkshop(config) {
    config.vars = { ...config.vars, COMPOSABLE_VIEWS: 'true', DURABLE_VIEWS: 'true' };
  } });
  try {
    const [ownerName, otherName, useName] = nextUsernames("kanbanowner", "kanbanother", "kanbanuse");
    const saved = await (async () => {
      using api = connect(harness.url);
      using owner = await signUp(api, ownerName!);
      using other = await signUp(api, otherName!);
      using useCollaborator = await signUp(api, useName!);
      using workspace = await owner.newGadget("app");
      await workspace.newChat("Kanban view", null);
      const workspaceId = (await workspace.getMetadata()).id;
      const created = await workspace.createCanvas({ title: "Operations", sections: [
        { id: "boards", title: "Boards", columns: 1, widgets: [boardCard(false)] },
      ] });
      const edited = await workspace.editCanvas(created.id, created.revision,
          [{ type: "configureWidget", widget: boardCard(true) }]);
      expect(edited.revision).toBe("1");

      // An edit made against the snapshot it replaced is a conflict and changes nothing.
      await expect(workspace.editCanvas(created.id, created.revision, [{ type: "rename", title: "Stale" }]))
        .rejects.toThrow(/Canvas changed/);
      await expect(workspace.deleteCanvas(created.id, created.revision)).rejects.toThrow(/Canvas changed/);
      expect(await workspace.getCanvas(created.id)).toEqual(edited);

      // Two connections editing the same revision: exactly one wins, the other is a conflict.
      using secondApi = connect(harness.url);
      using secondLogin = await logIn(secondApi, ownerName!);
      using secondWindow = await secondLogin.openGadget(workspaceId);
      const race = await Promise.allSettled([
        workspace.editCanvas(created.id, edited.revision, [{ type: "rename", title: "Window A" }]),
        secondWindow.editCanvas(created.id, edited.revision, [{ type: "rename", title: "Window B" }]),
      ]);
      const won = race.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const lost = race.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(String(lost[0])).toMatch(/Canvas changed/);
      const view = won[0]!;
      expect(view).toMatchObject({ id: created.id, revision: "2" });
      expect(view.sections[0]?.widgets).toEqual([boardCard(true)]);
      expect(await secondWindow.getCanvas(created.id)).toEqual(view);

      // Another account cannot open the workspace, and its own workspaces do not hold the view.
      await expect(other.openGadget(workspaceId)).rejects.toThrow();
      using otherWorkspace = await other.newGadget("app");
      expect(await otherWorkspace.listCanvases()).toEqual([]);
      expect(await otherWorkspace.getCanvas(created.id)).toBeNull();
      await expect(otherWorkspace.editCanvas(created.id, view.revision, [{ type: "rename", title: "Taken" }]))
        .rejects.toThrow(/not found/);

      // A collaborator added for use can open the workspace but not read or edit its views.
      await workspace.addCollaborator(useName!, "use");
      using shared = await useCollaborator.openGadget(workspaceId);
      expect(await shared.getMetadata()).toMatchObject({ role: "use" });
      await expect(shared.listCanvases()).rejects.toThrow(/Unauthorized/);
      await expect(shared.getCanvas(created.id)).rejects.toThrow(/Unauthorized/);
      await expect(shared.editCanvas(created.id, view.revision, [{ type: "rename", title: "Denied" }]))
        .rejects.toThrow(/Unauthorized/);
      await expect(shared.deleteCanvas(created.id, view.revision)).rejects.toThrow(/Unauthorized/);
      expect(await workspace.getCanvas(created.id)).toEqual(view);

      // The owner's Operate session holds the view open across the restart below.
      using session = await owner.getOperateSession();
      const ref: OperateRef = { type: "screen", workspaceId, screenId: created.id };
      await session.dispatch({ type: "open", ref }, 0);
      return { workspaceId, view, ref };
    })();

    // Restart the Workshop Worker. Only an unread marker var changes, so the restart is certain
    // and the view flags stay on; a connection from before the restart no longer answers.
    using before = connect(harness.url);
    await before.getServerConfig();
    await harness.server.update(options => ({ ...options,
      workers: options.workers.map(worker => {
        if (!("config" in worker)) throw new Error("Expected inline harness config");
        return { ...worker, config: { ...worker.config, vars: { ...worker.config.vars, TEST_RESTART: "1" } } };
      }),
    }));
    await expect(before.getServerConfig()).rejects.toThrow();
    using api = connect((await harness.server.listen()).url);
    using owner = await logIn(api, ownerName!);
    using workspace = await owner.openGadget(saved.workspaceId);
    expect(await workspace.getCanvas(saved.view.id)).toEqual(saved.view);
    expect(await workspace.listCanvases()).toEqual([saved.view]);
    using session = await owner.getOperateSession();
    expect(await currentPage(session)).toMatchObject({ workingSet: [saved.ref], focus: saved.ref });
    // The session's reference resolves to the same definition and live board reference.
    using reopened = await owner.openGadget(saved.ref.workspaceId);
    expect((await reopened.getCanvas(saved.ref.screenId))?.sections[0]?.widgets[0]?.targetRef).toBe(DEMO_BOARD);
    // The restart neither loosened the use-role denial nor let a stale revision through.
    using useOwner = await logIn(api, useName!);
    using shared = await useOwner.openGadget(saved.workspaceId);
    await expect(shared.getCanvas(saved.view.id)).rejects.toThrow(/Unauthorized/);
    await expect(workspace.editCanvas(saved.view.id, "1", [{ type: "rename", title: "Stale" }]))
      .rejects.toThrow(/Canvas changed/);
    const next = await workspace.editCanvas(saved.view.id, saved.view.revision, [{ type: "rename", title: "Shift board" }]);
    expect(next).toMatchObject({ revision: "3", title: "Shift board", sections: saved.view.sections });
  } finally {
    await harness.server.close(); network.uninstall(); expect(network.getUnmockedCalls()).toEqual([]);
  }
});

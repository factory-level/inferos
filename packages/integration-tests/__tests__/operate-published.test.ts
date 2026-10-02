import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AuthenticatedApi, Overseer, PublicApi, WorkpieceId, WorkspaceKind,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { checkWorkspaceKind, workspaceKindStarter } from "@gadgets/workshop-shared/workspace-kind";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// What Build produces for Operate, used from somewhere other than where it was built. Things cross
// workspaces in two ways today, and each case below uses both where they apply: an install from a
// published blueprint (the operator's own independent copy), and a "use" share of the original.

type Counter = { add(n: number): Promise<number>; total(): Promise<number> };
type Widget = { summary(): Promise<{ title: string; value: string }> };
type Workflow = { run(input: unknown): Promise<{ input: unknown }>; lastRun(): Promise<{ input: unknown } | null> };

const COUNTER_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async add(n) {
    const total = ((await this.ctx.storage.get("total")) ?? 0) + n;
    await this.ctx.storage.put("total", total);
    return total;
  }
  async total() { return (await this.ctx.storage.get("total")) ?? 0; }
}
`;
const COUNTER_UI = `document.body.textContent = "Total: " + await gadget.total();\n`;

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
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

const user = async (prefix: string) => signUp(publicApi, nextUsernames(prefix)[0]!);

/** Builds a workspace of `kind` holding one gadget with `files`, merged to mainline. */
async function build(author: RpcStub<AuthenticatedApi>, kind: WorkspaceKind, files: Record<string, string>) {
  const workspace = await author.newGadget(kind);
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await workspace.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  const gadget = workspace.createGadget("Built", undefined, "BUILT");
  const gadgetId = await gadget.getId();
  const head = () => waitFor("the gadget's head", async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  const empty = await head();
  const chatId = await workspace.newChat("Build", null);
  const content = (entries: [string, string][]): CodeContent => new Map([[gadgetId, new Map(entries)]]);
  await workspace.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "build", seq: 1,
    pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(content([]), content(Object.entries(files))),
  });
  expect(await workspace.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  await waitFor("the merged head", async () => (await head()) !== empty || null);
  return { workspace, gadget, gadgetId, id: (await workspace.getMetadata()).id };
}

/** Publishes a built gadget as a blueprint and waits until it can be installed. */
async function publish(gadget: Awaited<ReturnType<typeof build>>["gadget"], title: string) {
  const blueprint = await gadget.createBlueprint(title, `${title} for Operate`);
  await waitFor("the published blueprint", () => publicApi.getBlueprint(blueprint.id));
  return blueprint.id;
}

/** Installs a blueprint as the operator's own workspace. */
async function install(operator: RpcStub<AuthenticatedApi>, blueprintId: string) {
  const workspace = await operator.newGadgetFromBlueprint(blueprintId, {});
  const metadata = await workspace.getMetadata();
  if (metadata.defaultGadgetId === undefined) throw new Error("The install has no gadget");
  return { workspace, metadata, gadgetId: metadata.defaultGadgetId as WorkpieceId };
}

const connectTo = async <T>(workspace: RpcStub<Overseer>, gadgetId: WorkpieceId) => {
  using gadget = await workspace.getGadget(gadgetId);
  return await gadget.connectToGadget() as unknown as RpcStub<T>;
};

describe("an application and its API", () => {
  it("installs as the operator's own copy, with its own state", async () => {
    using author = await user("appauthor");
    using operator = await user("appoperator");
    const built = await build(author, "app", { "server.js": COUNTER_SERVER, "client.js": COUNTER_UI });
    expect(checkWorkspaceKind("app", ["server.js", "client.js"])).toEqual([]);
    using authorApi = await connectTo<Counter>(built.workspace, built.gadgetId);
    expect(await authorApi.add(5)).toBe(5);

    const installed = await install(operator, await publish(built.gadget, "Counter"));
    using operatorApi = await connectTo<Counter>(installed.workspace, installed.gadgetId);
    expect(await operatorApi.total()).toBe(0);
    expect(await operatorApi.add(2)).toBe(2);
    expect(await authorApi.total()).toBe(5);

    using installedGadget = await installed.workspace.getGadget(installed.gadgetId);
    expect(await installedGadget.getUiBundle()).toEqual({ jsCode: COUNTER_UI });
  });

  it("is usable, but not changeable, by someone it is shared with for use", async () => {
    using author = await user("shareauthor");
    const viewerName = nextUsernames("shareviewer")[0]!;
    using viewer = await signUp(publicApi, viewerName);
    const built = await build(author, "app", { "server.js": COUNTER_SERVER, "client.js": COUNTER_UI });
    await built.workspace.addCollaborator(viewerName, "use");

    using shared = await viewer.openGadget(built.id);
    expect(await shared.getMetadata()).toMatchObject({ role: "use" });
    using sharedApi = await connectTo<Counter>(shared, built.gadgetId);
    // One shared instance: the viewer's calls land in the author's data.
    expect(await sharedApi.add(3)).toBe(3);
    using authorApi = await connectTo<Counter>(built.workspace, built.gadgetId);
    expect(await authorApi.total()).toBe(3);

    await expect(shared.setKind("widget")).rejects.toThrow();
    await expect(shared.newChat("Change it", null)).rejects.toThrow();
    await expect(shared.listCanvases()).rejects.toThrow();
  });
});

describe("a widget", () => {
  it("installs, runs, and is placed on a screen that a flow and the operate session use", async () => {
    using author = await user("widgetauthor");
    using operator = await user("widgetoperator");
    const built = await build(author, "widget", workspaceKindStarter("widget")!);
    expect((await built.workspace.getMetadata()).kind).toBe("widget");

    const { workspace, metadata, gadgetId } = await install(operator, await publish(built.gadget, "Status"));
    using widget = await connectTo<Widget>(workspace, gadgetId);
    expect(await widget.summary()).toEqual({ title: "Widget", value: "Nothing to show yet" });

    // Placed on a screen in the operator's workspace, by reference to the installed gadget.
    const screen = await workspace.createCanvas({
      title: "Shift board", sections: [{ id: "main", title: "Now", columns: 2, widgets: [] }],
    });
    const placed = await workspace.editCanvas(screen.id, screen.revision, [{
      type: "addWidget", sectionId: "main", index: 0,
      widget: { id: "status", version: 1, kind: "inferos.gadget", targetRef: `gadget:${gadgetId}`, params: {}, size: "normal" },
    }]);
    expect(placed.sections[0]?.widgets.map(placedWidget => placedWidget.targetRef)).toEqual([`gadget:${gadgetId}`]);

    // The screen is a step of a flow, and both open in the operator's one session.
    const flow = await workspace.createFlow({ title: "Handover", steps: [screen.id] });
    using session = await operator.getOperateSession();
    const opened = await session.dispatch(
        { type: "open", ref: { type: "screen", workspaceId: metadata.id, screenId: screen.id } }, 0);
    const running = await session.dispatch(
        { type: "startFlow", workspaceId: metadata.id, flowId: flow.id, title: flow.title, steps: flow.steps },
        opened.seq);
    expect(running.state.flow).toMatchObject({ flowId: flow.id, steps: [screen.id], index: 0 });
    expect(running.state.workingSet).toEqual([{ type: "screen", workspaceId: metadata.id, screenId: screen.id }]);

    // The author's workspace is not reachable through the install.
    await expect(operator.openGadget(built.id)).rejects.toThrow();
  });
});

describe("a workflow", () => {
  it("installs with no UI and runs its work on the operator's own state", async () => {
    using author = await user("flowauthor");
    using operator = await user("flowoperator");
    const starter = workspaceKindStarter("workflow")!;
    const built = await build(author, "workflow", starter);
    expect((await built.workspace.getMetadata()).kind).toBe("workflow");
    expect((await author.listGadgets()).find(listed => listed.id === built.id)?.kind).toBe("workflow");
    expect(checkWorkspaceKind("workflow", Object.keys(starter))).toEqual([]);

    const { workspace, gadgetId } = await install(operator, await publish(built.gadget, "Nightly"));
    using installedGadget = await workspace.getGadget(gadgetId);
    expect(await installedGadget.getUiBundle()).toBeNull();
    using workflow = await connectTo<Workflow>(workspace, gadgetId);
    expect(await workflow.lastRun()).toBeNull();
    expect((await workflow.run({ shift: "night" })).input).toEqual({ shift: "night" });
    expect((await workflow.lastRun())?.input).toEqual({ shift: "night" });

    using authorWorkflow = await connectTo<Workflow>(built.workspace, built.gadgetId);
    expect(await authorWorkflow.lastRun()).toBeNull();
  });
});

// A known gap, recorded so a fix shows up as a failing test: a blueprint does not carry its
// workspace's kind, so an installed widget or workflow is an app until its kind is switched.
it("an install does not yet carry the kind it was built as", async () => {
  using author = await user("kindauthor");
  using operator = await user("kindoperator");
  const built = await build(author, "widget", workspaceKindStarter("widget")!);
  const { metadata } = await install(operator, await publish(built.gadget, "Kindless"));
  expect(metadata.kind ?? "app").toBe("app");
});

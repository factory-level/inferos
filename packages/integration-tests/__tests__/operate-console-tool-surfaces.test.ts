import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, OperateSession, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// Callable widget surfaces at console publication (callable-widget contract C4), with
// CONSOLE_TOOLS set in this harness only: a tools-only widget (server.js and tools.json, no
// client.js) is registered and published, its published entry freezes `ui: false` and its tools,
// later edits to the source leave that snapshot alone, it can never be placed on a screen, and the
// use client refuses to render it or reach its shared server. No tool is discovered or invoked here.

const tool = (name: string) => ({
  name, description: `Reads ${name}.`, method: name, effect: "read",
  input: { type: "object", properties: {} },
  output: { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 0, maximum: 9 } } },
});
const toolsOnly = (...names: string[]): Record<string, string> => ({
  "server.js": `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
${names.map(name => `  async ${name}() { return { n: 1 }; }`).join("\n")}
}
`,
  "tools.json": JSON.stringify(names.map(tool)),
});

let harness: Harness;
let publicApi: RpcStub<PublicApi>;
let reader: RpcStub<AuthenticatedApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    enableGadgetExecution: true,
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CONSOLE_TOOLS: "true" };
    },
  });
  publicApi = connect(harness.url);
  reader = await signUp(publicApi, nextUsernames("surfacereader")[0]!);
});

afterAll(async () => {
  try {
    reader?.[Symbol.dispose]();
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
  return (gadgetId: WorkpieceId) => waitFor(`gadget ${gadgetId}'s head`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
}

/** Merges `next` over `previous` as gadget `gadgetId`'s files in `workspace`, through a chat. */
async function commit(workspace: RpcStub<Overseer>, head: (id: WorkpieceId) => Promise<string>,
    gadgetId: WorkpieceId, previous: Record<string, string>, next: Record<string, string>) {
  const content = (files: Record<string, string>): CodeContent => new Map([[gadgetId, new Map(Object.entries(files))]]);
  const base = await head(gadgetId);
  const chatId = await workspace.newChat("Edit", null);
  await workspace.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{ gadgetId, baseCommit: base }],
    change: diffFiles(content(previous), content(next)),
  });
  return await workspace.mergeChanges(chatId);
}

const gadgetWidget = (id: WorkpieceId) => ({
  id: `w${id}`, version: 1 as const, kind: "inferos.gadget" as const, targetRef: `gadget:${id}`, params: {}, size: "normal" as const,
});

const consoleOf = (screenId: string, widgets: ConsoleWidgetEntry[]): OperateConsoleContent => ({
  title: "Floor", views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off", widgets,
});

async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole) {
  await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title,
    source: "published", revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, 0);
}

describe("callable widget surfaces in a console", () => {
  it("freezes a tools-only widget's surfaces, keeps it off screens, and gives it no UI", async () => {
    // A tools-only widget, published as blueprint version 1.
    const author = await signUp(publicApi, nextUsernames("surfaceauthor")[0]!);
    const authoring = await author.newGadget("widget");
    const authorHead = await watch(authoring);
    const source = authoring.createGadget("Counts", undefined, "COUNTS");
    const sourceId = await source.getId();
    expect(await commit(authoring, authorHead, sourceId, {}, toolsOnly("openCount", "closedCount"))).toEqual({ outcome: "merged" });
    const blueprint = await source.createBlueprint("Counts", "Issue counts for the agent");
    await waitFor("the published blueprint", () => reader.getBlueprintInfo(blueprint.id));

    // An operations space shared for use with an operator, with the widget installed.
    const [builderName, operatorName] = nextUsernames("surfacebuilder", "surfaceoperator");
    const builder = await signUp(publicApi, builderName!);
    const operator = await signUp(publicApi, operatorName!);
    const space = await builder.newGadget("app");
    const spaceId = (await space.getMetadata()).id;
    expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
    const head = await watch(space);
    const installed = await space.installBlueprint(blueprint.id, {}, { version: 1, kind: "widget" });
    const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId: blueprint.id, version: 1, label: "Counts", state: "resettable" };

    // It cannot be placed on a screen: refused at save, and at publish once a screen gains it.
    const placed = await space.createCanvas({ title: "Placed", sections: [{ id: "main", title: "Now", columns: 1, widgets: [gadgetWidget(installed)] }] });
    await expect(space.createConsole(consoleOf(placed.id, [entry]))).rejects.toThrow(/has no UI/);
    const screen = await space.createCanvas({ title: "Shift", sections: [{ id: "main", title: "Now", columns: 1, widgets: [] }] });
    const created = await space.createConsole(consoleOf(screen.id, [entry]));
    const gained = await space.editCanvas(screen.id, screen.revision,
        [{ type: "addWidget", sectionId: "main", index: 0, widget: gadgetWidget(installed) }]);
    await expect(space.publishConsole(created.id, created.revision)).rejects.toThrow(/has no UI/);
    await space.editCanvas(screen.id, gained.revision, [{ type: "removeWidget", widgetId: `w${installed}` }]);

    // Publication freezes `ui: false` and the declared tools, from the commit it read.
    const commitId = await head(installed);
    const published = await space.publishConsole(created.id, created.revision);
    const frozen = published.published!.content.widgets![0]!;
    expect(frozen.frozen).toEqual({ sourceGadgetId: installed, commitId, ui: false,
      tools: [tool("openCount"), tool("closedCount")] });

    // A later edit to the registered install changes nothing published.
    expect(await commit(space, head, installed, toolsOnly("openCount", "closedCount"), toolsOnly("renamed")))
      .toEqual({ outcome: "merged" });
    await waitFor("the edited head", async () => await head(installed) !== commitId || null);
    expect((await space.getConsole(created.id, "published"))!.widgets![0]!.frozen).toEqual(frozen.frozen);

    // The operator reaches the frozen install through the console, but it has no UI to render
    // and its shared server is never reached.
    using used = await operator.openGadget(spaceId);
    using session = await operator.getOperateSession();
    await openConsole(session, spaceId, published);
    using handle = await used.getConsoleWidget(created.id, published.revision, frozen.gadgetId);
    expect(await handle.getTitle()).toBe("Counts");
    await expect(handle.getUiBundle()).rejects.toThrow(/has no UI/);
    await expect(handle.connectToGadget()).rejects.toThrow(/has no UI/);
    await expect(handle.getExportFormats()).rejects.toThrow(/has no UI/);
  });
});

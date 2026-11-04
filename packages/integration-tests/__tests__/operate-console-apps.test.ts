import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperateSession, Overseer, PublicApi, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

// A console's placed apps (FAC-89 part 2): an app on a published console's screen is the live gadget,
// with its own storage and bindings, fenced at the commit the console published. An operator opens
// it only through that console, only while its current commit is that one; once a builder changes
// it, the operator is refused in words saying a builder must publish the console again, and never
// runs the changed code. Republishing moves them to the new commit, with the app's data intact.

type Counter = { version(): Promise<string>; bump(): Promise<number>; tally(): Promise<RpcStub<{ bump(): Promise<number> }>> };

const appFiles = (version: string): Record<string, string> => ({
  "server.js": `import { DurableObject, RpcTarget } from "cloudflare:workers";
class Tally extends RpcTarget {
  constructor(gadget) { super(); this.gadget = gadget; }
  async bump() { return await this.gadget.bump(); }
}
export class Gadget extends DurableObject {
  async version() { return ${JSON.stringify(version)}; }
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
  tally() { return new Tally(this); }
}
`,
  "client.js": `document.body.textContent = ${JSON.stringify(version)};\n`,
});

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

/** An operations space owned by a builder, shared for use with an operator, watched for heads. */
async function operationsSpace(prefix: string) {
  const [builderName, operatorName] = nextUsernames(`${prefix}builder`, `${prefix}operator`);
  const builder = await signUp(publicApi, builderName!);
  const operator = await signUp(publicApi, operatorName!);
  const space = await builder.newGadget("app");
  const spaceId = (await space.getMetadata()).id;
  expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
  const workpieces = new WorkpieceRecorder();
  await space.subscribeToWorkpieces(stubFor(workpieces));
  await workpieces.loaded;
  const head = (gadgetId: WorkpieceId) => waitFor(`gadget ${gadgetId}'s head`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  return { builder, operator, space, spaceId, head };
}

/** Merges `next` over `previous` as gadget `gadgetId`'s files, through a chat: the app's mainline moves. */
async function commit(s: Awaited<ReturnType<typeof operationsSpace>>, gadgetId: WorkpieceId,
    previous: Record<string, string>, next: Record<string, string>) {
  const content = (files: Record<string, string>): CodeContent => new Map([[gadgetId, new Map(Object.entries(files))]]);
  const base = await s.head(gadgetId);
  const chatId = await s.space.newChat("Edit", null);
  await s.space.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{ gadgetId, baseCommit: base }],
    change: diffFiles(content(previous), content(next)),
  });
  expect(await s.space.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return waitFor("the new head", async () => (await s.head(gadgetId)) !== base ? s.head(gadgetId) : null);
}

const screenWith = (space: RpcStub<Overseer>, gadgetIds: WorkpieceId[]) => space.createCanvas({
  title: "Shift",
  sections: [{ id: "main", title: "Now", columns: 1, widgets: gadgetIds.map(id => ({
    id: `w${id}`, version: 1 as const, kind: "inferos.gadget" as const, targetRef: `gadget:${id}`, params: {}, size: "normal" as const,
  })) }],
});

const consoleOf = (screenId: string): OperateConsoleContent => ({
  title: "Floor", views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off",
});

async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole, seq: number) {
  const page = await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title,
    source: "published", revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, seq);
  return page.seq;
}

const CHANGED = /App Board has changed since console Floor was published; a builder must publish the console again before operators can open it\./;

describe("a console's placed apps", () => {
  it("runs only the published commit of the live app, through that console, until it is published again", async () => {
    const s = await operationsSpace("apps");
    const gadget = s.space.createGadget("Board", undefined, "BOARD");
    const app = await gadget.getId();
    await commit(s, app, {}, appFiles("v1"));
    const v1 = await s.head(app);
    const screen = await screenWith(s.space, [app]);
    const created = await s.space.createConsole(consoleOf(screen.id));
    const published = await s.space.publishConsole(created.id, created.revision);
    // The publication fences the live app at the commit it read: no copy is made.
    expect(published.published?.apps).toEqual([{ gadgetId: app, commitId: v1 }]);
    expect(published.published?.content.widgets).toBeUndefined();

    using used = await s.operator.openGadget(s.spaceId);
    using session = await s.operator.getOperateSession();
    // Placed on a published console, the app is no longer the operator's to open directly.
    await expect(used.getGadget(app)).rejects.toThrow(/an app a published console places; open it through that console/);
    await expect(used.getConsoleApp(created.id, published.revision, app)).rejects.toThrow(/not open/);
    let seq = await openConsole(session, s.spaceId, published, 0);
    await expect(used.getConsoleApp(created.id, "0", app)).rejects.toThrow(/changed since it was opened/);
    using handle = await used.getConsoleApp(created.id, published.revision, app);
    expect(await handle.getUiBundle()).toEqual({ jsCode: appFiles("v1")["client.js"] });
    const server = await handle.connectToGadget() as unknown as RpcStub<Counter>;
    const tally = await server.tally();
    expect(await server.version()).toBe("v1");
    expect(await server.bump()).toBe(1);
    expect(await tally.bump()).toBe(2);

    // A builder changes the app: its mainline moves. The operator never gets the new code: every
    // capability they hold is refused in words saying what to do, and so is opening it again.
    await commit(s, app, appFiles("v1"), appFiles("v2"));
    await expect(handle.getUiBundle()).rejects.toThrow(CHANGED);
    await expect(handle.getTitle()).rejects.toThrow(CHANGED);
    await expect(server.version()).rejects.toThrow(CHANGED);
    await expect(tally.bump()).rejects.toThrow(CHANGED);
    await expect(used.getConsoleApp(created.id, published.revision, app)).rejects.toThrow(CHANGED);
    await expect(used.getGadget(app)).rejects.toThrow(/open it through that console/);
    // The builder still opens what they built, from Build and from the published console.
    {
      using built = await s.space.getConsoleApp(created.id, published.revision, app);
      expect(await built.getUiBundle()).toEqual({ jsCode: appFiles("v2")["client.js"] });
    }

    // Republishing moves the fence to the new commit, keeps the app's own data, and the old
    // revision's capabilities stay refused.
    const republished = await s.space.publishConsole(created.id, published.revision);
    const v2 = await s.head(app);
    expect(republished.published?.apps).toEqual([{ gadgetId: app, commitId: v2 }]);
    seq = await openConsole(session, s.spaceId, republished, seq);
    await expect(handle.getUiBundle()).rejects.toThrow(/changed since it was opened/);
    await expect(server.bump()).rejects.toThrow(/changed since it was opened/);
    for (const kept of [tally, server]) kept[Symbol.dispose]();
    using current = await used.getConsoleApp(created.id, republished.revision, app);
    expect(await current.getUiBundle()).toEqual({ jsCode: appFiles("v2")["client.js"] });
    {
      using api = await current.connectToGadget() as unknown as RpcStub<Counter>;
      expect(await api.version()).toBe("v2");
      // The same gadget's storage: the count carries on rather than starting again.
      expect(await api.bump()).toBe(3);
    }

    // Another console doesn't acquire the app, and the operator can't publish to move the fence.
    const other = await s.space.createConsole(consoleOf((await screenWith(s.space, [])).id));
    const otherPublished = await s.space.publishConsole(other.id, other.revision);
    await expect(used.getConsoleApp(other.id, otherPublished.revision, app)).rejects.toThrow(/does not offer app/);
    await expect(used.publishConsole(created.id, republished.revision)).rejects.toThrow(/Unauthorized/);

    // Deleting the only console that placed it gives the app back to plain sharing for use.
    await s.space.deleteConsole(created.id, republished.revision);
    using shared = await used.getGadget(app);
    expect(await shared.getUiBundle()).toEqual({ jsCode: appFiles("v2")["client.js"] });
  });

  it("leaves an app no published console places open as before, even while a draft places it", async () => {
    const s = await operationsSpace("appsdraft");
    const gadget = s.space.createGadget("Notes", undefined, "NOTES");
    const app = await gadget.getId();
    await commit(s, app, {}, appFiles("v1"));
    const screen = await screenWith(s.space, [app]);
    await s.space.createConsole(consoleOf(screen.id));

    using used = await s.operator.openGadget(s.spaceId);
    using handle = await used.getGadget(app);
    expect(await handle.getUiBundle()).toEqual({ jsCode: appFiles("v1")["client.js"] });
  });

  it("refuses a capability opened before the app was placed, once a console publishing it is published", async () => {
    const s = await operationsSpace("appsearly");
    const gadget = s.space.createGadget("Board", undefined, "BOARD");
    const app = await gadget.getId();
    await commit(s, app, {}, appFiles("v1"));

    // Opened while the app is only shared for use: no console places it yet.
    using used = await s.operator.openGadget(s.spaceId);
    using early = await used.getGadget(app);
    const server = await early.connectToGadget() as unknown as RpcStub<Counter>;
    const tally = await server.tally();
    expect(await server.bump()).toBe(1);

    const screen = await screenWith(s.space, [app]);
    const created = await s.space.createConsole(consoleOf(screen.id));
    await s.space.publishConsole(created.id, created.revision);

    // From then on the console is the only way in: nothing kept from before reaches the mainline.
    const THROUGH_CONSOLE = /an app a published console places; open it through that console/;
    await expect(early.getUiBundle()).rejects.toThrow(THROUGH_CONSOLE);
    await expect(early.getTitle()).rejects.toThrow(THROUGH_CONSOLE);
    await expect(server.bump()).rejects.toThrow(THROUGH_CONSOLE);
    await expect(tally.bump()).rejects.toThrow(THROUGH_CONSOLE);
    for (const kept of [tally, server]) kept[Symbol.dispose]();
  });
});

// Console bound views (MVP-26, bound-view contract PR 2c): registration, coherent publication and
// survival, over mock Durable Object storage with synthetic gadget records and commits; delivery
// (PR 2d) through `describeBoundView`'s ports. The real-commit suites run the commit reads in an
// OverseerDurableObject. Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { writeBlob, writeTree, type TreeEntry } from "isomorphic-git";
import { parseBoundViewSpec } from "@gadgets/workshop-shared/bound-view";
import type { BoundViewEntry, ConsoleWidgetEntry, HostBoardEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { parseWidgetTools } from "@gadgets/workshop-shared/widget-tools";
import { classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import type { BoundViewFreeze, ConsoleRef } from "@gadgets/workshop-shared/operate-console";
import { BOUND_VIEWS_OFF, CONSOLE_SIZE_LIMITS, describeBoundView, WorkspaceConsoleStore, type BoundViewPorts, type FrozenInstalls, type SourceCommits } from "../src/console-store";
import { BlobTextError, GITDIR, makeGitObjectsFs, type GitStore } from "../src/git-store";
import { makeOverseerStorage, type GadgetRecord, type OverseerDurableObject } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ON = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", INFEROPS_HOST_BOARDS: "true", INFEROPS_BOUND_VIEWS: "true" };
const OFF = { ...ON, INFEROPS_BOUND_VIEWS: "false" };
const NO_BOARDS = { ...ON, INFEROPS_HOST_BOARDS: "false" };

const spec = (names: string[], title = "Open") => JSON.stringify({ version: 1, title, requirements: names,
  root: { type: "count", label: "Open", of: { requirement: names[0], collection: "issues" } } });

// An exactly 8 KiB spec of worst-case escaping: every authored character and the padding escape to
// two bytes when the spec is embedded in a JSON string.
function maxSpec(): string {
  let children = Array.from({ length: 12 }, () => ({ type: "text", text: '"'.repeat(200) }));
  let text = JSON.stringify({ version: 1, title: '"'.repeat(200), requirements: ["board"], root: { type: "stack", children } });
  return text + "\n".repeat(8192 - new TextEncoder().encode(text).length);
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const COMMITS: Record<string, Record<string, string>> = {
  view: { "view.json": spec(["board"]) },
  viewEdited: { "view.json": spec(["board"], "Edited") },
  twoBoards: { "view.json": spec(["board", "ops"]) },
  max: { "view.json": maxSpec() },
  widget: { "client.js": "", "server.js": "" },
  mixed: { "view.json": spec(["board"]), "client.js": "" },
  invalid: { "view.json": "{}" },
};

/** `SourceCommits` for the named fixtures, classified as the kernel classifies them. */
function commitsOf(...ids: string[]): SourceCommits {
  return new Map(ids.map(id => {
    let files = new Map<string, string | null>(Object.entries(COMMITS[id]!));
    let classification = classifyGadgetFiles("widget", files);
    return [id, { classification, viewText: classification.class === "viewOnly" ? files.get("view.json")! : null, tools: null }];
  }));
}
const ALL = commitsOf(...Object.keys(COMMITS));

const board = (name = "board"): HostBoardEntry => ({ kind: "host-board", label: name,
  requirement: { name, resource: "inferops-board", target: "inferops://acme.operations/project/board/ENG" } });
const view = (gadgetId = 10, requirements = ["board"]): BoundViewEntry =>
  ({ kind: "bound-view", gadgetId, blueprintId: "bp", version: 1, label: `View ${gadgetId}`, requirements });

function setup() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [] } as never);
  let gadget = (id: number, commitId: string, extra: Partial<GadgetRecord> = {}) => storage.gadgets.put({
    type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: {}, commitId,
    installedFrom: { blueprintId: "bp", version: 1, kind: "widget" }, ...extra } as GadgetRecord);
  let nextId = 1000;
  let frozen: FrozenInstalls = {
    create: (source, frozenFor) => {
      let record = { ...source, id: nextId++, bindingName: `F${nextId}`, frozenFor };
      storage.gadgets.put(record);
      return record;
    },
    remove: id => storage.gadgets.delete(id),
  };
  let store = (environment: typeof ON = ON) => new WorkspaceConsoleStore(durable, storage, environment, frozen);
  let views = [{ id: "floor", title: "Floor", type: "screen" as const, screen: "floor" }];
  let content = (extra: Partial<OperateConsoleContent>): OperateConsoleContent =>
    ({ title: "Floor", fullChat: "off", views, hostBoards: [board()], ...extra });
  // What the overseer does: capture, read the captured commits, publish.
  let publish = (stored: OperateConsole, environment: typeof ON = ON, commits: SourceCommits = ALL) => {
    let capture = store(environment).capture(stored.id, stored.revision);
    return store(environment).publish(stored.id, stored.revision, capture, commits);
  };
  gadget(10, "view");
  return { storage, gadget, store, content, publish };
}

describe("saving a console's bound views", () => {
  it("mints an id, drops a client's frozen spec, and keeps the entries when an editor omits them", () => {
    let t = setup();
    let forged = { ...view(), frozen: { sourceGadgetId: 10, commitId: "x", specText: "{}" } };
    let saved = t.store().create(t.content({ boundViews: [forged] }), ALL);
    expect(saved.boundViews).toEqual([{ ...view(), id: expect.any(String) }]);
    let edited = t.store().replace(saved.id, saved.revision, { title: "Renamed", fullChat: "off", views: saved.views }, ALL);
    expect(edited.boundViews).toEqual(saved.boundViews);
  });

  it("refuses missing, duplicate or inexact requirement names, and names that are not a host board here", () => {
    let t = setup();
    let save = (entry: BoundViewEntry, hostBoards = [board()]) => () => t.store().create(t.content({ hostBoards, boundViews: [entry] }), ALL);
    expect(save(view(10, []))).toThrow(/reads 1-4/);
    expect(save(view(10, ["board", "board"]))).toThrow(/twice/);
    expect(save(view(10, ["Board"]))).toThrow(/Board is not the name of one of this console's host boards/);
    expect(save(view(10, ["board"]), [])).toThrow(/not the name of one/);
    // An explicit host-board list that drops a board a saved view reads is refused too.
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    expect(() => t.store().replace(saved.id, saved.revision, t.content({ hostBoards: [board("other")] }), ALL))
      .toThrow(/board is not the name of one/);
    // The spec's names must equal the entry's as a set.
    t.gadget(11, "twoBoards");
    expect(save(view(11, ["board"]), [board(), board("ops")])).toThrow(/reads board, ops, not board/);
    expect(t.store().create(t.content({ hostBoards: [board(), board("ops")], boundViews: [view(11, ["ops", "board"])] }), ALL).boundViews)
      .toHaveLength(1);
  });

  it("refuses a forged id, or an id moved to another gadget", () => {
    let t = setup();
    t.gadget(11, "view");
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let id = saved.boundViews![0]!.id!;
    let replace = (entry: BoundViewEntry) => () => t.store().replace(saved.id, saved.revision, t.content({ boundViews: [entry] }), ALL);
    expect(replace({ ...view(), id: "forged" })).toThrow(/not this console's/);
    expect(replace({ ...view(11), id })).toThrow(/not this console's/);
    expect(t.store().replace(saved.id, saved.revision, t.content({ boundViews: [{ ...view(), id, label: "Renamed" }] }), ALL)
      .boundViews![0]).toMatchObject({ id, label: "Renamed" });
  });

  it("refuses a source that is not a view-only widget install at the entry's provenance", () => {
    let t = setup();
    let refused = (record: Partial<GadgetRecord>, commitId = "view", entry: Partial<BoundViewEntry> = {}) => {
      t.gadget(20, commitId, record);
      return () => t.store().create(t.content({ boundViews: [{ ...view(20), ...entry }] }), ALL);
    };
    expect(refused({}, "view", { version: 2 })).toThrow(/runs blueprint bp version 1, not bp version 2/);
    expect(refused({}, "view", { blueprintId: "other" })).toThrow(/not other version 1/);
    expect(refused({ installedFrom: { blueprintId: "bp", version: 1, kind: "app" } })).toThrow(/app install, not a widget/);
    expect(refused({ installedFrom: undefined })).toThrow(/not a blueprint install/);
    expect(refused({ installedFrom: { blueprintId: "bp", version: 1, kind: "widget", dataContract: 1 } })).toThrow(/data contract/);
    expect(refused({ bindings: { DB: {} as never } })).toThrow(/has bindings/);
    expect(refused({ pending: { chatId: 1 } })).toThrow(/not a gadget of this workspace/);
    expect(refused({ frozenFor: { consoleId: "c", revision: "1", sourceGadgetId: 10 } })).toThrow(/frozen install/);
    expect(refused({}, "widget")).toThrow(/not a view-only widget/);
    expect(refused({}, "mixed")).toThrow(/not a view-only widget.*also has client\.js/);
    expect(refused({}, "invalid")).toThrow(/not a view-only widget.*not a valid view/);
    expect(() => t.store().create(t.content({ boundViews: [view(99)] }), ALL)).toThrow(/not a gadget of this workspace/);
  });

  it("refuses a source whose commit moved after it was read", () => {
    let t = setup();
    expect(() => t.store().create(t.content({ boundViews: [view()] }), commitsOf("widget"))).toThrow(/changed while it was being saved or published; try again/);
  });

  it("refuses bound views saved without the commits they are checked against, as no retry fixes it", () => {
    let t = setup();
    expect(() => t.store().create(t.content({ boundViews: [view()] }))).toThrow(/^This console's bound views cannot be saved here\.$/);
  });

  it("refuses a new entry while the switch is off, or host boards are, keeping saved entries editable", () => {
    let t = setup();
    expect(() => t.store(OFF).create(t.content({ boundViews: [view()] }), ALL)).toThrow(/Bound views are turned off/);
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let id = saved.boundViews![0]!.id!;
    expect(() => t.store({ ...NO_BOARDS }).replace(saved.id, saved.revision,
      t.content({ boundViews: [{ ...view(), id }, view()] }), ALL)).toThrow(/turned off/);
    let edited = t.store(OFF).replace(saved.id, saved.revision, t.content({ boundViews: [{ ...view(), id, label: "Kept" }] }), ALL);
    expect(edited.boundViews![0]!.label).toBe("Kept");
    expect(() => t.store(OFF).replace(edited.id, edited.revision, t.content({ boundViews: [{ ...view(), id }, view()] }), ALL))
      .toThrow(/Bound views are turned off/);
  });

  it("bounds a saved entry's blueprint id at 128 characters and the registry at 16 entries with widgets and host boards", () => {
    let t = setup();
    let [limit, over] = ["b".repeat(128), "b".repeat(129)];
    t.gadget(11, "view", { installedFrom: { blueprintId: limit, version: 1, kind: "widget" } });
    t.gadget(12, "view", { installedFrom: { blueprintId: over, version: 1, kind: "widget" } });
    let atLimit = t.store().create(t.content({ boundViews: [{ ...view(11), blueprintId: limit }] }), ALL);
    expect(bytes(atLimit.boundViews![0])).toBeLessThanOrEqual(CONSOLE_SIZE_LIMITS.entry);
    expect(() => t.store().create(t.content({ boundViews: [{ ...view(12), blueprintId: over }] }), ALL)).toThrow(/blueprint id of 1-128 characters/);
    let fifteen = Array.from({ length: 15 }, () => view());
    expect(t.store().create(t.content({ boundViews: fifteen }), ALL).boundViews).toHaveLength(15);
    expect(() => t.store().create(t.content({ boundViews: [...fifteen, view()] }), ALL)).toThrow(/at most 16 widgets, host boards and bound views/);
    t.gadget(30, "widget");
    let widget: ConsoleWidgetEntry = { gadgetId: 30, blueprintId: "bp", version: 1, label: "W", state: "resettable" };
    expect(() => t.store().create(t.content({ widgets: [widget], boundViews: fifteen }), ALL)).toThrow(/at most 16/);
  });
});

describe("the widget registry and views", () => {
  it("refuses a view-only install as a widget, given its commit, and offers it as a bound view", () => {
    let t = setup();
    let entry: ConsoleWidgetEntry = { gadgetId: 10, blueprintId: "bp", version: 1, label: "V", state: "resettable" };
    expect(() => t.store().create(t.content({ widgets: [entry] }), ALL)).toThrow(/view with no code; offer it as a bound view/);
    t.gadget(30, "widget");
    expect(t.store().create(t.content({ widgets: [{ ...entry, gadgetId: 30 }] }), ALL).widgets).toHaveLength(1);
    // A widget whose commit became view-only after it was saved is refused at publication.
    let saved = t.store().create(t.content({ widgets: [{ ...entry, gadgetId: 30 }] }), ALL);
    t.gadget(30, "view");
    expect(() => t.publish(saved)).toThrow(/view with no code/);
  });
});

describe("publishing a console's bound views", () => {
  it("freezes the source commit's spec and creates no install", () => {
    let t = setup();
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let gadgets = Array.from(t.storage.gadgets.list()).length;
    let published = t.publish(saved);
    expect(published.published!.content.boundViews).toEqual([{ ...saved.boundViews![0], frozen:
      { sourceGadgetId: 10, commitId: "view", specText: COMMITS.view!["view.json"] } }]);
    expect(published.boundViews).toEqual(saved.boundViews);
    expect(Array.from(t.storage.gadgets.list())).toHaveLength(gadgets);
    // Only a captured publication publishes bound views.
    let again = t.store().replace(published.id, published.revision, t.content({}), ALL);
    expect(() => t.store().publish(again.id, again.revision)).toThrow(/bound views cannot be published here/);
  });

  // Each race changes the console or a source between the capture and the transaction.
  const races: [string, (t: ReturnType<typeof setup>, stored: OperateConsole) => void, RegExp][] = [
    ["the source moves to a commit that also has client.js", t => t.gadget(10, "mixed"), /changed while it was being saved or published; try again/],
    ["the source moves to an edited view", t => t.gadget(10, "viewEdited"), /changed while it was being saved or published; try again/],
    ["the source's provenance changes", t => t.gadget(10, "view", { installedFrom: { blueprintId: "bp", version: 2, kind: "widget" } }),
      /changed while it was being saved or published; try again/],
    ["the source is deleted", t => t.storage.gadgets.delete(10), /changed while it was being saved or published; try again/],
    ["the source gains a binding", t => t.gadget(10, "view", { bindings: { DB: {} as never } }), /has bindings/],
    ["an entry is added at the same revision", (t, stored) => t.storage.consoles.put({ ...stored, boundViews: [...stored.boundViews!, { ...view(), id: "x" }] }),
      /changed while it was being saved or published; try again/],
    ["the requirement mapping changes at the same revision", (t, stored) =>
      t.storage.consoles.put({ ...stored, hostBoards: [{ ...stored.hostBoards![0]!, id: "other" }] }), /changed while it was being saved or published; try again/],
  ];
  for (let [name, race, refusal] of races) {
    it(`refuses when ${name}, leaving the live publication`, () => {
      let t = setup();
      let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
      let live = t.publish(saved);
      let capture = t.store().capture(live.id, live.revision);
      race(t, live);
      expect(() => t.store().publish(live.id, live.revision, capture, ALL)).toThrow(refusal);
      expect(t.storage.consoles.get(live.id)!.published).toEqual(live.published);
    });
  }

  it("refuses a captured commit that already has client.js", () => {
    let t = setup();
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    t.gadget(10, "mixed");
    expect(() => t.publish(saved)).toThrow(/not a view-only widget.*also has client\.js/);
  });

  it("keeps a published view through a source edit and deletion, and refuses republishing a deleted source", () => {
    let t = setup();
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let live = t.publish(saved);
    let shown = t.store().get(live.id, "published");
    t.gadget(10, "viewEdited");
    expect(t.store().get(live.id, "published")).toEqual(shown);
    t.storage.gadgets.delete(10);
    expect(t.store().get(live.id, "published")).toEqual(shown);
    expect(() => t.publish(live)).toThrow(/not a gadget of this workspace/);
    expect(t.store().get(live.id, "published")).toEqual(shown);
    // A republish re-captures: an edited source publishes its new spec.
    t.gadget(10, "viewEdited");
    let republished = t.publish(live);
    expect(republished.published!.content.boundViews![0]!.frozen).toEqual(
      { sourceGadgetId: 10, commitId: "viewEdited", specText: COMMITS.viewEdited!["view.json"] });
  });

  it("republishes already-published entries while the switch is off, and refuses any other", () => {
    let t = setup();
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let live = t.publish(saved);
    let republished = t.publish(live, OFF);
    expect(republished.published!.content.boundViews).toHaveLength(1);
    let added = t.store().replace(republished.id, republished.revision,
      t.content({ boundViews: [...republished.boundViews!, view()] }), ALL);
    expect(() => t.publish(added, OFF)).toThrow(/Bound views are turned off/);
    expect(() => t.publish(added, NO_BOARDS)).toThrow(/turned off/);
    expect(t.publish(added).published!.content.boundViews).toHaveLength(2);
  });

  it("publishes 15 maximum-size views over one board within the entry and console bounds", () => {
    let t = setup();
    t.gadget(10, "max");
    expect(parseBoundViewSpec(COMMITS.max!["view.json"]!)).toMatchObject({ ok: true });
    expect(new TextEncoder().encode(COMMITS.max!["view.json"]).length).toBe(8192);
    let saved = t.store().create(t.content({ boundViews: Array.from({ length: 15 }, () => ({ ...view(), label: "L".repeat(120) })) }), ALL);
    let published = t.publish(saved);
    for (let entry of published.published!.content.boundViews!) {
      expect(entry.frozen!.specText).toBe(COMMITS.max!["view.json"]);
      expect(bytes(entry)).toBeGreaterThan(16 * 1024);
      expect(bytes(entry)).toBeLessThanOrEqual(CONSOLE_SIZE_LIMITS.frozenBoundViewEntry);
      expect(parseBoundViewSpec(entry.frozen!.specText)).toEqual(parseBoundViewSpec(COMMITS.max!["view.json"]!));
    }
    expect(bytes(t.storage.consoles.get(published.id))).toBeLessThanOrEqual(CONSOLE_SIZE_LIMITS.console);
  });

  // Legal content cannot reach the cap (see console-tool-surfaces.test.ts), so the stored draft is
  // given a title no parse would accept.
  it("refuses a console row over 704 KiB", () => {
    let t = setup();
    t.gadget(30, "widget");
    let created = t.store().create(t.content({ widgets: [{ gadgetId: 30, blueprintId: "bp", version: 1, label: "W", state: "resettable" }] }), ALL);
    let saved = { ...created, title: "t".repeat(CONSOLE_SIZE_LIMITS.console) };
    t.storage.consoles.put(saved);
    expect(() => t.publish(saved)).toThrow(/over 720896 bytes published/);
    expect(t.storage.consoles.get(saved.id)!.published).toBeNull();
  });
});

// The overseer's own reads (`readSourceCommits`) of real commits, with a Build merge landing while
// they run: what `OverseerClientInterface.publishConsole` does, step by step.
describe("publication against real commits", () => {
  type Impl = {
    storage: ReturnType<typeof makeOverseerStorage>;
    gitStore: GitStore;
    createGadget(title: string, bindingName: string, chatId?: number, output?: undefined, commitId?: string): GadgetRecord;
    frozenInstalls(): FrozenInstalls;
    readSourceCommits(commitIds: Iterable<string>): Promise<SourceCommits>;
  };
  const inOverseer = <T>(name: string, fn: (impl: Impl, state: DurableObjectState) => Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.getByName(name), (instance: OverseerDurableObject, state: DurableObjectState) =>
      fn((instance as unknown as { impl: Impl }).impl, state));

  async function prepare(impl: Impl, state: DurableObjectState) {
    let write = (files: Record<string, string>) => impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)),
      { message: "test", author: { name: "t", email: "t@example.com" }, timestamp: new Date(0), parents: [] });
    let viewCommit = await write(COMMITS.view!);
    let codeCommit = await write(COMMITS.mixed!);
    let record = impl.createGadget("View", "VIEW", undefined, undefined, viewCommit);
    record.installedFrom = { blueprintId: "bp", version: 1, kind: "widget" };
    impl.storage.gadgets.put(record);
    impl.storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [] } as never);
    let store = new WorkspaceConsoleStore(state.storage, impl.storage, ON, impl.frozenInstalls());
    let content: OperateConsoleContent = { title: "Floor", fullChat: "off", views: [{ id: "floor", title: "Floor", type: "screen", screen: "floor" }],
      hostBoards: [board()], boundViews: [{ ...view(record.id) }] };
    let saved = store.create(content, await impl.readSourceCommits(store.sourceCommitIds(content)));
    return { store, saved, record, viewCommit, codeCommit };
  }

  it("refuses when the source gains client.js while its commit is read", async () => {
    await inOverseer("bound-view-race", async (impl, state) => {
      let { store, saved, record, codeCommit } = await prepare(impl, state);
      let capture = store.capture(saved.id, saved.revision);
      let read = impl.gitStore.readCommitPaths.bind(impl.gitStore);
      impl.gitStore.readCommitPaths = async oid => {
        impl.storage.gadgets.put({ ...impl.storage.gadgets.get(record.id) as GadgetRecord, commitId: codeCommit });
        return read(oid);
      };
      let commits = await impl.readSourceCommits(capture.commitIds);
      impl.gitStore.readCommitPaths = read;
      expect(() => store.publish(saved.id, saved.revision, capture, commits)).toThrow(/changed while it was being saved or published; try again/);
      expect(store.get(saved.id, "draft")!.published).toBeNull();
    });
  });

  it("publishes the captured commit's bytes when nothing moved", async () => {
    await inOverseer("bound-view-publish", async (impl, state) => {
      let { store, saved, record, viewCommit } = await prepare(impl, state);
      let capture = store.capture(saved.id, saved.revision);
      let published = store.publish(saved.id, saved.revision, capture, await impl.readSourceCommits(capture.commitIds));
      expect(published.published!.content.boundViews![0]!.frozen).toEqual(
        { sourceGadgetId: record.id, commitId: viewCommit, specText: COMMITS.view!["view.json"] });
    });
  });

  // A commit of raw bytes, with at most one directory level, written into the overseer's own
  // object store. Returns the commit and each file's blob oid.
  async function commitBytes(impl: Impl, files: Record<string, string | Uint8Array>) {
    let fs = makeGitObjectsFs(impl.storage.gitObjects);
    let blobs = new Map<string, string>();
    let root: TreeEntry[] = [];
    let dirs = new Map<string, TreeEntry[]>();
    for (let [path, content] of Object.entries(files)) {
      let blob = typeof content === "string" ? new TextEncoder().encode(content) : content;
      let oid = await writeBlob({ fs, gitdir: GITDIR, blob });
      blobs.set(path, oid);
      let [dir, name] = path.includes("/") ? path.split("/") : [undefined, path];
      let entry: TreeEntry = { mode: "100644", path: name!, oid, type: "blob" };
      if (dir === undefined) root.push(entry);
      else dirs.set(dir, [...dirs.get(dir) ?? [], entry]);
    }
    for (let [dir, tree] of dirs) {
      root.push({ mode: "040000", path: dir, oid: await writeTree({ fs, gitdir: GITDIR, tree }), type: "tree" });
    }
    let commit = await impl.gitStore.writeCommitForTree(await writeTree({ fs, gitdir: GITDIR, tree: root }),
      { message: "test", author: { name: "t", email: "t@example.com" }, timestamp: new Date(0), parents: [] });
    return { commit, blobs };
  }

  const NOT_UTF8 = new Uint8Array([0x2f, 0x2f, 0xff, 0xfe, 0x0a]);
  const TOOLS = JSON.stringify([{ name: "version", description: "The widget's version.", method: "version", effect: "read",
    input: { type: "object", properties: {} }, output: { type: "string", maxLength: 16 } }]);

  it("reads only a commit's paths, plus its view.json and tools.json, in one pass that keeps both", async () => {
    await inOverseer("bound-view-paths", async impl => {
      // A widget's code is neither read nor decoded: one file is not UTF-8, another's blob is gone.
      let { commit, blobs } = await commitBytes(impl, { "client.js": NOT_UTF8, "server.js": "", "lib/util.js": "x" });
      impl.storage.gitObjects.delete(blobs.get("lib/util.js")!);
      let mixed = await commitBytes(impl, { "view.json": spec(["board"]), "client.js": NOT_UTF8 });
      let callable = await commitBytes(impl, { "server.js": NOT_UTF8, "tools.json": TOOLS });
      let read: string[] = [];
      let readBlob = impl.gitStore.readCommitBlob.bind(impl.gitStore) as (oid: string, path: string, as: "text") => Promise<string | null>;
      impl.gitStore.readCommitBlob = (async (oid: string, path: string, as: "text") => {
        read.push(path);
        return readBlob(oid, path, as);
      }) as GitStore["readCommitBlob"];
      impl.gitStore.readCommitFiles = () => { throw new Error("readCommitFiles decodes every file"); };
      let commits = await impl.readSourceCommits([commit, mixed.commit, callable.commit]);
      expect(commits.get(commit)).toEqual({ classification: { class: "visualWidget", violations: [] }, viewText: null, tools: null });
      expect(commits.get(mixed.commit)!.classification.violations.map(violation => violation.code)).toEqual(["mixedView"]);
      // The callable widget's tools come from the same read that classified it (C4's surfaces).
      expect(commits.get(callable.commit)).toEqual({ classification: { class: "callableTools", violations: [] },
        viewText: null, tools: parseWidgetTools(TOOLS) });
      expect(read).toEqual(["view.json", "tools.json"]);
    });
  });

  it("classifies exactly as the full file map with strict view.json and tools.json did", async () => {
    await inOverseer("bound-view-classes", async impl => {
      const cases: Record<string, string | Uint8Array>[] = [
        ...Object.values(COMMITS),
        { "view.json": NOT_UTF8 },
        { "view.json": new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(spec(["board"]))]) },
        { "view.json": spec(["board"]), "tools.json": TOOLS },
        { "view.json": spec(["board"]), "lib/a.js": NOT_UTF8 },
        { "server.js": "", "tools.json": TOOLS },
        { "client.js": "", "server.js": "", "tools.json": TOOLS },
        { "client.js": "", "server.js": "", "tools.json": "[]" },
        { "client.js": "", "tools.json": NOT_UTF8 },
        { "server.js": "", "tools.json": TOOLS, "tool-main.js": "" },
        { "client.js": NOT_UTF8 },
        { "README.md": NOT_UTF8 },
        {},
      ];
      for (let files of cases) {
        let { commit } = await commitBytes(impl, files);
        // What readSourceCommits did before: every file decoded, then the two parsed files re-read strictly.
        let full = new Map<string, string | null>(await impl.gitStore.readCommitFiles(commit));
        for (let path of ["view.json", "tools.json"].filter(name => full.has(name))) {
          full.set(path, await impl.gitStore.readCommitBlob(commit, path, "text").catch(error => {
            if (error instanceof BlobTextError) return null;
            throw error;
          }));
        }
        let expected = classifyGadgetFiles("widget", full);
        let { classification, viewText } = (await impl.readSourceCommits([commit])).get(commit)!;
        expect(classification).toEqual(expected);
        expect(viewText).toBe(expected.class === "viewOnly" ? full.get("view.json") : null);
      }
    });
  });

  it("undoes a refused publication's frozen installs in the overseer's own storage", async () => {
    await inOverseer("bound-view-oversize", async (impl, state) => {
      let { commit } = await commitBytes(impl, COMMITS.widget!);
      let record = impl.createGadget("Widget", "WIDGET", undefined, undefined, commit);
      record.installedFrom = { blueprintId: "bp", version: 1, kind: "widget" };
      impl.storage.gadgets.put(record);
      impl.storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [] } as never);
      let store = new WorkspaceConsoleStore(state.storage, impl.storage, ON, impl.frozenInstalls());
      let content: OperateConsoleContent = { title: "Floor", fullChat: "off", views: [{ id: "floor", title: "Floor", type: "screen", screen: "floor" }],
        widgets: [{ gadgetId: record.id, blueprintId: "bp", version: 1, label: "W", state: "resettable" }] };
      // A title no parse would accept: legal content cannot reach the cap.
      let saved = { ...store.create(content, await impl.readSourceCommits(store.sourceCommitIds(content))),
        title: "t".repeat(CONSOLE_SIZE_LIMITS.console) };
      impl.storage.consoles.put(saved);
      let gadgets = Array.from(impl.storage.gadgets.list());
      let nextId = impl.storage.nextGatekeeperId.get();
      let capture = store.capture(saved.id, saved.revision);
      let commits = await impl.readSourceCommits(capture.commitIds);
      expect(() => store.publish(saved.id, saved.revision, capture, commits)).toThrow(/over 720896 bytes published/);
      expect(Array.from(impl.storage.gadgets.list())).toEqual(gadgets);
      expect(impl.storage.gadgets.byBindingName.get("WIDGET_PUBLISHED")).toBeUndefined();
      expect(impl.storage.nextGatekeeperId.get()).toBe(nextId);
      expect(store.get(saved.id, "draft")!.published).toBeNull();
    });
  });
});

describe("delivering a bound view", () => {
  // A console as `publish` leaves it, its published projection, and ports reading them.
  function delivery() {
    let t = setup();
    let saved = t.store().create(t.content({ boundViews: [view()] }), ALL);
    let stored = t.publish(saved);
    let published = { ...stored.published!.content, id: stored.id, revision: stored.published!.revision, published: stored.published };
    let entryId = saved.boundViews![0]!.id!;
    let ref = (source: "published" | "draft" = "published"): ConsoleRef =>
      ({ consoleId: stored.id, source, revision: source === "published" ? published.revision : stored.revision });
    let shown: OperateConsole | null = published;
    let sessionSeq = 1;
    let enabled = true;
    let draftReads: (string | undefined)[] = [];
    let ports = (overrides: Partial<BoundViewPorts> = {}): BoundViewPorts => ({
      enabled: () => enabled,
      run: async () => shown && { workspaceId: "ws", console: shown, sessionSeq },
      readDraft: async (_workspaceId, commitId) => {
        draftReads.push(commitId);
        return { commitId: commitId ?? "viewEdited", specText: COMMITS[commitId ?? "viewEdited"]!["view.json"]! };
      },
      ...overrides,
    });
    return { t, stored, published, entryId, ref, ports, draftReads,
      show: (console: OperateConsole | null) => { shown = console; }, turn: (on: boolean) => { enabled = on; },
      // The session left the console and came back: the same console, at a new session sequence.
      revisit: () => { sessionSeq += 2; } };
  }
  const refused = /not open in your operate session with bound view/;

  it("returns a publication's frozen spec and requirement mapping, never reading the source", async () => {
    let d = delivery();
    let frozen = d.published.boundViews![0]!.frozen!;
    expect(await describeBoundView(d.ref(), d.entryId, {}, d.ports())).toEqual({ consoleRef: d.ref(), entryId: d.entryId,
      commitId: "view", specText: frozen.specText, requirements: [{ name: "board", hostBoardEntryId: d.published.hostBoards![0]!.id }] });
    // A later source edit changes nothing delivered: only `frozen` is read.
    d.t.gadget(10, "viewEdited");
    expect(await describeBoundView(d.ref(), d.entryId, { commitId: "view" }, d.ports())).toMatchObject({ commitId: "view", specText: frozen.specText });
    expect(d.draftReads).toEqual([]);
    await expect(describeBoundView(d.ref(), d.entryId, { commitId: "viewEdited" }, d.ports())).rejects.toThrow(refused);
  });

  it("re-parses the frozen spec, refusing one the v1 parser no longer accepts", async () => {
    let d = delivery();
    let entry = d.published.boundViews![0]!;
    let broken = (frozen: BoundViewFreeze) => ({ ...d.published, boundViews: [{ ...entry, frozen }] });
    d.show(broken({ ...entry.frozen!, specText: "{}" }));
    await expect(describeBoundView(d.ref(), d.entryId, {}, d.ports())).rejects.toThrow(/spec is not valid/);
    d.show(broken({ ...entry.frozen!, specText: spec(["ops"]) }));
    await expect(describeBoundView(d.ref(), d.entryId, {}, d.ports())).rejects.toThrow(/spec is not valid/);
  });

  it("reads a draft from its source, pinned by commit when asked", async () => {
    let d = delivery();
    d.show(d.stored);
    expect(await describeBoundView(d.ref("draft"), d.entryId, {}, d.ports())).toMatchObject({ commitId: "viewEdited",
      specText: COMMITS.viewEdited!["view.json"] });
    expect(await describeBoundView(d.ref("draft"), d.entryId, { commitId: "view" }, d.ports())).toMatchObject({ commitId: "view",
      specText: COMMITS.view!["view.json"] });
    expect(d.draftReads).toEqual([undefined, "view"]);
  });

  it("refuses when the context does not hold: another console, a stale revision, a forged entry, a host board's id", async () => {
    let d = delivery();
    d.show(null);
    await expect(describeBoundView(d.ref(), d.entryId, {}, d.ports())).rejects.toThrow(refused);
    d.show(d.published);
    await expect(describeBoundView(d.ref(), "forged", {}, d.ports())).rejects.toThrow(refused);
    await expect(describeBoundView(d.ref(), d.published.hostBoards![0]!.id!, {}, d.ports())).rejects.toThrow(refused);
    // A published entry without a freeze is never delivered from its source instead.
    d.show({ ...d.published, boundViews: [{ ...d.published.boundViews![0]!, frozen: undefined }] });
    await expect(describeBoundView(d.ref(), d.entryId, {}, d.ports())).rejects.toThrow(refused);
  });

  it("re-runs the guard after the draft read, refusing a context that moved while it ran", async () => {
    let d = delivery();
    d.show(d.stored);
    let ports = d.ports();
    let moved = d.ports({ readDraft: async (workspaceId, commitId) => {
      d.show(null);
      return ports.readDraft(workspaceId, commitId);
    } });
    await expect(describeBoundView(d.ref("draft"), d.entryId, {}, moved)).rejects.toThrow(refused);
    // An entry changed under the same revision (it cannot, but the fence compares it all the same).
    d.show(d.stored);
    let changed = d.ports({ readDraft: async (workspaceId, commitId) => {
      d.show({ ...d.stored, boundViews: [{ ...d.stored.boundViews![0]!, requirements: ["other"] }] });
      return ports.readDraft(workspaceId, commitId);
    } });
    await expect(describeBoundView(d.ref("draft"), d.entryId, {}, changed)).rejects.toThrow(refused);
    // The session left the console and returned to it (A, B, A) meanwhile: the same console, but a
    // different visit.
    d.show(d.stored);
    let returned = d.ports({ readDraft: async (workspaceId, commitId) => {
      d.revisit();
      return ports.readDraft(workspaceId, commitId);
    } });
    await expect(describeBoundView(d.ref("draft"), d.entryId, {}, returned)).rejects.toThrow(refused);
    expect(await describeBoundView(d.ref("draft"), d.entryId, {}, d.ports())).toMatchObject({ commitId: "viewEdited" });
    // The switch turned off meanwhile.
    d.show(d.stored);
    let off = d.ports({ readDraft: async (workspaceId, commitId) => {
      d.turn(false);
      return ports.readDraft(workspaceId, commitId);
    } });
    await expect(describeBoundView(d.ref("draft"), d.entryId, {}, off)).rejects.toThrow(BOUND_VIEWS_OFF);
  });

  it("refuses every delivery while the switch is off, before anything is read", async () => {
    let d = delivery();
    d.turn(false);
    let run = vi.fn(d.ports().run);
    await expect(describeBoundView(d.ref(), d.entryId, {}, d.ports({ run }))).rejects.toThrow(BOUND_VIEWS_OFF);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a draft bound view's source, against real commits", () => {
  type Impl = {
    storage: ReturnType<typeof makeOverseerStorage>;
    gitStore: { writeFilesAsCommit(files: Map<string, string>, options: object): Promise<string> };
    createGadget(title: string, bindingName: string, chatId?: number, output?: undefined, commitId?: string): GadgetRecord;
    frozenInstalls(): FrozenInstalls;
    readSourceCommits(commitIds: Iterable<string>): Promise<SourceCommits>;
  };

  it("reads the source's current commit or a pinned one, and refuses one that is not the entry's view", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName("bound-view-draft"), async (instance: OverseerDurableObject, state: DurableObjectState) => {
      let impl = (instance as unknown as { impl: Impl }).impl;
      let write = (files: Record<string, string>) => impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)),
        { message: "test", author: { name: "t", email: "t@example.com" }, timestamp: new Date(0), parents: [] });
      let [first, second, mixed, twoBoards] = [await write(COMMITS.view!), await write(COMMITS.viewEdited!),
        await write(COMMITS.mixed!), await write(COMMITS.twoBoards!)];
      let record = impl.createGadget("View", "VIEW", undefined, undefined, first);
      record.installedFrom = { blueprintId: "bp", version: 1, kind: "widget" };
      impl.storage.gadgets.put(record);
      impl.storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [] } as never);
      let store = new WorkspaceConsoleStore(state.storage, impl.storage, ON, impl.frozenInstalls());
      let content: OperateConsoleContent = { title: "Floor", fullChat: "off", views: [{ id: "floor", title: "Floor", type: "screen", screen: "floor" }],
        hostBoards: [board()], boundViews: [{ ...view(record.id) }] };
      let saved = store.create(content, await impl.readSourceCommits(store.sourceCommitIds(content)));
      let entryId = saved.boundViews![0]!.id!;
      let read = async (commitId: string) => store.draftBoundViewSpec(saved.id, saved.revision, entryId,
        (await impl.readSourceCommits([commitId])).get(commitId)!);

      expect(store.draftBoundViewCommit(saved.id, saved.revision, entryId)).toBe(first);
      impl.storage.gadgets.put({ ...record, commitId: second });
      expect(store.draftBoundViewCommit(saved.id, saved.revision, entryId)).toBe(second);
      expect(await read(second)).toBe(COMMITS.viewEdited!["view.json"]);
      expect(await read(first)).toBe(COMMITS.view!["view.json"]);
      await expect(read(mixed)).rejects.toThrow(/not a view-only widget.*client\.js/);
      await expect(read(twoBoards)).rejects.toThrow(/reads board, ops, not board/);
      // The entry must be the draft's, at its revision, and its source still a valid install.
      expect(() => store.draftBoundViewCommit(saved.id, saved.revision, "forged")).toThrow(/no bound view forged/);
      expect(() => store.draftBoundViewCommit(saved.id, "7", entryId)).toThrow();
      impl.storage.gadgets.put({ ...record, commitId: second, bindings: { x: {} as never } });
      expect(() => store.draftBoundViewCommit(saved.id, saved.revision, entryId)).toThrow(/bindings/);
    });
  });
});

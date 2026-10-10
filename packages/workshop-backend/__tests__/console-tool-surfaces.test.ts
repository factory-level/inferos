// Callable widget surfaces at console publication (callable-widget contract C4): each registered
// widget's captured commit is classified and its tools.json parsed before the transaction, the
// published entry freezes `{ui, tools}`, a commit that moves meanwhile refuses the publication, a
// widget with no UI is never placed on a screen, and tools are snapshotted only while
// CONSOLE_TOOLS is exactly "true". Frozen tools count toward the whole-console size cap. Synthetic
// consoles over mock Durable Object storage.
import { describe, expect, it } from "vitest";
import type { BoundViewEntry, ConsoleWidgetEntry, HostBoardEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { parseWidgetTools, WIDGET_TOOL_LIMITS } from "@gadgets/workshop-shared/widget-tools";
import { classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import { CONSOLE_SIZE_LIMITS, consoleToolsEnabled, WorkspaceConsoleStore, type FrozenInstalls, type SourceCommit, type SourceCommits } from "../src/console-store";
import { makeOverseerStorage, type GadgetRecord } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const ON = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CONSOLE_TOOLS: "true" };
const OFF = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
// Console tools, host boards and bound views all on, for the size bounds.
const ALL_ON = { ...ON, INFEROPS_HOST_BOARDS: "true", INFEROPS_BOUND_VIEWS: "true" };
type Env = typeof ON | typeof OFF | typeof ALL_ON;

const tool = (name: string) => ({
  name, description: `Reads ${name}.`, method: name, effect: "read",
  input: { type: "object", properties: {} },
  output: { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 0, maximum: 9 } } },
});
const SERVER = "export class Gadget {}";
const CLIENT = "document.body.textContent = 'ui';";

/** A commit's files, read as `OverseerImpl.readSourceCommits` reads them. */
function sourceCommit(files: Record<string, string>): SourceCommit {
  let map = new Map(Object.entries(files));
  let classification = classifyGadgetFiles("widget", map);
  let callable = classification.class === "callableTools" || classification.class === "callableCombined";
  return { classification, viewText: classification.class === "viewOnly" ? files["view.json"]! : null,
    tools: callable ? parseWidgetTools(files["tools.json"]!) : null };
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// A distinct property name for each index: a, b, ..., Z, ba, bb, ...
function propertyName(index: number): string {
  const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let name = "";
  do {
    name = LETTERS[index % LETTERS.length] + name;
    index = Math.floor(index / LETTERS.length);
  } while (index > 0);
  return name;
}

// A legal tools.json of at most 16 KiB that grows as much as any can when its parsed declarations
// are re-serialized: one tool whose output is as many number properties as fit, each bound written
// `1e20`, which serializes as 21 digits. `description` pads the tool by that many characters.
function maxToolsJson(description = "Reads.", limit: number = WIDGET_TOOL_LIMITS.fileBytes): string {
  let head = `[{"name":"read","description":${JSON.stringify(description)},"method":"read","effect":"read",` +
    `"input":{"type":"object","properties":{}},"output":{"type":"object","additionalProperties":false,"properties":{`;
  let properties: string[] = [];
  for (let index = 0; ; index++) {
    let next = [...properties, `"${propertyName(index)}":{"type":"number","minimum":1e20,"maximum":1e20}`];
    if (head.length + next.join(",").length + 4 > limit) break;
    properties = next;
  }
  return `${head}${properties.join(",")}}}}]`;
}

// An exactly 8 KiB spec of worst-case escaping: every authored character and the padding escape to
// two bytes when the spec is embedded in a JSON string (as in console-bound-views.test.ts).
function maxSpec(requirement = "board"): string {
  let children = Array.from({ length: 12 }, () => ({ type: "text", text: '"'.repeat(200) }));
  let text = JSON.stringify({ version: 1, title: '"'.repeat(200), requirements: [requirement], root: { type: "stack", children } });
  return text + "\n".repeat(8192 - new TextEncoder().encode(text).length);
}

const COMMITS = {
  visual: sourceCommit({ "client.js": CLIENT, "server.js": SERVER }),
  combined: sourceCommit({ "client.js": CLIENT, "server.js": SERVER, "tools.json": JSON.stringify([tool("openCount")]) }),
  toolsOnly: sourceCommit({ "server.js": SERVER, "tools.json": JSON.stringify([tool("openCount"), tool("closedCount")]) }),
  edited: sourceCommit({ "server.js": SERVER, "tools.json": JSON.stringify([tool("renamed")]) }),
  broken: sourceCommit({ "server.js": SERVER, "tools.json": "[]" }),
};
type CommitName = keyof typeof COMMITS;

/** What OverseerImpl.readSourceCommits returns for these commit ids. */
const readFrom = (commits: Record<string, SourceCommit>) => (ids: string[]): SourceCommits =>
  new Map(ids.map(id => [id, commits[id]!]));
const entry = (gadgetId: number, label = `W${gadgetId}`): ConsoleWidgetEntry =>
  ({ gadgetId, blueprintId: `bp${gadgetId}`, version: 1, label, state: "resettable" });
const content = (screenId: string, widgets: ConsoleWidgetEntry[]): OperateConsoleContent =>
  ({ title: "Floor", views: [{ id: "v", title: "V", type: "screen", screen: screenId }], fullChat: "off", widgets });

function setup(extra: Record<string, SourceCommit> = {}) {
  let read = readFrom({ ...COMMITS, ...extra });
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let nextId = 100;
  let frozen: FrozenInstalls = {
    create: (source, frozenFor) => {
      let id = nextId++;
      let made = { ...source, id, bindingName: `F${id}`, frozenFor } as GadgetRecord;
      storage.gadgets.put(made);
      return made;
    },
    remove: id => storage.gadgets.delete(id),
  };
  let install = (id: number, commitId: CommitName | keyof typeof extra, blueprintId = `bp${id}`) => {
    storage.gadgets.put({ type: "gadget", id, title: `W${id}`, created: new Date(0), bindingName: `W${id}`, bindings: {},
      commitId, installedFrom: { blueprintId, version: 1, kind: "widget" } } as GadgetRecord);
  };
  let screen = (id: string, gadgetIds: number[]) => storage.canvases.put({ id, title: id, revision: "0", sections: [{
    id: "main", title: "Main", columns: 1, widgets: gadgetIds.map(gadgetId => ({
      id: `w${gadgetId}`, version: 1, kind: "inferos.gadget", targetRef: `gadget:${gadgetId}`, params: {}, size: "normal" })),
  }] } as never);
  let store = (env: Env) => new WorkspaceConsoleStore(durable, storage, env, frozen);
  /** Saves and publishes as OverseerClientInterface does: read, then the checked transaction. */
  let save = (env: Env, value: OperateConsoleContent) =>
    store(env).create(value, read(store(env).sourceCommitIds(value)));
  let publish = (env: Env, id: string, revision: string) => {
    let capture = store(env).capture(id, revision);
    return store(env).publish(id, revision, capture, read(capture.commitIds));
  };
  return { storage, install, screen, store, read, entry, content, save, publish };
}

describe("console tool surfaces at publication", () => {
  it("freezes each widget's ui and tools from its captured commit, unchanged by later edits", () => {
    let t = setup();
    t.install(1, "visual");
    t.install(2, "combined");
    t.install(3, "toolsOnly");
    t.screen("floor", [1, 2]);
    let saved = t.save(ON, t.content("floor", [t.entry(1), t.entry(2), t.entry(3)]));
    let published = t.publish(ON, saved.id, saved.revision);
    let frozen = published.published!.content.widgets!.map(widget => widget.frozen);
    expect(frozen).toEqual([
      { sourceGadgetId: 1, commitId: "visual", ui: true },
      { sourceGadgetId: 2, commitId: "combined", ui: true, tools: COMMITS.combined.tools },
      { sourceGadgetId: 3, commitId: "toolsOnly", ui: false, tools: COMMITS.toolsOnly.tools },
    ]);
    expect(frozen[2]!.tools!.map(declared => declared.name)).toEqual(["openCount", "closedCount"]);

    // The source moves to a commit declaring other tools: the publication keeps its snapshot.
    t.install(3, "edited");
    let stored = t.store(ON).get(saved.id, "published")!;
    expect(stored.widgets![2]!.frozen).toEqual({ sourceGadgetId: 3, commitId: "toolsOnly", ui: false, tools: COMMITS.toolsOnly.tools });
    let offered = t.store(ON).offeredTool(saved.id, published.revision, stored.widgets![2]!.gadgetId, "closedCount");
    expect(offered.tool.name).toBe("closedCount");
    // Only the next publication takes the new commit's tools.
    let republished = t.publish(ON, saved.id, published.revision);
    expect(republished.published!.content.widgets![2]!.frozen!.tools!.map(declared => declared.name)).toEqual(["renamed"]);
  });

  it("refuses a publication whose widget's commit moved between the read and the transaction", () => {
    let t = setup();
    t.install(3, "toolsOnly");
    t.screen("floor", []);
    let saved = t.save(ON, t.content("floor", [t.entry(3)]));
    let capture = t.store(ON).capture(saved.id, saved.revision);
    let commits = t.read(capture.commitIds);
    t.install(3, "edited");
    expect(() => t.store(ON).publish(saved.id, saved.revision, capture, commits)).toThrow(/^The console or one of its gadgets changed while it was being saved or published; try again\.$/);
    // A commit read under the capture but no longer current is refused even if the capture is
    // taken afresh, since the transaction checks every gadget against the commits read.
    let fresh = t.store(ON).capture(saved.id, saved.revision);
    expect(() => t.store(ON).publish(saved.id, saved.revision, fresh, commits)).toThrow(/^The console or one of its gadgets changed while it was being saved or published; try again\.$/);
    expect(t.store(ON).get(saved.id, "draft")!.published).toBeNull();
    expect([...t.storage.gadgets.list()].filter(record => record.type === "gadget" && record.frozenFor)).toEqual([]);
  });

  it("refuses widgets without a capture and commits, so no surface goes unchecked", () => {
    let t = setup();
    t.install(1, "visual");
    t.screen("floor", []);
    let saved = t.save(ON, t.content("floor", [t.entry(1)]));
    expect(() => t.store(ON).publish(saved.id, saved.revision)).toThrow(/cannot be published here/);
  });

  it("refuses a registered gadget with no commit as such, not as a change to retry", () => {
    let t = setup();
    t.screen("floor", []);
    let uncommitted = () => t.storage.gadgets.put({ type: "gadget", id: 5, title: "W5", created: new Date(0), bindingName: "W5",
      bindings: {}, installedFrom: { blueprintId: "bp5", version: 1, kind: "widget" } } as GadgetRecord);
    uncommitted();
    expect(() => t.save(ON, t.content("floor", [t.entry(5)]))).toThrow(/^Gadget 5 has no committed files, so a console cannot offer it\.$/);
    // Saved while it had a commit, then left with none: publication refuses the same way.
    t.install(5, "visual", "bp5");
    let saved = t.save(ON, t.content("floor", [t.entry(5)]));
    uncommitted();
    expect(() => t.publish(ON, saved.id, saved.revision)).toThrow(/^Gadget 5 has no committed files/);
  });

  it("refuses a registered widget whose commit is not a widget with code", () => {
    let t = setup();
    t.install(4, "broken");
    t.screen("floor", []);
    expect(() => t.save(ON, t.content("floor", [t.entry(4)]))).toThrow(/not a widget a console runs.*tools\.json/);
  });
});

describe("a widget with no UI", () => {
  it("is refused on a screen when the console is saved", () => {
    let t = setup();
    t.install(3, "toolsOnly");
    t.screen("floor", [3]);
    expect(() => t.save(ON, t.content("floor", [t.entry(3)]))).toThrow(/shows widget 3, which has no UI/);
    // Flag off, too: placement is about the UI, not the tools.
    expect(() => t.save(OFF, t.content("floor", [t.entry(3)]))).toThrow(/which has no UI/);
  });

  it("is refused on a screen at publication, when the screen gained it after the save", () => {
    let t = setup();
    t.install(3, "toolsOnly");
    t.screen("floor", []);
    let saved = t.save(ON, t.content("floor", [t.entry(3)]));
    t.screen("floor", [3]);
    expect(() => t.publish(ON, saved.id, saved.revision)).toThrow(/shows widget 3, which has no UI/);
    expect(t.store(ON).get(saved.id, "draft")!.published).toBeNull();
  });
});

describe("the CONSOLE_TOOLS switch", () => {
  it("is on only when exactly \"true\"", () => {
    expect(consoleToolsEnabled({ CONSOLE_TOOLS: "true" })).toBe(true);
    for (let value of [undefined, "", "false", "TRUE", "1", " true"]) expect(consoleToolsEnabled({ CONSOLE_TOOLS: value })).toBe(false);
  });

  it("publishes no tool surfaces while off, and offers no tool", () => {
    let t = setup();
    t.install(2, "combined");
    t.install(3, "toolsOnly");
    t.screen("floor", [2]);
    let saved = t.save(OFF, t.content("floor", [t.entry(2), t.entry(3)]));
    let published = t.publish(OFF, saved.id, saved.revision);
    let [combined, toolsOnly] = published.published!.content.widgets!;
    expect(combined!.frozen).toEqual({ sourceGadgetId: 2, commitId: "combined", ui: true });
    expect(toolsOnly!.frozen).toEqual({ sourceGadgetId: 3, commitId: "toolsOnly", ui: false });
    expect(() => t.store(OFF).offeredTool(saved.id, published.revision, toolsOnly!.gadgetId, "openCount")).toThrow(/turned off/);
    // Turning the switch on later offers nothing until the console is published again.
    expect(() => t.store(ON).offeredTool(saved.id, published.revision, toolsOnly!.gadgetId, "openCount")).toThrow(/offers no tool/);
  });
});

describe("offeredTool", () => {
  it("finds a frozen declaration only at the published revision, for an offered widget", () => {
    let t = setup();
    t.install(1, "visual");
    t.install(3, "toolsOnly");
    t.screen("floor", []);
    let saved = t.save(ON, t.content("floor", [t.entry(1), t.entry(3)]));
    let published = t.publish(ON, saved.id, saved.revision);
    let [visual, toolsOnly] = published.published!.content.widgets!;
    let found = t.store(ON).offeredTool(saved.id, published.revision, toolsOnly!.gadgetId, "openCount");
    expect(found.entry).toEqual(toolsOnly);
    expect(found.tool).toEqual(COMMITS.toolsOnly.tools![0]);
    // An undeclared name, which never appears in the refusal.
    expect(() => t.store(ON).offeredTool(saved.id, published.revision, toolsOnly!.gadgetId, "dropTables"))
      .toThrow(/^(?!.*dropTables).*offers no tool by that name/);
    // A widget with no tools, the registered (unfrozen) install, a stale revision, another console.
    expect(() => t.store(ON).offeredTool(saved.id, published.revision, visual!.gadgetId, "openCount")).toThrow(/offers no tool/);
    expect(() => t.store(ON).offeredTool(saved.id, published.revision, 3, "openCount")).toThrow(/does not offer widget 3/);
    expect(() => t.store(ON).offeredTool(saved.id, saved.revision, toolsOnly!.gadgetId, "openCount")).toThrow(/has changed/);
    expect(() => t.store(ON).offeredTool("other", published.revision, toolsOnly!.gadgetId, "openCount")).toThrow(/not published/);
  });
});

describe("the whole-console size cap with frozen tools", () => {
  // Worst-case escaping: a lone surrogate serializes as a 6-byte \uXXXX escape. Gadget ids are the
  // largest a storage key takes (below Number.MAX_SAFE_INTEGER).
  const worst = (length: number) => "\ud800".repeat(length);
  const NAME = "r".repeat(64);
  const maxTools = maxToolsJson();
  const SIZED = {
    maxTools: sourceCommit({ "server.js": SERVER, "tools.json": maxTools }),
    maxView: sourceCommit({ "view.json": maxSpec(NAME) }),
  };
  const BLUEPRINT = worst(128);
  const widget = (gadgetId: number): ConsoleWidgetEntry =>
    ({ gadgetId: 2 ** 53 - 2 - gadgetId, blueprintId: BLUEPRINT, version: 2 ** 53 - 1, label: worst(120), state: "resettable" });
  const view = (gadgetId: number): BoundViewEntry => ({ kind: "bound-view", gadgetId: 2 ** 53 - 2 - gadgetId, blueprintId: BLUEPRINT,
    version: 2 ** 53 - 1, label: worst(120), requirements: [NAME] });
  const board: HostBoardEntry = { kind: "host-board", label: worst(120),
    requirement: { name: NAME, resource: "inferops-board", target: "inferops://acme.operations/project/board/ENGINEERIN" } };

  // The most legal content: every field at its bound with worst-case escaping, 12 rollups of 12
  // screens with 64-character ids, and every registry entry carrying its largest frozen payload.
  function maxConsole(widgets: number, views: number) {
    let t = setup(SIZED);
    let screens = Array.from({ length: 12 }, (_, index) => `${index}`.padStart(64, "s"));
    for (let id of screens) t.screen(id, []);
    let put = (id: number, commitId: string) => t.storage.gadgets.put({ type: "gadget", id, title: "W", created: new Date(0),
      bindingName: `W${id}`, bindings: {}, commitId, installedFrom: { blueprintId: BLUEPRINT, version: 2 ** 53 - 1, kind: "widget" } } as GadgetRecord);
    let entries = Array.from({ length: widgets }, (_, index) => widget(index));
    let bound = Array.from({ length: views }, (_, index) => view(100 + index));
    for (let entry of entries) put(entry.gadgetId, "maxTools");
    for (let entry of bound) put(entry.gadgetId, "maxView");
    let content: OperateConsoleContent = { title: worst(120), fullChat: "available",
      customization: { screens: false, widgets: false, tools: false, skills: false },
      views: screens.map((_, index) => ({ id: `${index}`.padStart(64, "v"), title: worst(120), type: "rollup" as const, screens })),
      widgets: entries, ...(views === 0 ? {} : { hostBoards: [board], boundViews: bound }) };
    let saved = t.save(ALL_ON, content);
    return { t, saved };
  }

  it("re-serializes a maximal tools.json to more than 16 KiB but at most 32 KiB", () => {
    expect(new TextEncoder().encode(maxTools).length).toBeLessThanOrEqual(WIDGET_TOOL_LIMITS.fileBytes);
    expect(new TextEncoder().encode(maxTools).length).toBeGreaterThan(WIDGET_TOOL_LIMITS.fileBytes - 64);
    expect(bytes(SIZED.maxTools.tools)).toBeGreaterThan(16 * 1024);
    expect(bytes(SIZED.maxTools.tools)).toBeLessThanOrEqual(32 * 1024);
  });

  it.each([
    ["16 callable widgets", 16, 0],
    ["13 callable widgets, one host board and two maximal bound views", 13, 2],
  ])("keeps the most legal console of %s within every bound term and under the cap", (_, widgets, views) => {
    let { t, saved } = maxConsole(widgets, views);
    // Each saved entry is under 2 KiB, inside the 4 KiB `entry` term; the rest of the draft is
    // under 24 KiB, inside its 32 KiB term; the whole draft inside 96 KiB.
    let entries = [...saved.widgets ?? [], ...saved.hostBoards ?? [], ...saved.boundViews ?? []];
    expect(entries).toHaveLength(16);
    for (let entry of entries) expect(bytes(entry)).toBeLessThan(2 * 1024);
    let { widgets: _w, hostBoards: _h, boundViews: _b, id: _i, revision: _r, published: _p, ...rest } = saved;
    expect(bytes(rest)).toBeLessThan(24 * 1024);
    expect(bytes(saved)).toBeLessThanOrEqual(96 * 1024);
    let published = t.publish(ALL_ON, saved.id, saved.revision);
    let content = published.published!.content;
    for (let entry of content.widgets!) expect(entry.frozen!.tools).toEqual(SIZED.maxTools.tools);
    for (let entry of content.boundViews ?? []) {
      expect(bytes(entry)).toBeGreaterThan(16 * 1024);
      expect(bytes(entry)).toBeLessThanOrEqual(CONSOLE_SIZE_LIMITS.frozenBoundViewEntry);
    }
    // Legal content cannot reach the cap: the largest stays more than 64 KiB under it.
    expect(bytes(t.storage.consoles.get(saved.id))).toBeLessThan(CONSOLE_SIZE_LIMITS.console - 64 * 1024);
  });

  // Since no legal console reaches the cap, it is reached through a stored draft whose title no
  // parse would accept (stored twice, in the draft and the publication) plus a tool description
  // (stored once, in the frozen tools), so the row can be sized to the byte. The cap is the
  // backstop that refuses such a row.
  it("publishes a row of exactly the cap, and refuses one byte over with its frozen installs undone", () => {
    const PAD = 1000;
    let attempt = (padding: number, description: string) => {
      let t = setup({ ...SIZED, tuned: sourceCommit({ "server.js": SERVER, "tools.json": maxToolsJson(description, 8 * 1024) }) });
      t.screen("floor", []);
      for (let id = 1; id <= 15; id++) t.install(id, "maxTools");
      t.install(16, "tuned");
      let widgets = Array.from({ length: 16 }, (_, index) => t.entry(index + 1));
      let saved = { ...t.save(ALL_ON, t.content("floor", widgets)), title: "t".repeat(padding) };
      t.storage.consoles.put(saved);
      let before = [...t.storage.gadgets.list()];
      try {
        t.publish(ALL_ON, saved.id, saved.revision);
      } catch (error) {
        expect([...t.storage.gadgets.list()]).toEqual(before);
        expect(t.store(ALL_ON).get(saved.id, "draft")!.published).toBeNull();
        return { refused: error as Error };
      }
      return { size: bytes(t.storage.consoles.get(saved.id)) };
    };
    let base = attempt(PAD, "d".repeat(100)).size!;
    let missing = CONSOLE_SIZE_LIMITS.console - base;
    expect(missing).toBeGreaterThan(0);
    let padding = PAD + Math.floor(missing / 2);
    let description = "d".repeat(100 + missing % 2);
    expect(attempt(padding, description)).toEqual({ size: CONSOLE_SIZE_LIMITS.console });
    let over = attempt(padding, `${description}d`);
    expect(over.refused?.message).toBe(`This console would be over ${CONSOLE_SIZE_LIMITS.console} bytes published.`);
  });
});

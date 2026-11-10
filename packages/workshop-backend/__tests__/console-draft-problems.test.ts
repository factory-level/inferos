// What would stop a console draft publishing (FAC-96): one shared check gives publication its first
// refusal and a builder the whole list, each problem with its target and repair, and validating
// writes nothing, so a valid draft survives reopening unchanged. Over mock Durable Object storage,
// with the real console store; who may validate is workshop-use-role.test.ts's.
import { describe, expect, it } from "vitest";
import { canvasPageFromDefinition, canvasRunEvent, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { ConsoleWidgetEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { parseWidgetStates } from "@gadgets/workshop-shared/widget-state";
import { classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import { WorkspaceConsoleStore, type FrozenInstalls, type SourceCommit, type SourceCommits } from "../src/console-store";
import { makeOverseerStorage, type GadgetRecord } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
const FILES = { "client.js": "document.body.textContent = 'ui';", "server.js": "export class Gadget {}" };
const STATES = { version: 1, initial: "a", persistence: "person", states: ["a", "b"], transitions: [{ event: "go", from: "a", to: "b" }] };
const commit = (files: Record<string, string>): SourceCommit => ({
  classification: classifyGadgetFiles("widget", new Map(Object.entries(files))), viewText: null, tools: null,
  states: files["states.json"] ? parseWidgetStates(files["states.json"]) : null, statesProblem: null,
});
const COMMITS: Record<string, SourceCommit> = { stateful: commit({ ...FILES, "states.json": JSON.stringify(STATES) }) };
const read = (ids: string[]): SourceCommits => new Map(ids.map(id => [id, COMMITS[id]!]));
const ENTRY: ConsoleWidgetEntry = { gadgetId: 1, blueprintId: "bp1", version: 1, label: "W1", state: "resettable" };

function setUp() {
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
  for (let id of [1, 2]) {
    storage.gadgets.put({ type: "gadget", id, title: `W${id}`, created: new Date(0), bindingName: `W${id}`, bindings: {},
      commitId: "stateful", installedFrom: { blueprintId: `bp${id}`, version: 1, kind: "widget" } } as GadgetRecord);
  }
  for (let [id, gadgets] of [["floor", [1]], ["done", []]] as const) {
    storage.canvases.put({ schemaVersion: 1, id, title: id, revision: "0", sections: [{ id: `${id}-main`, title: "Main", columns: 1,
      widgets: gadgets.map(g => ({ id: `w${g}`, version: 1, kind: "inferos.gadget", targetRef: `gadget:${g}`, params: {}, size: "normal" })) }] } as never);
  }
  let consoles = new WorkspaceConsoleStore(durable, storage, ENV as never, frozen);
  return { durable, storage, consoles };
}

/** Screen "floor" nested, its widget wired with `attachments`. */
function wire(storage: ReturnType<typeof setUp>["storage"], attachments: CanvasPage["attachments"]) {
  let row = storage.canvases.get("floor")!;
  let page = canvasPageFromDefinition(row);
  let nested = { ...page, nodes: [
    ...page.nodes.map(node => node.nodeType === "object" ? { ...node, children: ["inner"] } : { ...node, attachments }),
    { nodeType: "object", id: "inner", title: "Inner", columns: 1, children: ["w1"], attachments: [] },
  ] } as CanvasPage;
  storage.canvasPages.put({ page: nested, basedOnRevision: row.revision } as never);
}

const content = (extra: Partial<OperateConsoleContent> = {}): OperateConsoleContent => ({
  title: "Floor", fullChat: "off", widgets: [ENTRY],
  views: ["floor", "done"].map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })), ...extra,
});

describe("a console draft's problems (FAC-96)", () => {
  it("lists every one publication would refuse, in its order and words, each with its target and repair", () => {
    let t = setUp();
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    // Problems added after the save, as storage written outside the editor could be.
    wire(t.storage, [
      { id: "out", version: 1, on: "go", effect: { kind: "navigate", page: "elsewhere" } },
      { id: "odd", version: 1, on: "finish", effect: { kind: "navigate", page: "done" } },
    ]);
    t.storage.flows.put({ id: "f", revision: "0", title: "Shift", steps: ["floor", "missing"] } as never);
    let stored = t.storage.consoles.get(draft.id)!;
    t.storage.consoles.put({ ...stored, flows: ["f", "gone"] });

    let capture = t.consoles.capture(draft.id, draft.revision);
    let problems = t.consoles.draftProblems(draft.id, draft.revision, read(capture.commitIds));
    expect(problems.map(problem => [problem.code, problem.target])).toEqual([
      ["navigation-outside-console", "page:floor/attachment:out"],
      ["undeclared-event", "page:floor/attachment:odd"],
      ["flow-step-outside-console", `console:${draft.id}/flow:f`],
      ["flow-missing", `console:${draft.id}/flow:gone`],
    ]);
    for (let problem of problems) expect(problem.repair.length).toBeGreaterThan(0);
    expect(problems[2]!.repair).toBe("Add that screen to the console, or remove the step from the flow.");
    // Publication refuses with exactly the first, in the same words.
    expect(() => t.consoles.publish(draft.id, draft.revision, capture, read(capture.commitIds))).toThrow(problems[0]!.message);
  });

  it("names an unregistered widget on a screen, and a registry entry it refuses", () => {
    let t = setUp();
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    // Widget 2 placed without registering it, and widget 1 given a binding after the save.
    let row = t.storage.canvases.get("done")!;
    t.storage.canvases.put({ ...row, sections: [{ ...row.sections[0]!, widgets: [
      { id: "w2", version: 1, kind: "inferos.gadget", targetRef: "gadget:2", params: {}, size: "normal" } as never] }] });
    let one = t.storage.gadgets.get(1) as GadgetRecord;
    t.storage.gadgets.put({ ...one, bindings: { BOARD: {} } } as never);
    let problems = t.consoles.draftProblems(draft.id, draft.revision, read(t.consoles.capture(draft.id, draft.revision).commitIds));
    expect(problems.map(problem => [problem.code, problem.target])).toEqual([
      ["widget-refused", `console:${draft.id}/widget:1`],
      ["widget-not-registered", "page:done"],
    ]);
  });

  it("finds none for a valid draft, which then publishes", () => {
    let t = setUp();
    wire(t.storage, [{ id: "next", version: 1, on: "go", effect: { kind: "navigate", page: "done" } }]);
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    let capture = t.consoles.capture(draft.id, draft.revision);
    expect(t.consoles.draftProblems(draft.id, draft.revision, read(capture.commitIds))).toEqual([]);
    expect(t.consoles.publish(draft.id, draft.revision, capture, read(capture.commitIds)).published).not.toBeNull();
  });

  it("writes nothing: the draft, its pages and every revision read back the same", () => {
    let t = setUp();
    wire(t.storage, [{ id: "out", version: 1, on: "go", effect: { kind: "navigate", page: "elsewhere" } }]);
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    let snapshot = () => JSON.stringify({
      consoles: [...t.storage.consoles.list()], canvases: [...t.storage.canvases.list()],
      pages: [...t.storage.canvasPages.list()], screens: [...t.storage.consoleScreens.list()], gadgets: [...t.storage.gadgets.list()],
    });
    let before = snapshot();
    t.consoles.draftProblems(draft.id, draft.revision, read(t.consoles.capture(draft.id, draft.revision).commitIds));
    expect(snapshot()).toBe(before);
    expect(t.consoles.get(draft.id, "draft")?.revision).toBe(draft.revision);
  });
});

// QA on #401: a page stored outside the editor that doesn't parse (here a loop of raised events)
// is one problem, at that page, and the rest are still listed; it never makes validation throw.
describe("a draft page that doesn't parse", () => {
  it("is one problem with the parser's words and a repair, beside the others, and publication refuses with it", () => {
    let t = setUp();
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    let row = t.storage.canvases.get("floor")!;
    let page = canvasPageFromDefinition(row);
    // Two attachments raising each other's events, which the editor would refuse (reference-cycle).
    let looped = { ...page, attachments: [{ id: "l1", version: 1, on: "ping", effect: { kind: "raise-event", target: page.id, event: "pong" } },
      { id: "l2", version: 1, on: "pong", effect: { kind: "raise-event", target: page.id, event: "ping" } }] };
    t.storage.canvasPages.put({ page: looped, basedOnRevision: row.revision } as never);
    let stored = t.storage.consoles.get(draft.id)!;
    t.storage.consoles.put({ ...stored, flows: ["gone"] });

    let capture = t.consoles.capture(draft.id, draft.revision);
    let problems = t.consoles.draftProblems(draft.id, draft.revision, read(capture.commitIds));
    expect(problems.map(problem => [problem.code, problem.target])).toEqual([
      ["invalid-page", "page:floor"],
      ["flow-missing", `console:${draft.id}/flow:gone`],
    ]);
    expect(problems[0]!.message).toContain("reference-cycle");
    expect(problems[0]!.repair).toContain("loop");
    expect(() => t.consoles.publish(draft.id, draft.revision, capture, read(capture.commitIds))).toThrow(problems[0]!.message);
  });
});

// FAC-116 merged into FAC-96: a widget hearing a trigger's runs is checked by the same shared check.
describe("a widget hearing a trigger's runs", () => {
  it("is listed when the trigger isn't its gadget's, with its target and repair, and publication refuses with it", () => {
    let t = setUp();
    wire(t.storage, [{ id: "ran", version: 1, on: canvasRunEvent("run-failed", 11), effect: { kind: "navigate", page: "done" } }]);
    let draft = t.consoles.create(content(), read(t.consoles.sourceCommitIds(content())));
    let capture = t.consoles.capture(draft.id, draft.revision);
    let problems = t.consoles.draftProblems(draft.id, draft.revision, read(capture.commitIds));
    expect(problems.map(problem => [problem.code, problem.target])).toEqual([["run-trigger-mismatch", "page:floor/attachment:ran"]]);
    expect(problems[0]!.message).toBe("Screen floor can't be published: its widget w1 hears the runs of trigger 11, which isn't a trigger of gadget 1.");
    expect(problems[0]!.repair).toBe("Point the attachment at a trigger of this widget's gadget, or remove the attachment.");
    expect(() => t.consoles.publish(draft.id, draft.revision, capture, read(capture.commitIds))).toThrow(problems[0]!.message);
  });
});

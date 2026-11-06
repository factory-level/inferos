// A widget's own events wired to page effects, at console publication (FAC-94): an attachment on a
// gadget widget may listen for an event the widget's states.json declares, and publication checks
// each one against the commit it freezes. An event the frozen widget doesn't declare, or any event
// on a widget with no states, refuses the publication with nothing published. Over mock Durable
// Object storage, with the real console store.
import { describe, expect, it } from "vitest";
import { canvasPageFromDefinition, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { ConsoleWidgetEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { parseWidgetStates } from "@gadgets/workshop-shared/widget-state";
import { classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import { WorkspaceConsoleStore, type FrozenInstalls, type SourceCommit, type SourceCommits } from "../src/console-store";
import { makeOverseerStorage, type GadgetRecord } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
const FILES = { "client.js": "document.body.textContent = 'ui';", "server.js": "export class Gadget {}" };
const STATES = {
  version: 1, initial: "viewing", persistence: "person", states: ["viewing", "editing"],
  transitions: [{ event: "edit", from: "viewing", to: "editing" }, { event: "cancel", from: "editing", to: "viewing" }],
};

function sourceCommit(files: Record<string, string>): SourceCommit {
  let classification = classifyGadgetFiles("widget", new Map(Object.entries(files)));
  let states = files["states.json"] === undefined ? null : parseWidgetStates(files["states.json"]);
  return { classification, viewText: null, tools: null, states, statesProblem: null };
}
const COMMITS: Record<string, SourceCommit> = {
  stateful: sourceCommit({ ...FILES, "states.json": JSON.stringify(STATES) }),
  plain: sourceCommit(FILES),
};
const read = (ids: string[]): SourceCommits => new Map(ids.map(id => [id, COMMITS[id]!]));

function setUp(commitId: string) {
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
  storage.gadgets.put({ type: "gadget", id: 1, title: "W1", created: new Date(0), bindingName: "W1", bindings: {},
    commitId, installedFrom: { blueprintId: "bp1", version: 1, kind: "widget" } } as GadgetRecord);
  for (let id of ["floor", "done"]) {
    storage.canvases.put({ schemaVersion: 1, id, title: id, revision: "0", sections: [{ id: `${id}-main`, title: "Main", columns: 1,
      widgets: id === "floor" ? [{ id: "w1", version: 1, kind: "inferos.gadget", targetRef: "gadget:1", params: {}, size: "normal" }] : [],
    }] } as never);
  }
  let consoles = new WorkspaceConsoleStore(durable, storage, ENV as never, frozen);
  return { storage, consoles };
}

const BOARD = { nodeType: "widget", id: "eng", kind: "inferops.project-board", version: 1, size: "normal", attachments: [],
  targetRef: "inferops://acme.operations/project/board/ENG", params: { workflow: "software", showCompleted: false } } as const;

/**
 * Screen "floor" as a nested page whose widget listens for `event`, navigating to "done", or with
 * `requesting`, asking the board beside it to create an issue.
 */
function wire(storage: ReturnType<typeof setUp>["storage"], event: string, requesting = false) {
  let row = storage.canvases.get("floor")!;
  let page = canvasPageFromDefinition(row);
  let effect = requesting ? { kind: "request-action" as const, target: "eng", action: "create-issue" }
    : { kind: "navigate" as const, page: "done" };
  let nested = { ...page, nodes: [
    ...page.nodes.map(node => node.nodeType === "object" ? { ...node, children: ["inner", ...(requesting ? ["eng"] : [])] }
      : { ...node, attachments: [{ id: "next", version: 1 as const, on: event, effect }] }),
    { nodeType: "object", id: "inner", title: "Inner", columns: 1, children: ["w1"], attachments: [] },
    ...(requesting ? [BOARD] : []),
  ] } as CanvasPage;
  storage.canvasPages.put({ page: nested, basedOnRevision: row.revision } as never);
}

const ENTRY: ConsoleWidgetEntry = { gadgetId: 1, blueprintId: "bp1", version: 1, label: "W1", state: "resettable" };
const CONTENT: OperateConsoleContent = { title: "Floor", fullChat: "off", widgets: [ENTRY],
  views: ["floor", "done"].map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })) };

function publish({ consoles }: ReturnType<typeof setUp>) {
  let draft = consoles.create(CONTENT, read(consoles.sourceCommitIds(CONTENT)));
  let capture = consoles.capture(draft.id, draft.revision);
  return { draft, run: () => consoles.publish(draft.id, draft.revision, capture, read(capture.commitIds)) };
}

describe("a widget's own events at publication (FAC-94)", () => {
  it("publishes an attachment listening for an event the frozen widget declares, on the frozen widget", () => {
    let t = setUp("stateful");
    wire(t.storage, "edit");
    let published = publish(t).run();
    let frozenId = published.published!.content.widgets![0]!.gadgetId;
    let page = t.consoles.page(published.id, "floor", "published")!;
    let widget = page.nodes.find(node => node.nodeType === "widget")!;
    expect(widget).toMatchObject({ targetRef: `gadget:${frozenId}`, attachments: [{ id: "next", on: "edit" }] });
  });

  it.for([
    ["an event its states don't declare", "stateful", "finish"],
    ["any event on a widget with no states", "plain", "edit"],
  ] as const)("refuses %s, publishing nothing", ([, commitId, event]) => {
    let t = setUp(commitId);
    wire(t.storage, event);
    let { draft, run } = publish(t);
    expect(run).toThrow(`Screen floor can't be published: its widget w1 listens for "${event}", which gadget 1 doesn't declare.`);
    let stored = t.storage.consoles.get(draft.id)!;
    expect(stored.published).toBeNull();
    expect(stored.revision).toBe(draft.revision);
    expect(t.consoles.page(draft.id, "floor", "published")).toBeNull();
    // No frozen install was left behind.
    expect([...t.storage.gadgets.list()].map(gadget => gadget.id)).toEqual([1]);
  });

  it("refuses a declared event that leads to a requested action, publishing nothing", () => {
    let t = setUp("stateful");
    wire(t.storage, "edit", true);
    let { draft, run } = publish(t);
    expect(run).toThrow(`Screen floor can't be published: its widget w1's event "edit" leads to a requested action, which a widget event can't run.`);
    expect(t.storage.consoles.get(draft.id)!.published).toBeNull();
    expect(t.consoles.page(draft.id, "floor", "published")).toBeNull();
  });
});

/** Trigger `id` bound on gadget `gadgetId`. */
function hook(storage: ReturnType<typeof setUp>["storage"], id: number, gadgetId: number) {
  storage.boundHooks.put({
    id, actionId: 1, gatekeeperId: 7, gadgetId, vendorId: "scheduler", controller: null, callback: null,
    description: { title: `Trigger ${id}` }, enabled: true,
  } as never);
}

// FAC-116: a gadget widget's attachment may hear the run results of one of that gadget's triggers,
// and publication checks the trigger is one, and that the result leads only to navigation.
describe("a run's result at publication (FAC-116)", () => {
  it("publishes an attachment hearing a trigger of the widget's own gadget, on the frozen widget", () => {
    let t = setUp("stateful");
    hook(t.storage, 11, 1);
    wire(t.storage, "run-succeeded-11");
    let published = publish(t).run();
    let page = t.consoles.page(published.id, "floor", "published")!;
    let widget = page.nodes.find(node => node.nodeType === "widget")!;
    expect(widget).toMatchObject({ attachments: [{ id: "next", on: "run-succeeded-11" }] });
  });

  it.for([
    ["a trigger that isn't bound", null],
    ["another gadget's trigger", 2],
  ] as const)("refuses %s, publishing nothing", ([, gadgetId]) => {
    let t = setUp("plain");
    if (gadgetId !== null) hook(t.storage, 11, gadgetId);
    wire(t.storage, "run-failed-11");
    let { draft, run } = publish(t);
    expect(run).toThrow("Screen floor can't be published: its widget w1 hears the runs of trigger 11, which isn't a trigger of gadget 1.");
    expect(t.storage.consoles.get(draft.id)!.published).toBeNull();
    expect([...t.storage.gadgets.list()].map(gadget => gadget.id)).toEqual([1]);
  });

  it("refuses a run's result that leads to a requested action, publishing nothing", () => {
    let t = setUp("plain");
    hook(t.storage, 11, 1);
    wire(t.storage, "run-succeeded-11", true);
    let { draft, run } = publish(t);
    expect(run).toThrow(`Screen floor can't be published: its widget w1's "run-succeeded" for trigger 11 leads to a requested action, which a run's result can't run.`);
    expect(t.storage.consoles.get(draft.id)!.published).toBeNull();
  });
});

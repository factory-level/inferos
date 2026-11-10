// FAC-98 on a rollback: a reader from before `insert-prompt` refuses an effect kind it doesn't know,
// so a page's prompt attachments are stored beside the page, never inside it. The stored page and
// its published copy hold only the effects that reader takes; read back here, each prompt is where
// it was. Over mock Durable Object storage, with the real canvas and console stores.
import { describe, expect, it } from "vitest";
import type { CanvasAttachment, CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { parseWidgetStates } from "@gadgets/workshop-shared/widget-state";
import { classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import { joinStoredPage, splitStoredPage, WorkspaceCanvasStore } from "../src/canvas-store";
import { WorkspaceConsoleStore, type FrozenInstalls, type SourceCommits } from "../src/console-store";
import { makeOverseerStorage, type GadgetRecord } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv;
/** The effect kinds a reader from before FAC-98 accepts. */
const OLD_EFFECTS = ["navigate", "raise-event", "request-action"];

/** Gadget 1's commit: a widget whose states declare "finish". */
const FILES = { "client.js": "document.body.textContent = 'ui';", "server.js": "export class Gadget {}",
  "states.json": JSON.stringify({ version: 1, initial: "open", persistence: "person", states: ["open", "done"],
    transitions: [{ event: "finish", from: "open", to: "done" }] }) };
const COMMITS: SourceCommits = new Map([["c1", { classification: classifyGadgetFiles("widget", new Map(Object.entries(FILES))),
  viewText: null, tools: null, states: parseWidgetStates(FILES["states.json"]), statesProblem: null }]]);

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  let nextId = 100;
  const frozen: FrozenInstalls = {
    create: (source, frozenFor) => {
      const id = nextId++;
      const made = { ...source, id, bindingName: `F${id}`, frozenFor } as GadgetRecord;
      storage.gadgets.put(made);
      return made;
    },
    remove: id => storage.gadgets.delete(id),
  };
  storage.gadgets.put({ type: "gadget", id: 1, title: "W1", created: new Date(0), bindingName: "W1", bindings: {},
    commitId: "c1", installedFrom: { blueprintId: "bp1", version: 1, kind: "widget" } } as GadgetRecord);
  // Screen "floor": one section holding gadget widget w1.
  storage.canvases.put({ schemaVersion: 1, id: "floor", title: "Floor", revision: "0", sections: [{ id: "work", title: "Work", columns: 1,
    widgets: [{ id: "w1", version: 1, kind: "inferos.gadget", targetRef: "gadget:1", params: {}, size: "normal" }] }] } as never);
  return { storage, canvases: new WorkspaceCanvasStore(durable, storage, ENV), consoles: new WorkspaceConsoleStore(durable, storage, ENV as never, frozen) };
}
const consoleOver = (screenId: string): OperateConsoleContent =>
  ({ title: "Floor", fullChat: "off", views: [{ id: "v", title: "V", type: "screen", screen: screenId }],
    widgets: [{ gadgetId: 1, blueprintId: "bp1", version: 1, label: "W1", state: "resettable" }] });

/**
 * Widget w1's "finish" raises "check" on its section, which raises "done" on the page. A prompt
 * sits first on the widget, one between two others on the section, and one alone on the page.
 */
const WIRED: Record<"w1" | "work" | "floor", CanvasAttachment[]> = {
  w1: [{ id: "p0", version: 1, on: "finish", effect: { kind: "insert-prompt", text: "Summarise the work" } },
    { id: "a0", version: 1, on: "finish", effect: { kind: "raise-event", target: "work", event: "check" } }],
  work: [{ id: "a1", version: 1, on: "check", effect: { kind: "raise-event", target: "floor", event: "done" } },
    { id: "p1", version: 1, on: "check", effect: { kind: "insert-prompt", text: "Check the work" } },
    { id: "a2", version: 1, on: "check", effect: { kind: "raise-event", target: "floor", event: "done" } }],
  floor: [{ id: "p2", version: 1, on: "done", effect: { kind: "insert-prompt", text: "File it" } }],
};
const wire = (canvases: ReturnType<typeof setUp>["canvases"], attachments = WIRED) =>
  canvases.editPage("floor", "0", Object.entries(attachments).map(([target, list]) => ({ type: "setAttachments" as const, target, attachments: list })));
const attachmentsOf = (page: CanvasPage, owner: string) =>
  owner === page.id ? page.attachments : page.nodes.find(node => node.id === owner)!.attachments;

const effectKinds = (page: CanvasPage) =>
  [...page.attachments, ...page.nodes.flatMap(node => node.attachments)].map(attachment => attachment.effect.kind);

describe("a page's prompts on a rollback (FAC-98)", () => {
  it("are stored beside the nested page and its published copy, which keep only effects an older reader takes", () => {
    const { storage, canvases, consoles } = setUp();
    wire(canvases);

    const stored = storage.canvasPages.get("floor")!;
    expect(effectKinds(stored.page).every(kind => OLD_EFFECTS.includes(kind))).toBe(true);
    expect(attachmentsOf(stored.page, "work").map(attachment => attachment.id)).toEqual(["a1", "a2"]);
    expect(stored.prompts).toEqual([
      { owner: "floor", index: 0, attachment: WIRED.floor[0] },
      { owner: "work", index: 1, attachment: WIRED.work[1] },
      { owner: "w1", index: 0, attachment: WIRED.w1[0] },
    ]);
    // Read back, every prompt is where it was.
    const read = canvases.getPage("floor")!;
    for (const owner of ["floor", "work", "w1"] as const) expect(attachmentsOf(read, owner)).toEqual(WIRED[owner]);

    const draft = consoles.create(consoleOver("floor"), COMMITS);
    consoles.publish(draft.id, draft.revision, consoles.capture(draft.id, draft.revision), COMMITS);
    const snapshot = [...storage.consoleScreens.list()].find(item => item.screenId === "floor")!;
    expect(effectKinds(snapshot.page!).every(kind => OLD_EFFECTS.includes(kind))).toBe(true);
    expect(snapshot.pagePrompts).toEqual(stored.prompts);
    const published = consoles.page(draft.id, "floor", "published")!;
    for (const owner of ["floor", "work", "w1"] as const) expect(attachmentsOf(published, owner)).toEqual(WIRED[owner]);
  });

  it("keeps nothing beside a page with no prompts", () => {
    const { storage, canvases } = setUp();
    const page = wire(canvases);
    expect(storage.canvasPages.get("floor")?.prompts).toHaveLength(3);
    canvases.editPage("floor", page.revision, Object.entries(WIRED).map(([target, list]) =>
      ({ type: "setAttachments" as const, target, attachments: list.filter(attachment => attachment.effect.kind !== "insert-prompt") })));
    expect(storage.canvasPages.get("floor")).not.toHaveProperty("prompts");
  });

  it("refuses a stored prompt whose owner the page doesn't hold, as a corrupt record", () => {
    const { canvases } = setUp();
    const split = splitStoredPage(wire(canvases));
    expect(() => joinStoredPage(split.page, undefined, [{ ...split.prompts![0]!, owner: "gone" }]))
      .toThrow("A stored prompt names gone, which its page doesn't hold");
  });
});

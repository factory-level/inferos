// FAC-99: a console publication records who published it and which revision, and a draft whose
// screens hold an invalid typed read binding (FAC-92: invalid, incompatible with its widget, or a
// bad reference), or that is stale, is refused with nothing published: no screen copy, no
// publication record, the draft unchanged. Over mock Durable Object storage, with the real console
// and canvas stores. Who may publish (the company Admin) is shared-configuration.test.ts's.
import { describe, expect, it } from "vitest";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceCanvasStore } from "../src/canvas-store";
import { WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

type CanvasEnv = ConstructorParameters<typeof WorkspaceCanvasStore>[2];
type ConsoleEnv = ConstructorParameters<typeof WorkspaceConsoleStore>[2];
const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CANVAS_CATALOG: undefined } as unknown as CanvasEnv & ConsoleEnv;
const ADMIN = { type: "user" as const, id: "admin-profile", name: "Ada Admin" };
const BOARD_REF = "inferops://acme.operations/project/board/ENG";
const BOARD = {
  kind: "inferops.project-board", version: 1, targetRef: BOARD_REF,
  size: "wide", params: { workflow: "software", showCompleted: false },
};

function setUp() {
  const durable = makeMockStorage();
  const storage = makeOverseerStorage(durable);
  return { storage, canvases: new WorkspaceCanvasStore(durable, storage, ENV), consoles: new WorkspaceConsoleStore(durable, storage, ENV) };
}

const screenContent = (title: string) =>
  ({ title, sections: [{ id: `${title.toLowerCase()}-work`, title: "Work", columns: 2 as const, widgets: [{ id: `${title.toLowerCase()}-eng`, ...BOARD } as never] }] });
const consoleOver = (...screens: string[]): OperateConsoleContent =>
  ({ title: "Floor", fullChat: "off", views: screens.map(screen => ({ id: `v-${screen}`, title: screen, type: "screen" as const, screen })) });

/** A stored screen whose one widget is changed as `patch` says, as storage written outside the editor could be. */
function tamper(storage: ReturnType<typeof setUp>["storage"], screenId: string, patch: Record<string, unknown>) {
  const row = storage.canvases.get(screenId)! as unknown as { sections: { widgets: Record<string, unknown>[] }[] };
  const widget = row.sections[0]!.widgets[0]!;
  storage.canvases.put({ ...row, sections: [{ ...row.sections[0]!, widgets: [{ ...widget, ...patch }] }] } as never);
}

function nothingPublished(stores: ReturnType<typeof setUp>, consoleId: string, screenId: string, revision: string) {
  const stored = stores.storage.consoles.get(consoleId)!;
  expect(stored.published).toBeNull();
  expect(stored.revision).toBe(revision);
  expect(stores.consoles.screen(consoleId, screenId, "published")).toBeNull();
}

describe("a console publication (FAC-99)", () => {
  it("records who published it and which revision", () => {
    const stores = setUp();
    const screen = stores.canvases.create(screenContent("Triage"));
    const draft = stores.consoles.create(consoleOver(screen.id));
    const capture = stores.consoles.capture(draft.id, draft.revision);
    const published = stores.consoles.publish(draft.id, draft.revision, capture, new Map(), ADMIN);
    // Publishing raises the console's revision; the publication is of that revision.
    expect(published.published).toMatchObject({ revision: published.revision, publishedBy: ADMIN });
    expect(published.revision).toBe(String(BigInt(draft.revision) + 1n));
    expect(stores.storage.consoles.get(draft.id)!.published).toMatchObject({ revision: published.revision, publishedBy: ADMIN });
  });

  it.for([
    ["an incompatible binding (a Wiki binding on a board)", { dataBinding: { resource: "knowledge/wiki", ref: BOARD_REF, schemaVersion: 1 } }],
    ["an invalid binding (an unknown schema version)", { dataBinding: { resource: "project/board", ref: BOARD_REF, schemaVersion: 2 } }],
    ["a binding naming another reference than its widget", { dataBinding: { resource: "project/board", ref: "inferops://acme.sales/project/board/X", schemaVersion: 1 } }],
    ["a bad reference", { targetRef: "https://example.com/board", dataBinding: { resource: "project/board", ref: "https://example.com/board", schemaVersion: 1 } }],
  ] as const)("refuses a screen with %s, publishing nothing", ([, patch]) => {
    const stores = setUp();
    const good = stores.canvases.create(screenContent("Good"));
    const bad = stores.canvases.create(screenContent("Bad"));
    tamper(stores.storage, bad.id, patch);
    const draft = stores.consoles.create(consoleOver(good.id, bad.id));
    const capture = stores.consoles.capture(draft.id, draft.revision);
    expect(() => stores.consoles.publish(draft.id, draft.revision, capture, new Map(), ADMIN))
      .toThrow(`Screen ${bad.id} can't be published`);
    // No partial release: not even the good screen is copied.
    nothingPublished(stores, draft.id, good.id, draft.revision);
    expect(stores.consoles.screen(draft.id, bad.id, "published")).toBeNull();
  });

  it("refuses a stale draft revision, publishing nothing", () => {
    const stores = setUp();
    const screen = stores.canvases.create(screenContent("Triage"));
    const draft = stores.consoles.create(consoleOver(screen.id));
    const capture = stores.consoles.capture(draft.id, draft.revision);
    const moved = stores.consoles.replace(draft.id, draft.revision, consoleOver(screen.id));
    expect(() => stores.consoles.publish(draft.id, draft.revision, capture, new Map(), ADMIN)).toThrow();
    nothingPublished(stores, draft.id, screen.id, moved.revision);
  });
});

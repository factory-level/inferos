// A published console's widget as a Wiki page embeds it (FAC-12): resolved by its source gadget to
// the current publication's frozen install, or why there is none in fixed words; and the instances
// of one widget definition the publications offer (FAC-13), named the same way. Over mock
// Durable Object storage holding a stored publication; the authority around it (who may resolve
// and open it) is integration-tests' wiki-embedded-widget.test.ts.
import { describe, expect, it } from "vitest";
import type { ConsoleWidgetEntry, OperateConsole } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const ENV = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" } as never;

const widget = (sourceGadgetId: number, gadgetId: number, ui: boolean): ConsoleWidgetEntry => ({
  gadgetId, blueprintId: `bp${sourceGadgetId}`, version: 3, label: `W${sourceGadgetId}`, state: "resettable",
  frozen: { sourceGadgetId, commitId: "c".repeat(40), ui },
});

/** A console `id` titled `title` whose content lists `widgets`, published at revision 4 when asked. */
function putConsole(storage: ReturnType<typeof makeOverseerStorage>, id: string, title: string,
    widgets: ConsoleWidgetEntry[], published: boolean) {
  let content = { title, fullChat: "off" as const, views: [], widgets };
  storage.consoles.put({ ...content, id, revision: "4",
    published: published ? { revision: "4", publishedAt: "2026-11-06T00:00:00.000Z", content, screens: [], apps: [] } : null,
  } as unknown as OperateConsole);
}

/** Frozen install `gadgetId`, made for console `consoleId`'s revision 4 from `sourceGadgetId`. */
function putFrozen(storage: ReturnType<typeof makeOverseerStorage>, gadgetId: number, sourceGadgetId: number, consoleId: string) {
  storage.gadgets.put({ type: "gadget", id: gadgetId, title: `F${gadgetId}`, created: new Date(0), bindingName: `F${gadgetId}`,
    frozenFor: { consoleId, revision: "4", sourceGadgetId } } as never);
}

function storeWith(published: boolean) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  putConsole(storage, "floor", "Floor", [widget(1, 101, true), widget(2, 102, false)], published);
  return new WorkspaceConsoleStore(durable, storage, ENV);
}

describe("a console widget embedded in a Wiki page (FAC-12)", () => {
  it("resolves its source gadget to the current publication's frozen install", () => {
    expect(storeWith(true).embeddedWidget("floor", 1)).toEqual({ status: "available", consoleId: "floor", revision: "4",
      gadgetId: 101, label: "W1", blueprintId: "bp1", version: 3 });
  });

  it("says why there is none: not published, not listed, or no UI to show", () => {
    expect(storeWith(false).embeddedWidget("floor", 1)).toEqual({ status: "unavailable", reason: "not-published" });
    expect(storeWith(true).embeddedWidget("other", 1)).toEqual({ status: "unavailable", reason: "not-published" });
    // Its frozen install id is not a source gadget, so it names nothing.
    expect(storeWith(true).embeddedWidget("floor", 101)).toEqual({ status: "unavailable", reason: "not-offered" });
    expect(storeWith(true).embeddedWidget("floor", 2)).toEqual({ status: "unavailable", reason: "no-ui" });
  });
});

/** An entry of the one definition `bp` version 3 that the instance tests ask for. */
const same = (sourceGadgetId: number, gadgetId: number, ui = true): ConsoleWidgetEntry =>
  ({ ...widget(sourceGadgetId, gadgetId, ui), blueprintId: "bp", label: `W${sourceGadgetId}` });

/** A workspace whose consoles list `bp` in every way a listing must and must not show. */
function workspace() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  // Desk lists the definition twice; Bay once and once without a UI; Draft only in a draft; Old
  // from before installs were frozen; Other another definition, and a version the search didn't name.
  putConsole(storage, "desk", "Desk", [same(0, 100), same(2, 102)], true);
  putConsole(storage, "bay", "Bay", [same(3, 103), same(4, 104, false)], true);
  putConsole(storage, "draft", "Draft", [same(5, 105)], false);
  putConsole(storage, "old", "Old", [{ gadgetId: 106, blueprintId: "bp", version: 3, label: "W6", state: "resettable" }], true);
  putConsole(storage, "other", "Other", [widget(7, 107, true), { ...same(8, 108), version: 4 }], true);
  // Stale: listed by its publication, but its install was made for another revision.
  putConsole(storage, "stale", "Stale", [same(9, 109)], true);
  for (let [gadgetId, source, consoleId] of [[100, 0, "desk"], [102, 2, "desk"], [103, 3, "bay"], [104, 4, "bay"],
      [105, 5, "draft"], [107, 7, "other"], [108, 8, "other"]] as const) putFrozen(storage, gadgetId, source, consoleId);
  storage.gadgets.put({ type: "gadget", id: 109, title: "F109", created: new Date(0), bindingName: "F109",
    frozenFor: { consoleId: "stale", revision: "3", sourceGadgetId: 9 } } as never);
  return new WorkspaceConsoleStore(durable, storage, ENV);
}

describe("the instances of one widget definition (FAC-13)", () => {
  it("lists each published frozen install of it with a UI, named as an embed names it, by console then label", () => {
    expect(workspace().widgetInstances("bp", 3)).toEqual([
      { consoleId: "bay", consoleTitle: "Bay", revision: "4", sourceGadgetId: 3, gadgetId: 103, label: "W3", blueprintId: "bp", version: 3 },
      // Gadget ids start at 0: the workspace's first gadget is listed too.
      { consoleId: "desk", consoleTitle: "Desk", revision: "4", sourceGadgetId: 0, gadgetId: 100, label: "W0", blueprintId: "bp", version: 3 },
      { consoleId: "desk", consoleTitle: "Desk", revision: "4", sourceGadgetId: 2, gadgetId: 102, label: "W2", blueprintId: "bp", version: 3 },
    ]);
  });

  it("lists nothing for another version or definition, and never a draft's, a tools-only one or a stale install", () => {
    expect(workspace().widgetInstances("bp", 4)).toEqual([
      expect.objectContaining({ consoleId: "other", gadgetId: 108, version: 4 })]);
    expect(workspace().widgetInstances("bp7", 3)).toEqual([expect.objectContaining({ consoleId: "other", gadgetId: 107 })]);
    expect(workspace().widgetInstances("bp", 2)).toEqual([]);
    expect(workspace().widgetInstances("missing", 3)).toEqual([]);
    let ids = workspace().widgetInstances("bp", 3).map(instance => instance.gadgetId);
    expect(ids).not.toContain(104);
    expect(ids).not.toContain(105);
    expect(ids).not.toContain(106);
    expect(ids).not.toContain(109);
  });
});

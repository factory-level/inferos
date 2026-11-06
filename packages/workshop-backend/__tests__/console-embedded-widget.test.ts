// A published console's widget as a Wiki page embeds it (FAC-12): resolved by its source gadget to
// the current publication's frozen install, or why there is none in fixed words. Over mock
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

function storeWith(published: boolean) {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  let content = { title: "Floor", fullChat: "off" as const, views: [], widgets: [widget(1, 101, true), widget(2, 102, false)] };
  let stored = { ...content, id: "floor", revision: "4",
    published: published ? { revision: "4", publishedAt: "2026-11-06T00:00:00.000Z", content, screens: [], apps: [] } : null,
  } as unknown as OperateConsole;
  storage.consoles.put(stored);
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

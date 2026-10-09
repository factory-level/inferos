import { describe, expect, it } from "vitest";
import {
  canonicalHostBoardTarget,
  consoleEventMismatch,
  consoleScreens,
  MAX_CONSOLE_VIEWS,
  MAX_CONSOLE_WIDGETS,
  MAX_ROLLUP_SCREENS,
  parseOperateConsoleContent,
  publishedConsole,
  type ConsoleView,
  type ConsoleWidgetEntry,
  type OperateConsole,
  type OperateConsoleContent,
} from "@gadgets/workshop-shared/operate-console";
import type { OperateConsoleRun } from "@gadgets/workshop-shared/operate-session";
import { consoleWidgetRefusal } from "../src/console-store";
import type { GadgetRecord } from "../src/overseer";

const content = (views: ConsoleView[], extra: Partial<OperateConsoleContent> = {}): OperateConsoleContent =>
  ({ title: "Operations lead", views, fullChat: "available", ...extra });

const overview: ConsoleView = { id: "overview", title: "Overview", type: "rollup", screens: ["board", "activity"] };
const board: ConsoleView = { id: "board", title: "Board", type: "screen", screen: "board" };

describe("console content", () => {
  it("trims titles and keeps the menu order", () => {
    let parsed = parseOperateConsoleContent(content(
        [{ ...overview, title: "  Overview " }, board], { title: "  Operations lead  " }));
    expect(parsed.title).toBe("Operations lead");
    expect(parsed.views.map(view => view.title)).toEqual(["Overview", "Board"]);
  });

  it("lists every referenced screen once, in menu order", () => {
    expect(consoleScreens(content([overview, board]))).toEqual(["board", "activity"]);
  });

  it("rejects empty or oversized menus, duplicate view ids, and bad screens", () => {
    expect(() => parseOperateConsoleContent(content([]))).toThrow(/1-12 views/);
    let many = Array.from({ length: MAX_CONSOLE_VIEWS + 1 }, (_, i): ConsoleView =>
      ({ id: `v${i}`, title: `View ${i}`, type: "screen", screen: "board" }));
    expect(() => parseOperateConsoleContent(content(many))).toThrow(/1-12 views/);
    expect(() => parseOperateConsoleContent(content([board, board]))).toThrow(/used twice/);
    expect(() => parseOperateConsoleContent(content([{ ...overview, screens: [] }]))).toThrow(/rollup/);
    expect(() => parseOperateConsoleContent(content([{ ...overview,
      screens: Array.from({ length: MAX_ROLLUP_SCREENS + 1 }, (_, i) => `s${i}`) }]))).toThrow(/rollup/);
    expect(() => parseOperateConsoleContent(content([{ ...board, screen: "../x" }]))).toThrow(/canvas id/);
    expect(() => parseOperateConsoleContent(content([board], { title: " " }))).toThrow(/title/);
    expect(() => parseOperateConsoleContent(content([board],
        { fullChat: "sometimes" as OperateConsoleContent["fullChat"] }))).toThrow(/full chat/);
  });
});

it('retains independent customization flags, with old consoles remaining opt-out', () => {
  expect(parseOperateConsoleContent(content([board])).customization).toBeUndefined();
  const customization = { screens: true, widgets: false, tools: true, skills: false };
  expect(parseOperateConsoleContent(content([board], { customization })).customization).toEqual(customization);
  for (const key of Object.keys(customization)) {
    expect(() => parseOperateConsoleContent(content([board], {
      customization: { ...customization, [key]: "true" },
    }))).toThrow(/booleans/);
  }
});

describe("published consoles", () => {
  it("shows operators the published content and revision, and nothing before the first publish", () => {
    let draft: OperateConsole = { ...content([overview, board]), id: "c1", revision: "5", published: null };
    expect(publishedConsole(draft)).toBeNull();
    let published = { revision: "3", publishedAt: "2026-10-06T00:00:00.000Z", content: content([board], { title: "Old" }) };
    expect(publishedConsole({ ...draft, published })).toEqual({
      title: "Old", views: [board], fullChat: "available", id: "c1", revision: "3", published,
    });
  });
});

describe("console navigation against the current definition", () => {
  const saved: OperateConsole = { ...content([overview, board]), id: "c1", revision: "3", published: null };
  const run = (viewId: string, screenId: string | null = null, revision = "3"): OperateConsoleRun =>
    ({ workspaceId: "ws1", consoleId: "c1", title: "Operations lead", source: "published", revision,
      fullChat: "available", viewId, screenId });
  const open = { type: "openConsole", workspaceId: "ws1", consoleId: "c1", title: "Operations lead",
    source: "published", revision: "3", fullChat: "available", viewId: "overview" } as const;

  it("opens only at one of the console's views, with its current full chat setting", () => {
    expect(consoleEventMismatch(saved, null, open)).toBeNull();
    expect(consoleEventMismatch(saved, null, { ...open, viewId: "gone" })).toMatch(/not part of console/);
    expect(consoleEventMismatch(saved, null, { ...open, fullChat: "only" })).toMatch(/full chat/);
  });

  it("switches only to a view of the console", () => {
    expect(consoleEventMismatch(saved, run("overview"), { type: "openView", viewId: "board" })).toBeNull();
    expect(consoleEventMismatch(saved, run("overview"), { type: "openView", viewId: "gone" })).toMatch(/not part of console/);
  });

  it("shows only a screen of the shown view, and always allows going back to the view", () => {
    expect(consoleEventMismatch(saved, run("overview"), { type: "showScreen", screenId: "activity" })).toBeNull();
    expect(consoleEventMismatch(saved, run("board"), { type: "showScreen", screenId: "board" })).toBeNull();
    expect(consoleEventMismatch(saved, run("board"), { type: "showScreen", screenId: "activity" })).toMatch(/not part of view/);
    expect(consoleEventMismatch(saved, run("gone"), { type: "showScreen", screenId: "board" })).toMatch(/no longer part/);
    expect(consoleEventMismatch(saved, run("gone", "board"), { type: "showScreen", screenId: null })).toBeNull();
  });

  it("refuses navigation once the revision the session opened is no longer the one addressed", () => {
    expect(consoleEventMismatch(saved, null, { ...open, revision: "2" })).toMatch(/has changed/);
    expect(consoleEventMismatch(saved, run("overview", null, "2"), { type: "openView", viewId: "board" })).toMatch(/has changed/);
    expect(consoleEventMismatch(saved, run("overview", null, "2"), { type: "showScreen", screenId: "activity" })).toMatch(/has changed/);
    expect(consoleEventMismatch(saved, run("overview", "activity", "2"), { type: "showScreen", screenId: null })).toBeNull();
  });

  it("ignores events that are not console navigation", () => {
    expect(consoleEventMismatch(saved, run("overview"), { type: "closeConsole" })).toBeNull();
    expect(consoleEventMismatch(saved, run("overview"), { type: "showHome" })).toBeNull();
  });
});

describe("console widget registry", () => {
  const entry: ConsoleWidgetEntry = { gadgetId: 7, blueprintId: "bp", version: 2, label: " Status ", state: "resettable" };

  it("trims labels and drops a client's frozen origin, which only publication sets", () => {
    let parsed = parseOperateConsoleContent(content([board], {
      widgets: [{ ...entry, frozen: { sourceGadgetId: 1, commitId: "forged" } }],
    }));
    expect(parsed.widgets).toEqual([{ gadgetId: 7, blueprintId: "bp", version: 2, label: "Status", state: "resettable" }]);
    expect(parseOperateConsoleContent(content([board])).widgets).toBeUndefined();
  });

  it("rejects duplicate gadgets, too many entries, bad versions and other state declarations", () => {
    expect(() => parseOperateConsoleContent(content([board], { widgets: [entry, entry] }))).toThrow(/twice/);
    let many = Array.from({ length: MAX_CONSOLE_WIDGETS + 1 }, (_, i) => ({ ...entry, gadgetId: i }));
    expect(() => parseOperateConsoleContent(content([board], { widgets: many }))).toThrow(/at most/);
    expect(() => parseOperateConsoleContent(content([board], { widgets: [{ ...entry, version: 0 }] }))).toThrow(/version/);
    expect(() => parseOperateConsoleContent(content([board],
        { widgets: [{ ...entry, state: "kept" as ConsoleWidgetEntry["state"] }] }))).toThrow(/resettable/);
  });
});

describe("which gadgets a console may offer", () => {
  const install = { blueprintId: "bp", version: 2, kind: "widget" as const };
  const widget = (record: Partial<GadgetRecord>): GadgetRecord => ({
    type: "gadget", id: 7, title: "Status", created: new Date(0), bindingName: "STATUS", bindings: {},
    commitId: "c0", installedFrom: install, ...record,
  });
  const refusal = (record: GadgetRecord | undefined) => consoleWidgetRefusal(
      { gadgets: { get: (id: number) => id === 7 ? record : undefined } } as never,
      { gadgetId: 7, blueprintId: "bp", version: 2, label: "Status", state: "resettable" });

  it("offers a widget install at the registered version with no bindings", () => {
    expect(refusal(widget({}))).toBeNull();
  });

  it("refuses what is not that widget install", () => {
    expect(refusal(undefined)).toMatch(/not a gadget/);
    expect(refusal(widget({ pending: { chatId: 1 } }))).toMatch(/not a gadget/);
    expect(refusal(widget({ installedFrom: undefined }))).toMatch(/not a blueprint install/);
    expect(refusal(widget({ installedFrom: { ...install, kind: "app" } }))).toMatch(/app install, not a widget/);
    expect(refusal(widget({ installedFrom: { ...install, version: 1 } }))).toMatch(/version 1, not bp version 2/);
    expect(refusal(widget({ frozenFor: { consoleId: "c", revision: "1", sourceGadgetId: 3 } }))).toMatch(/frozen install/);
  });

  it("refuses durable state and any binding, including one added after install", () => {
    expect(refusal(widget({ installedFrom: { ...install, dataContract: 1 } }))).toMatch(/data contract/);
    expect(refusal(widget({ bindings: { DATA: { target: 9 } } }))).toMatch(/has bindings/);
    expect(refusal(widget({ bindings: { DATA: { target: 9, pending: { chatId: 2 } } } }))).toMatch(/has bindings/);
  });
});

describe("host board entries", () => {
  const entry = (target = "inferops://acme.operations/project/board/ENG", extra = {}) =>
    ({ kind: "host-board" as const, label: " Board ", requirement: { name: "board", resource: "inferops-board" as const, target }, ...extra });

  it("canonicalises the target and trims the label, keeping legacy widgets untouched", () => {
    let widget: ConsoleWidgetEntry = { gadgetId: 3, blueprintId: "bp", version: 1, label: "Status", state: "resettable" };
    let parsed = parseOperateConsoleContent(content([board], {
      widgets: [widget], hostBoards: [entry(" inferops://acme.operations/project/board/ENG/ ")] }));
    expect(parsed.widgets).toEqual([widget]);
    expect(parsed.hostBoards).toEqual([{ kind: "host-board", label: "Board",
      requirement: { name: "board", resource: "inferops-board", target: "inferops://acme.operations/project/board/ENG" } }]);
  });

  it("accepts only the common key subset: uppercase, 1 to 10 characters", () => {
    expect(canonicalHostBoardTarget("inferops://acme.operations/project/board/ENG10")).not.toBeNull();
    for (let bad of ["inferops://acme.operations/project/board/eng", "inferops://acme.operations/project/board/ABCDEFGHIJK",
        "inferops://Acme.operations/project/board/ENG", "inferops://acme/project/board/ENG",
        "inferops://acme.operations/project/dispatch/ENG", "https://acme.operations/project/board/ENG"]) {
      expect(canonicalHostBoardTarget(bad)).toBeNull();
      expect(() => parseOperateConsoleContent(content([board], { hostBoards: [entry(bad)] }))).toThrow(/target/);
    }
  });

  it("refuses duplicate ids or names, another resource, and too many entries in all", () => {
    expect(() => parseOperateConsoleContent(content([board], { hostBoards: [entry(), entry()] }))).toThrow(/named twice/);
    expect(() => parseOperateConsoleContent(content([board], { hostBoards: [
      entry(undefined, { id: "a" }), { ...entry(undefined, { id: "a" }), requirement: { ...entry().requirement, name: "other" } },
    ] }))).toThrow(/listed twice/);
    expect(() => parseOperateConsoleContent(content([board], { hostBoards: [
      { ...entry(), requirement: { ...entry().requirement, resource: "x" as "inferops-board" } }] }))).toThrow(/require/);
    let many = Array.from({ length: MAX_CONSOLE_WIDGETS + 1 }, (_, i) =>
      ({ ...entry(), requirement: { ...entry().requirement, name: `b${i}` } }));
    expect(() => parseOperateConsoleContent(content([board], { hostBoards: many }))).toThrow(/at most/);
  });
});

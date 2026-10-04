import { describe, expect, it } from "vitest";
import {
  consoleEventMismatch,
  consoleScreens,
  MAX_CONSOLE_VIEWS,
  MAX_ROLLUP_SCREENS,
  parseOperateConsoleContent,
  type ConsoleView,
  type OperateConsole,
  type OperateConsoleContent,
} from "@gadgets/workshop-shared/operate-console";
import type { OperateConsoleRun } from "@gadgets/workshop-shared/operate-session";

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

describe("console navigation against the current definition", () => {
  const saved: OperateConsole = { ...content([overview, board]), id: "c1", revision: "3" };
  const run = (viewId: string, screenId: string | null = null): OperateConsoleRun =>
    ({ workspaceId: "ws1", consoleId: "c1", title: "Operations lead", fullChat: "available", viewId, screenId });
  const open = { type: "openConsole", workspaceId: "ws1", consoleId: "c1", title: "Operations lead",
    fullChat: "available", viewId: "overview" } as const;

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

  it("ignores events that are not console navigation", () => {
    expect(consoleEventMismatch(saved, run("overview"), { type: "closeConsole" })).toBeNull();
    expect(consoleEventMismatch(saved, run("overview"), { type: "showHome" })).toBeNull();
  });
});

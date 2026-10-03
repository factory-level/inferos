import { describe, expect, it } from "vitest";
import {
  consoleScreens,
  MAX_CONSOLE_VIEWS,
  MAX_ROLLUP_SCREENS,
  parseOperateConsoleContent,
  type ConsoleView,
  type OperateConsoleContent,
} from "@gadgets/workshop-shared/operate-console";

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

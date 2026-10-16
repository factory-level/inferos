// @vitest-environment node
// The pure rules: freshness against the read time, counts with units, the empty predicates, the
// issue line, and load generations.
import { describe, expect, it } from "vitest";
import type { BoardData, RunbookData, SupportIssue } from "../files/lib/protocol.ts";
import {
  boardIsEmpty, finishLoad, formatCount, freshness, initialState, issueLine, runbookIsEmpty, STALE_AFTER_MS, startLoad,
} from "../files/lib/page.ts";

const READ_AT = "2026-10-12T12:00:00.000Z";
const before = (ms: number) => new Date(Date.parse(READ_AT) - ms).toISOString();
const issue = (over: Partial<SupportIssue> = {}): SupportIssue =>
  ({ identifier: "SUP-1", title: "Demo", priority: "none", targetDate: null, blockedReason: null, ...over });
const board = (...counts: number[]): BoardData => ({
  project: { identifier: "SUP", name: "Demo" },
  columns: counts.map((n, i) => ({ name: `C${i}`, group: "backlog", issues: Array.from({ length: n }, () => issue()) })),
});
const runbook = (sections: RunbookData["sections"]): RunbookData =>
  ({ slug: "s", title: "t", version: 1, editedAt: READ_AT, sections });

describe("freshness (P1)", () => {
  it("pins the thresholds: tiles 1 h, the board 15 min", () => {
    expect(STALE_AFTER_MS).toEqual({ tile: 3_600_000, board: 15 * 60_000 });
  });

  it.each(["tile", "board"] as const)("%s: exactly the threshold is fresh, 1 ms over is stale", region => {
    expect(freshness(region, before(STALE_AFTER_MS[region]), READ_AT).stale).toBe(false);
    expect(freshness(region, before(STALE_AFTER_MS[region] + 1), READ_AT).stale).toBe(true);
  });

  it("says how stale, against the page's read time", () => {
    expect(freshness("tile", before(3 * 3_600_000), READ_AT)).toEqual({
      stale: true, text: "Stale: last updated 2026-10-12T09:00:00.000Z, 3 hours before this page was read.",
    });
    expect(freshness("board", before(60_000), READ_AT))
      .toEqual({ stale: false, text: "Last updated 2026-10-12T11:59:00.000Z." });
  });
});

describe("formatCount (P2)", () => {
  it("shows units and never turns a missing figure into 0", () => {
    expect(formatCount(null, "person")).toBe("Unknown");
    expect(formatCount(0, "person")).toBe("0 people");
    expect(formatCount(1, "run")).toBe("1 run");
    expect(formatCount(6, "person")).toBe("6 people");
  });
});

describe("boardIsEmpty (P3)", () => {
  it("is true only when every column has no issue", () => {
    expect(boardIsEmpty(board(0, 0, 0, 0))).toBe(true);
    expect(boardIsEmpty(board(1, 0, 2, 1))).toBe(false);
    expect(boardIsEmpty(board(0, 0, 0, 1))).toBe(false);
  });
});

describe("issueLine (P4)", () => {
  it("is the identifier and title, the priority, then a due date and a block reason only when set", () => {
    expect(issueLine(issue({ identifier: "SUP-7", title: "Demo: a", priority: "none" })))
      .toEqual(["SUP-7  Demo: a", "No priority"]);
    expect(issueLine(issue({ identifier: "SUP-9", title: "Demo: b", priority: "urgent", targetDate: "2026-10-14",
      blockedReason: "Waiting" }))).toEqual(["SUP-9  Demo: b", "Urgent", "Due 2026-10-14", "Blocked: Waiting"]);
    expect(issueLine(issue({ priority: "high", blockedReason: "x" }))).toEqual(["SUP-1  Demo", "High", "Blocked: x"]);
  });
});

describe("runbookIsEmpty (P5)", () => {
  it("is true for no sections, or sections whose blocks are all blank", () => {
    expect(runbookIsEmpty(runbook([]))).toBe(true);
    expect(runbookIsEmpty(runbook([{ heading: "h", blocks: [{ kind: "paragraph", text: "  " },
      { kind: "steps", items: ["", " "] }] }]))).toBe(true);
  });

  it("is false for any non-blank paragraph or step", () => {
    expect(runbookIsEmpty(runbook([{ heading: "h", blocks: [{ kind: "paragraph", text: "Read." }] }]))).toBe(false);
    expect(runbookIsEmpty(runbook([{ heading: "h", blocks: [{ kind: "steps", items: ["", "Do."] }] }]))).toBe(false);
  });
});

describe("load generations (P6)", () => {
  it("clears the view on a new load and ignores an earlier load's answer", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    expect(second.view).toEqual({ kind: "loading" });
    const late = { ok: false, reason: "unknown-installation" } as const;
    expect(finishLoad(second, first.generation, late)).toBe(second);
    expect(finishLoad(second, second.generation, late).view).toEqual({ kind: "failed", result: late });
  });
});

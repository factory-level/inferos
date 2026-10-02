// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  failureCode, failureMessage, findIssue, moveTargets, sortIssues, withIssueMoved,
} from "../files/lib/board.ts";
import type { Board, Issue, State } from "../files/lib/protocol.ts";

const state = (id: string, workflow: State["workflow"] = "software"): State =>
  ({ id, name: id.toUpperCase(), group: "started", position: 0, workflow });
const issue = (id: string, stateId: string, extra: Partial<Issue> = {}): Issue => ({
  id, identifier: `DEMO-${id}`, title: id, priority: "medium", stateId, targetDate: null,
  workflow: "software", revision: "1", assigneeId: null, blockedReason: null, ...extra,
});

const board: Board = {
  project: { id: "p", identifier: "DEMO", name: "Demo" },
  columns: [
    { state: state("todo"), issues: [issue("1", "todo"), issue("2", "todo", { priority: "urgent" })] },
    { state: state("doing"), issues: [] },
    { state: state("draft", "content"), issues: [issue("3", "draft", { workflow: "content" })] },
  ],
};

describe("board rules", () => {
  it("offers only other states of the issue's own workflow", () => {
    expect(moveTargets(board, findIssue(board, "1")!.issue).map(s => s.id)).toEqual(["doing"]);
    expect(moveTargets(board, findIssue(board, "3")!.issue)).toEqual([]);
  });

  it("moves a card locally without touching the other columns", () => {
    const moved = withIssueMoved(board, "1", "doing");

    expect(moved.columns.map(c => c.issues.map(i => i.id))).toEqual([["2"], ["1"], ["3"]]);
    expect(findIssue(moved, "1")!.issue.stateId).toBe("doing");
  });

  it("sorts the most urgent first", () => {
    expect(sortIssues(board.columns[0]!.issues).map(i => i.id)).toEqual(["2", "1"]);
  });

  it("reads the gatekeeper's error code and strips it from the message", () => {
    const error = new Error("WORKFLOW_MISMATCH: DEMO-1 is a software issue.");

    expect(failureCode(error)).toBe("WORKFLOW_MISMATCH");
    expect(failureMessage(error)).toBe("DEMO-1 is a software issue.");
    expect(failureCode(new Error("network down"))).toBe("ERROR");
  });
});

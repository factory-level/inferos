// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  cellText, classify, finishLoad, initialState, linkCounts, startLoad,
} from "../files/lib/records.ts";
import type { LoadRowsResult, TableColumn, TableRecord } from "../files/lib/protocol.ts";

const COLUMN: TableColumn = { key: "c1", name: "serial", label: "Serial", type: "text", required: true };
const READY: LoadRowsResult = {
  ok: true,
  table: { label: "Assets", version: 3, columns: [COLUMN], relations: [] },
  records: [{ id: "r1", tableVersion: 3, values: { serial: "SN-1" }, links: [] }],
};

describe("load generations", () => {
  it("draws only the answer to the latest load", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    // The first load answers late, after the second began: ignored.
    expect(finishLoad(second, first.generation, READY)).toBe(second);
    expect(finishLoad(second, second.generation, READY).view).toEqual({ kind: "ready", result: READY });
  });

  it("clears rows when a load starts, and when a load fails", () => {
    const ready = finishLoad(startLoad(initialState), 1, READY);
    expect(startLoad(ready).view).toEqual({ kind: "loading" });
    const refused = finishLoad(startLoad(ready), 2, { ok: false, reason: "unavailable", message: "gone" });
    expect(refused.view).toEqual({ kind: "failed", ok: false, reason: "unavailable", message: "gone" });
  });
});

describe("refusals", () => {
  it("reads the code the gatekeeper leads with, and drops it from the message", () => {
    expect(classify(new Error("NOT_FOUND: No such table or row is available to you.")))
      .toEqual({ ok: false, reason: "unavailable", message: "No such table or row is available to you." });
    expect(classify(new Error("InferOpsError: UNAUTHORIZED: Your InferLab session has ended.")).reason)
      .toBe("unavailable");
    expect(classify(new Error("DISABLED: InferOps custom tables are turned off for this deployment.")).reason)
      .toBe("disabled");
    expect(classify(new Error("UNAVAILABLE: InferOps could not be reached.")).reason).toBe("error");
    expect(classify("boom")).toEqual({ ok: false, reason: "error", message: "boom" });
  });
});

describe("cells", () => {
  it("shows values as written, booleans as Yes/No and no value as empty", () => {
    const record: TableRecord = { id: "r", tableVersion: 1, links: [],
      values: { serial: "SN-1", hours: 12, ok: false, none: null } };
    expect(cellText(record, COLUMN)).toBe("SN-1");
    expect(cellText(record, { ...COLUMN, name: "hours", type: "integer" })).toBe("12");
    expect(cellText(record, { ...COLUMN, name: "ok", type: "boolean" })).toBe("No");
    expect(cellText(record, { ...COLUMN, name: "none" })).toBe("");
    expect(cellText(record, { ...COLUMN, name: "absent" })).toBe("");
  });

  it("counts links per relation", () => {
    const record: TableRecord = { id: "r", tableVersion: 1, values: {}, links: [
      { relation: "work", toKind: "project/issue", ref: "inferops://a.b/project/issue-link/1" },
      { relation: "work", toKind: "project/issue", ref: "inferops://a.b/project/issue-link/2" },
    ] };
    expect([...linkCounts(record)]).toEqual([["work", 2]]);
  });
});

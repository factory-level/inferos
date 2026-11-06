// FAC-9: the governed data contract a Refine provider reads and writes through. Requests are
// validated against the resource's own description before anything is read: a closed set of
// filter operators on declared, non-personal fields, one sort key, bounded pages, and a cursor
// bound to the request that made it. Listing runs on the server over a bounded snapshot.
import { describe, expect, it } from "vitest";
import {
  GOVERNED_PAGE_MAX, GOVERNED_SNAPSHOT_MAX, GovernedRequestError, listGoverned, parseGovernedListRequest,
  type GovernedDescription, type GovernedRow,
} from "./governed-data.js";

const DESCRIPTION: GovernedDescription = {
  resource: "object/table",
  fields: [
    { name: "name", label: "Name", type: "text", filterable: true, sortable: true },
    { name: "units", label: "Units", type: "number", filterable: true, sortable: true },
    { name: "email", label: "Email", type: "text", filterable: false, sortable: false, personal: true },
  ],
  commands: [],
};

const rows = (n: number): GovernedRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, values: { name: `Item ${i % 7}`, units: i, email: `p${i}@example.com` } }));

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GovernedRequestError ? error.code : `not a refusal: ${String(error)}`;
  }
  return "accepted";
};

describe("a governed list request (FAC-9)", () => {
  it("accepts filters, one sort key and a page size within the resource's declared fields", () => {
    expect(parseGovernedListRequest({
      filters: [{ field: "name", op: "contains", value: "item" }, { field: "units", op: "eq", value: 3 }],
      sort: { field: "units", order: "desc" }, pageSize: 10,
    }, DESCRIPTION)).toEqual({
      filters: [{ field: "name", op: "contains", value: "item" }, { field: "units", op: "eq", value: 3 }],
      sort: { field: "units", order: "desc" }, pageSize: 10,
    });
    expect(parseGovernedListRequest({}, DESCRIPTION)).toEqual({ filters: [], pageSize: 25 });
  });

  it("refuses, before anything is read, what the contract doesn't offer", () => {
    for (const [request, code] of [
      [{ filters: [{ field: "email", op: "eq", value: "p1@example.com" }] }, "FIELD_NOT_FILTERABLE"],
      [{ filters: [{ field: "missing", op: "eq", value: 1 }] }, "FIELD_NOT_FILTERABLE"],
      [{ filters: [{ field: "name", op: "startsWith", value: "I" }] }, "OPERATOR_NOT_ALLOWED"],
      [{ filters: [{ field: "name", op: "eq", value: { $ne: 1 } }] }, "INVALID_REQUEST"],
      [{ sort: { field: "email", order: "asc" } }, "FIELD_NOT_SORTABLE"],
      [{ sort: [{ field: "name", order: "asc" }, { field: "units", order: "asc" }] }, "INVALID_REQUEST"],
      [{ pageSize: GOVERNED_PAGE_MAX + 1 }, "INVALID_REQUEST"],
      [{ pageSize: 0 }, "INVALID_REQUEST"],
      [{ meta: { url: "https://example.com" } }, "INVALID_REQUEST"],
      [{ url: "https://example.com", method: "DELETE" }, "INVALID_REQUEST"],
      [{ filters: Array.from({ length: 5 }, () => ({ field: "name", op: "eq", value: "x" })) }, "INVALID_REQUEST"],
    ] as const) {
      expect(refusal(() => parseGovernedListRequest(request, DESCRIPTION)), JSON.stringify(request)).toBe(code);
    }
  });
});

describe("listing a governed resource on the server (FAC-9)", () => {
  it("filters, sorts and pages a snapshot, the cursor continuing exactly where the last page ended", () => {
    let request = parseGovernedListRequest({ filters: [{ field: "name", op: "eq", value: "Item 3" }], sort: { field: "units", order: "desc" }, pageSize: 2 }, DESCRIPTION);
    let first = listGoverned(rows(30), request);
    expect(first.rows.map(r => r.values.units)).toEqual([24, 17]);
    expect(first.total).toBe(4);
    let second = listGoverned(rows(30), { ...request, cursor: first.nextCursor! });
    expect(second.rows.map(r => r.values.units)).toEqual([10, 3]);
    expect(second.nextCursor).toBeNull();
  });

  it("matches `contains` case-insensitively, and never on a field it wasn't asked about", () => {
    let request = parseGovernedListRequest({ filters: [{ field: "name", op: "contains", value: "ITEM 6" }] }, DESCRIPTION);
    expect(listGoverned(rows(14), request).rows.map(r => r.values.units)).toEqual([6, 13]);
  });

  it("refuses a cursor made for another request, or not made here", () => {
    let page = listGoverned(rows(30), parseGovernedListRequest({ pageSize: 5 }, DESCRIPTION));
    let other = parseGovernedListRequest({ pageSize: 5, sort: { field: "units", order: "desc" } }, DESCRIPTION);
    expect(refusal(() => listGoverned(rows(30), { ...other, cursor: page.nextCursor! }))).toBe("INVALID_CURSOR");
    expect(refusal(() => listGoverned(rows(30), { ...other, cursor: "not-a-cursor" }))).toBe("INVALID_CURSOR");
  });

  it("reads at most the snapshot's bound, and says when it was cut", () => {
    let result = listGoverned(rows(GOVERNED_SNAPSHOT_MAX + 30), parseGovernedListRequest({ pageSize: 50 }, DESCRIPTION));
    expect(result.total).toBe(GOVERNED_SNAPSHOT_MAX);
    expect(result.truncated).toBe(true);
    expect(listGoverned(rows(10), parseGovernedListRequest({}, DESCRIPTION)).truncated).toBe(false);
  });
});

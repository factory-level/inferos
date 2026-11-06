import { describe, expect, it } from "vitest";
import { parseServiceQuery, serviceQuerySearch } from "../src/service-queries";

const PROJECT = "91000000-0000-4000-8000-000000000001";
const ID = "91000000-0000-4000-8000-000000000002";
const row = { id: ID, identifier: "SVC-1", title: "Repair", projectId: PROJECT, headSeq: "10", relatedTruncated: false,
  state: { id: ID, name: "Open", group: "unstarted" }, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z",
  customers: [{ id: ID, label: "Synthetic customer", secret: "omit" }], sites: [], contacts: [], secret: "omit" };

describe("published service query boundary", () => {
  it("uses queryVersion and refuses a caller's attempted project override", () => {
    expect(serviceQuerySearch("service-jobs").get("queryVersion")).toBe("1");
    expect(() => serviceQuerySearch("service-jobs", { projectId: ID } as never)).toThrow("INVALID_REQUEST");
    expect(() => serviceQuerySearch("DROP TABLE" as never)).toThrow("INVALID_REQUEST");
  });
  it("projects fields and refuses another project's job", () => {
    const value = { name: "service-jobs", version: 1, rows: [row], nextCursor: null };
    expect(JSON.stringify(parseServiceQuery(value, "service-jobs", PROJECT))).not.toContain("secret");
    expect(() => parseServiceQuery(value, "service-jobs", ID)).toThrow("UNAVAILABLE");
  });
  it("refuses malformed and negative aggregates instead of displaying zero", () => {
    expect(() => parseServiceQuery({ name: "service-job-status-counts", version: 1, rows: [{ group: "started", count: -1 }], nextCursor: null }, "service-job-status-counts", PROJECT)).toThrow("UNAVAILABLE");
    expect(() => parseServiceQuery({}, "service-jobs", PROJECT)).toThrow("UNAVAILABLE");
  });
});

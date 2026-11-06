import { InferOpsError } from "./inferops-client";
import type { ServiceQueryName, ServiceQueryOptions, ServiceQueryPage, ServiceRelation } from "./types";

const NAMES = new Set(["service-jobs", "service-job-status-counts", "service-job-recent-activities"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new InferOpsError("UNAVAILABLE", "InferOps returned an invalid service query result.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 20_000): string {
  if (typeof value !== "string" || value.length > maximum) throw invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 36);
  if (!UUID.test(result)) throw invalid();
  return result;
}
function relations(value: unknown): ServiceRelation[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  return value.map(entry => { const row = object(entry); return { id: id(row.id), label: text(row.label, 500) }; });
}

/** Validate before any HTTP call. Scope is always injected by the bound project, never options. */
export function serviceQuerySearch(name: ServiceQueryName, options: ServiceQueryOptions = {}): URLSearchParams {
  if (!NAMES.has(name) || Object.keys(options).some(key => key !== "limit" && key !== "cursor")) {
    throw new InferOpsError("INVALID_REQUEST", "Only published service queries and cursor options are accepted.");
  }
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length > 4096))) {
    throw new InferOpsError("INVALID_REQUEST", "Invalid service query page options.");
  }
  const query = new URLSearchParams({ queryVersion: "1", limit: String(limit) });
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  return query;
}

/** Project each result field and reject a job from outside the connection's fixed project. */
export function parseServiceQuery(value: unknown, name: ServiceQueryName, projectId: string): ServiceQueryPage {
  const page = object(value);
  if (page.name !== name || page.version !== 1 || !Array.isArray(page.rows) || page.rows.length > 100) throw invalid();
  const nextCursor = page.nextCursor === null ? null : text(page.nextCursor, 4096);
  if (name === "service-jobs") {
    const rows = page.rows.map(value => {
      const row = object(value); const state = object(row.state);
      if (row.projectId !== projectId || typeof row.relatedTruncated !== "boolean") throw invalid();
      return { id: id(row.id), identifier: text(row.identifier, 100), title: text(row.title, 500), projectId,
        headSeq: text(row.headSeq, 30), relatedTruncated: row.relatedTruncated,
        state: { id: id(state.id), name: text(state.name, 200), group: text(state.group, 50) },
        createdAt: text(row.createdAt, 64), updatedAt: text(row.updatedAt, 64),
        customers: relations(row.customers), sites: relations(row.sites), contacts: relations(row.contacts) };
    });
    return { name, version: 1, rows, nextCursor };
  }
  if (name === "service-job-status-counts") {
    const rows = page.rows.map(value => {
      const row = object(value);
      if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) throw invalid();
      return { group: text(row.group, 50), count: row.count };
    });
    return { name, version: 1, rows, nextCursor };
  }
  const rows = page.rows.map(value => {
    const row = object(value);
    return { id: id(row.id), jobId: id(row.jobId), kind: text(row.kind, 50),
      body: row.body === null ? null : text(row.body), createdAt: text(row.createdAt, 64) };
  });
  return { name, version: 1, rows, nextCursor };
}

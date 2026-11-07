/** Published service queries; arbitrary SQL is never accepted. */
export type ServiceQueryName = "service-jobs" | "service-job-status-counts" | "service-job-recent-activities";
/** Cursor traversal of the permitted collection, at most 100 rows per call. */
export interface ServiceQueryOptions { limit?: number; cursor?: string; }
/** One permitted relation endpoint, with a nonpersonal display label. */
export interface ServiceRelation { id: string; label: string; }
/** A service job and the permitted company records related to it. */
export interface ServiceJob {
  id: string; identifier: string; title: string; projectId: string; headSeq: string; relatedTruncated: boolean;
  state: { id: string; name: string; group: string };
  createdAt: string; updatedAt: string;
  customers: ServiceRelation[]; sites: ServiceRelation[]; contacts: ServiceRelation[];
}
/** A count of permitted jobs in one workflow group. */
export interface ServiceStatusCount { group: string; count: number; }
/** One recent activity on a permitted service job. */
export interface ServiceActivity { id: string; jobId: string; kind: string; body: string | null; createdAt: string; }
/** A versioned query result. A non-null cursor means there are further rows. */
export type ServiceQueryPage =
  | { name: "service-jobs"; version: 1 | 2; rows: ServiceJob[]; nextCursor: string | null }
  | { name: "service-job-status-counts"; version: 1 | 2; rows: ServiceStatusCount[]; nextCursor: string | null }
  | { name: "service-job-recent-activities"; version: 1 | 2; rows: ServiceActivity[]; nextCursor: string | null };

/** The narrow project capability this dashboard uses. */
export interface ServiceProject {
  readServiceQuery(name: ServiceQueryName, options?: ServiceQueryOptions): Promise<ServiceQueryPage>;
  openIssue(id: string): Promise<{ comment(body: string, expectedRevision: string): Promise<void>; [Symbol.dispose](): void }>;
}
/** Result states preserve denied/unavailable versus empty data. */
export type QueryResult = { ok: true; page: ServiceQueryPage } | { ok: false; reason: "not-connected" | "denied" | "unavailable" };
/** The gadget stores no business data; every read uses the current project capability. */
export interface GadgetStub {
  query(name: ServiceQueryName, cursor?: string): Promise<QueryResult>;
  comment(jobId: string, body: string, headSeq: string): Promise<{ ok: boolean }>;
}

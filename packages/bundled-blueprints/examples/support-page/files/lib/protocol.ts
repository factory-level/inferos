// The contract between this gadget's client and its Durable Object. Imported type-only, so nothing
// of it ships. Every figure, issue and runbook line is synthetic demo data from ./fixture.ts:
// nothing here is read from InferOps, InferMind, Analytics Engine or any account.

/** One demo installation: a name and an id, nothing else. */
export interface DemoInstallation {
  installationId: string;
  installationName: string;
}

/** What a live region would be shaped like, for the label only. Nothing here reads it. */
export type ModelledOn = "activity/v1" | "project_issue_runs" | "inferops.project-board" | "inferops.wiki";

/** Where a region's figures came from, and when they were last brought up to date. */
interface RegionMeta {
  source: "demo-fixture";
  modelledOn: ModelledOn;
  /** ISO 8601 UTC. */
  asOf: string;
}

/** Every region is reported, refused or failed. Only `reported` carries data, a window or an asOf. */
export type Region<T, Extra = never> =
  | ({ state: "reported" } & RegionMeta & { data: T })
  | { state: "denied"; source: "demo-fixture"; modelledOn: ModelledOn }
  | { state: "unavailable"; source: "demo-fixture"; modelledOn: ModelledOn; message: string }
  | Extra;

/** A tile's figure over its window; null = not reported (drawn "Unknown"), never 0. */
export interface TileData {
  window: { from: string; to: string };
  count: number | null;
}

export type IssuePriority = "urgent" | "high" | "medium" | "low" | "none";

/** The Kanban's issue projection minus id, stateId, revision, workflow and assigneeId. */
export interface SupportIssue {
  /** "SUP-12". */
  identifier: string;
  title: string;
  priority: IssuePriority;
  /** YYYY-MM-DD. */
  targetDate: string | null;
  blockedReason: string | null;
}

export type ColumnGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export interface BoardData {
  project: { identifier: string; name: string };
  /** Columns in board position order. */
  columns: Array<{ name: string; group: ColumnGroup; issues: SupportIssue[] }>;
}

export type RunbookBlock = { kind: "paragraph"; text: string } | { kind: "steps"; items: string[] };

/** One Wiki page, drawn as text: no Markdown, HTML or links are interpreted. */
export interface RunbookData {
  slug: string;
  title: string;
  version: number;
  editedAt: string;
  sections: Array<{ heading: string; blocks: RunbookBlock[] }>;
}

export type RunbookMissing = { state: "missing"; source: "demo-fixture"; modelledOn: "inferops.wiki"; slug: string };

export interface SupportPage {
  installation: DemoInstallation;
  /** The demo's deterministic "now": staleness is measured against it, never against the wall clock. */
  readAt: string;
  peopleActiveToday: Region<TileData>;
  runsFailed24h: Region<TileData>;
  board: Region<BoardData>;
  runbook: Region<RunbookData, RunbookMissing>;
  // Deliberately no field for "actions rejected" or "median time to decision": no source exists.
}

/** One load of one installation's page, or why there is none. */
export type LoadSupportPageResult =
  | ({ ok: true } & SupportPage)
  | { ok: false; reason: "unknown-installation" }
  | { ok: false; reason: "unavailable"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  listInstallations(): Promise<DemoInstallation[]>;
  loadSupportPage(installationId: string): Promise<LoadSupportPageResult>;
}

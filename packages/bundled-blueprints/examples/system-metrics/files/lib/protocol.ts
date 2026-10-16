// The contract between this gadget's client and its Durable Object. Imported type-only, so nothing
// of it ships. Every figure is synthetic demo data from ./fixture.ts: nothing here is read from an
// Analytics Engine dataset, InferOps, Workers Observability or any Cloudflare account.

/** One demo installation. Installation totals only: no person, actor id, session or workspace row. */
export interface DemoInstallation {
  installationId: string;
  installationName: string;
}

/** What a live panel would be shaped like, for the label only. Nothing here reads it. */
export type ModelledOn = "activity/v1" | "project_issue_runs" | "workers-observability";

/** Every panel reports its own provenance; the source is always the fixture. */
interface PanelMeta {
  source: "demo-fixture";
  modelledOn: ModelledOn;
  /** ISO 8601 UTC. */
  window: { from: string; to: string };
  /** When the figures were last brought up to date (ISO 8601). */
  asOf: string;
}

/** A panel is reported (possibly with no entries) or unavailable. Unavailable carries no figures. */
export type Panel<T> =
  | ({ state: "reported" } & PanelMeta & { data: T })
  | { state: "unavailable"; source: "demo-fixture"; modelledOn: ModelledOn; message: string };

/** The `activity/v1` event types this view counts (a subset of ACTIVITY_EVENT_TYPES). */
export type ActivityEventType =
  | "user.authenticated" | "workspace.opened" | "gadget.created" | "connection.created" | "connection.removed";

/** Counts are integers; `null` = not reported (drawn "Unknown"), never 0. */
export interface ActivityData {
  /** Distinct people active in the window (actor copies, sys_unattributed excluded). */
  activePeople: number | null;
  /** One row per event type shown. */
  events: Array<{ eventType: ActivityEventType; count: number | null }>;
}

/** The InferOps run lifecycle statuses (run.dto.ts RUN_STATUSES). */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

/** Coding runs requested in the window, by lifecycle status. All six keys always present. */
export interface RunsData {
  byStatus: Record<RunStatus, number | null>;
}

/** Per Worker of the installation, over a window of at most seven days. */
export interface HealthData {
  workers: Array<{ worker: string; requests: number | null; errors: number | null; p95WallTimeMs: number | null }>;
}

export interface InstallationMetrics {
  installation: DemoInstallation;
  activity: Panel<ActivityData>;
  runs: Panel<RunsData>;
  health: Panel<HealthData>;
}

/** One load of one installation's metrics, or why there is none. */
export type LoadMetricsResult =
  | ({ ok: true } & InstallationMetrics)
  | { ok: false; reason: "unknown-installation" }
  | { ok: false; reason: "unavailable"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  listInstallations(): Promise<DemoInstallation[]>;
  loadMetrics(installationId: string): Promise<LoadMetricsResult>;
}

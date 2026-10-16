// The System metrics gadget's pure rules: when each panel is stale, totals that never invent a
// figure, the error rate, how counts read, when a panel is empty, and which load answer is current.
// No DOM and no I/O, so both sides and the tests share them.

import type {
  ActivityData, ActivityEventType, HealthData, LoadMetricsResult, RunsData, RunStatus,
} from "./protocol.ts";

export type PanelKind = "activity" | "runs" | "health";

/**
 * A panel is stale when it was last updated more than this long before its window's end. Demo
 * engineering choices, not owner policy: activity is rolled up daily, runs and health are near-live.
 */
export const STALE_AFTER_MS: Readonly<Record<PanelKind, number>> = {
  activity: 24 * 60 * 60 * 1000,
  runs: 60 * 60 * 1000,
  health: 15 * 60 * 1000,
};

/** The activity rows, in the order the view draws them. */
export const ACTIVITY_EVENTS: readonly ActivityEventType[] = [
  "user.authenticated", "workspace.opened", "gadget.created", "connection.created", "connection.removed",
];

/** The run statuses in the InferOps order, each with the one line the view shows. */
export const RUN_STATUSES: ReadonlyArray<{ status: RunStatus; meaning: string }> = [
  { status: "queued", meaning: "Waiting for a runner to pick it up." },
  { status: "running", meaning: "A runner has it." },
  { status: "succeeded", meaning: "The runner reported success." },
  { status: "failed", meaning: "The runner reported failure." },
  { status: "cancelled", meaning: "Cancelled before it finished." },
  { status: "unknown", meaning: "Runner never reported back; the run may have changed things. Not counted as failed." },
];

/** Whether a panel is stale against its window's end (never the wall clock), and its freshness line. */
export function freshness(panel: PanelKind, asOf: string, windowTo: string): { stale: boolean; text: string } {
  const lag = Date.parse(windowTo) - Date.parse(asOf);
  const stale = lag > STALE_AFTER_MS[panel];
  const hours = Math.round(lag / 3_600_000);
  return {
    stale,
    text: stale
      ? `Stale: last updated ${asOf}, ${hours} hours before the end of the window.`
      : `Last updated ${asOf}.`,
  };
}

/** The runs total: the sum only when every status is reported, else `null` with how many are not. */
export function runTotal(data: RunsData): { runs: number | null; missing: number } {
  const counts = RUN_STATUSES.map(({ status }) => data.byStatus[status]);
  const missing = counts.filter(count => count === null).length;
  return { runs: missing === 0 ? counts.reduce<number>((sum, count) => sum + (count as number), 0) : null, missing };
}

/** Errors over requests to one decimal; "No requests" when there were none; "Unknown" when either is missing. */
export function errorRate(errors: number | null, requests: number | null): string {
  if (errors === null || requests === null) return "Unknown";
  if (requests === 0) return "No requests";
  return `${((errors / requests) * 100).toFixed(1)} %`;
}

const COUNT = new Intl.NumberFormat("en-US");
const PLURAL: Record<string, string> = { person: "people" };

/** A count with its unit ("48,210 requests", "1 run"), or "Unknown" — never "0" for a missing figure. */
export function formatCount(count: number | null, unit: string): string {
  if (count === null) return "Unknown";
  return `${COUNT.format(count)} ${count === 1 ? unit : (PLURAL[unit] ?? `${unit}s`)}`;
}

/** A duration in milliseconds, or "Unknown". */
export function formatMs(ms: number | null): string {
  return ms === null ? "Unknown" : `${COUNT.format(ms)} ms`;
}

/**
 * Strictly empty: a reported panel in which nothing happened. Any `null` makes it NOT empty,
 * because "nothing happened" cannot be claimed when part of the figure was not reported.
 */
export function isEmpty(panel: "activity", data: ActivityData): boolean;
export function isEmpty(panel: "runs", data: RunsData): boolean;
export function isEmpty(panel: "health", data: HealthData): boolean;
export function isEmpty(panel: PanelKind, data: ActivityData | RunsData | HealthData): boolean {
  if (panel === "activity") {
    const activity = data as ActivityData;
    return activity.activePeople === 0 && activity.events.every(e => e.count === 0);
  }
  if (panel === "runs") return Object.values((data as RunsData).byStatus).every(count => count === 0);
  return (data as HealthData).workers.length === 0;
}

/** What the gadget shows. Only `ready` holds figures; every other state holds none. */
export type View =
  | { kind: "loading" }
  | { kind: "failed"; result: Extract<LoadMetricsResult, { ok: false }> }
  | { kind: "ready"; result: Extract<LoadMetricsResult, { ok: true }> };

export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/** Start a load: every panel is cleared, so one installation's figures never show under another. */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/** Finish the load of `generation`; an answer to an earlier load is ignored. */
export function finishLoad(state: State, generation: number, result: LoadMetricsResult): State {
  if (generation !== state.generation) return state;
  return { generation, view: result.ok ? { kind: "ready", result } : { kind: "failed", result } };
}

// The demo data: synthetic installations and figures, deterministic, chosen so that every panel
// state the view draws is reachable from the picker. No real Worker, account, person or
// installation is described; Worker names are `demo-…`.
import type {
  ActivityData, DemoInstallation, HealthData, InstallationMetrics, Panel, RunsData,
} from "./protocol.ts";

const WEEK = { from: "2026-10-05T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };
const DAY = { from: "2026-10-11T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };

const installation = (n: number, installationName: string): DemoInstallation => ({
  installationId: `00000000-0000-4000-8000-0000000dc${String(n).padStart(3, "0")}`,
  installationName,
});

const activity = (asOf: string, data: ActivityData): Panel<ActivityData> =>
  ({ state: "reported", source: "demo-fixture", modelledOn: "activity/v1", window: WEEK, asOf, data });
const runs = (asOf: string, byStatus: RunsData["byStatus"]): Panel<RunsData> =>
  ({ state: "reported", source: "demo-fixture", modelledOn: "project_issue_runs", window: WEEK, asOf, data: { byStatus } });
const health = (asOf: string, workers: HealthData["workers"]): Panel<HealthData> =>
  ({ state: "reported", source: "demo-fixture", modelledOn: "workers-observability", window: DAY, asOf, data: { workers } });
const offline = (modelledOn: Panel<unknown>["modelledOn"], message: string) =>
  ({ state: "unavailable", source: "demo-fixture", modelledOn, message }) as const;

const events = (counts: [number | null, number | null, number | null, number | null, number | null]) =>
  (["user.authenticated", "workspace.opened", "gadget.created", "connection.created", "connection.removed"] as const)
    .map((eventType, i) => ({ eventType, count: counts[i]! }));

const RUNS_OFFLINE = "The demo run source is offline (synthetic error).";

export const DEMO_INSTALLATIONS: ReadonlyArray<{ installation: DemoInstallation; metrics: Omit<InstallationMetrics, "installation"> }> = [
  {
    // Everything reporting, fresh. Real zeros: connection.removed, failed runs, demo-workshop's errors.
    installation: installation(1, "Demo Installation A"),
    metrics: {
      activity: activity("2026-10-11T23:00:00.000Z", { activePeople: 14, events: events([52, 131, 9, 3, 0]) }),
      runs: runs("2026-10-11T23:30:00.000Z", { queued: 1, running: 2, succeeded: 17, failed: 0, cancelled: 1, unknown: 1 }),
      health: health("2026-10-11T23:55:00.000Z", [
        { worker: "demo-router", requests: 48_210, errors: 37, p95WallTimeMs: 182 },
        { worker: "demo-workshop", requests: 21_904, errors: 0, p95WallTimeMs: null },
        { worker: "demo-gatekeeper", requests: 6_120, errors: 4, p95WallTimeMs: 95 },
      ]),
    },
  },
  {
    // Partial: activity last updated 48 hours before the window's end (stale), runs offline.
    installation: installation(2, "Demo Installation B"),
    metrics: {
      activity: activity("2026-10-10T00:00:00.000Z", { activePeople: 5, events: events([12, 30, null, 1, 0]) }),
      runs: offline("project_issue_runs", RUNS_OFFLINE),
      health: health("2026-10-11T23:55:00.000Z", [
        { worker: "demo-router", requests: 3_002, errors: 12, p95WallTimeMs: 240 },
        { worker: "demo-scheduler", requests: 0, errors: 0, p95WallTimeMs: null },
      ]),
    },
  },
  {
    // Quiet: every panel reported, fresh, and empty.
    installation: installation(3, "Demo Installation C"),
    metrics: {
      activity: activity("2026-10-11T23:00:00.000Z", { activePeople: 0, events: events([0, 0, 0, 0, 0]) }),
      runs: runs("2026-10-11T23:30:00.000Z", { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }),
      health: health("2026-10-11T23:55:00.000Z", []),
    },
  },
  {
    // Nothing reachable.
    installation: installation(4, "Demo Installation D"),
    metrics: {
      activity: offline("activity/v1", "The demo activity source is offline (synthetic error)."),
      runs: offline("project_issue_runs", RUNS_OFFLINE),
      health: offline("workers-observability", "The demo health source is offline (synthetic error)."),
    },
  },
];

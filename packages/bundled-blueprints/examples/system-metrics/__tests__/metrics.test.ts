// @vitest-environment node
// The pure rules: per-panel freshness, totals that never invent a figure, the error rate, units,
// the strict empty predicate, and load generations.
import { describe, expect, it } from "vitest";
// Test-only, by relative path: the gadget keeps its own literal union, and this catches drift.
import { ACTIVITY_EVENT_TYPES } from "../../../../observability/src/metrics-schema.ts";
import { DEMO_INSTALLATIONS } from "../files/lib/fixture.ts";
import type { ActivityData, ActivityEventType, HealthData, RunsData } from "../files/lib/protocol.ts";
import {
  ACTIVITY_EVENTS, errorRate, finishLoad, formatCount, formatMs, freshness, initialState, isEmpty,
  RUN_STATUSES, runTotal, STALE_AFTER_MS, startLoad,
} from "../files/lib/metrics.ts";

// M5 at compile time (R1 L1): every member of the protocol's union is an activity/v1 event type.
const _protocolUnionIsActivityV1: (typeof ACTIVITY_EVENT_TYPES)[number] = null as unknown as ActivityEventType;

const WINDOW_TO = "2026-10-12T00:00:00.000Z";
const before = (ms: number) => new Date(Date.parse(WINDOW_TO) - ms).toISOString();
const runs = (over: Partial<RunsData["byStatus"]> = {}): RunsData => ({
  byStatus: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, ...over },
});
const activity = (over: Partial<ActivityData> = {}, count: number | null = 0): ActivityData => ({
  activePeople: 0, events: ACTIVITY_EVENTS.map(eventType => ({ eventType, count })), ...over,
});

describe("freshness (M1)", () => {
  it("pins each panel's threshold", () => {
    expect(STALE_AFTER_MS).toEqual({ activity: 24 * 3_600_000, runs: 3_600_000, health: 15 * 60_000 });
  });

  it.each(["activity", "runs", "health"] as const)("%s: exactly the threshold is fresh, 1 ms over is stale", panel => {
    const limit = STALE_AFTER_MS[panel];
    expect(freshness(panel, before(limit), WINDOW_TO).stale).toBe(false);
    expect(freshness(panel, before(limit + 1), WINDOW_TO).stale).toBe(true);
  });

  it("measures against the window's end, and says how stale", () => {
    expect(freshness("activity", before(48 * 3_600_000), WINDOW_TO)).toEqual({
      stale: true,
      text: "Stale: last updated 2026-10-10T00:00:00.000Z, 48 hours before the end of the window.",
    });
    expect(freshness("health", before(5 * 60_000), WINDOW_TO))
      .toEqual({ stale: false, text: "Last updated 2026-10-11T23:55:00.000Z." });
  });
});

describe("runTotal (M2)", () => {
  it("sums when all six are known, counting unknown in the total and not as failed", () => {
    expect(runTotal(runs({ queued: 1, running: 2, succeeded: 17, cancelled: 1, unknown: 1 })))
      .toEqual({ runs: 22, missing: 0 });
  });

  it("is unknown when one status is not reported", () => {
    expect(runTotal(runs({ succeeded: 3, cancelled: null }))).toEqual({ runs: null, missing: 1 });
  });

  it("lists the six statuses in the InferOps order", () => {
    expect(RUN_STATUSES.map(s => s.status)).toEqual(["queued", "running", "succeeded", "failed", "cancelled", "unknown"]);
    expect(RUN_STATUSES.at(-1)!.meaning)
      .toBe("Runner never reported back; the run may have changed things. Not counted as failed.");
  });
});

describe("errorRate (M3)", () => {
  it("derives the rate to one decimal, and never a rate for no requests", () => {
    expect(errorRate(37, 48_210)).toBe("0.1 %");
    expect(errorRate(0, 21_904)).toBe("0.0 %");
    expect(errorRate(0, 0)).toBe("No requests");
    expect(errorRate(null, 10)).toBe("Unknown");
    expect(errorRate(1, null)).toBe("Unknown");
  });
});

describe("formatting (M4)", () => {
  it("shows units and never turns a missing figure into 0", () => {
    expect(formatCount(null, "event")).toBe("Unknown");
    expect(formatCount(0, "error")).toBe("0 errors");
    expect(formatCount(1, "run")).toBe("1 run");
    expect(formatCount(48_210, "request")).toBe("48,210 requests");
    expect(formatCount(14, "person")).toBe("14 people");
    expect(formatCount(1, "person")).toBe("1 person");
    expect(formatMs(182)).toBe("182 ms");
    expect(formatMs(null)).toBe("Unknown");
  });
});

describe("fixture (M5)", () => {
  it("keeps every health window within seven days", () => {
    for (const { metrics } of DEMO_INSTALLATIONS) {
      if (metrics.health.state !== "reported") continue;
      const span = Date.parse(metrics.health.window.to) - Date.parse(metrics.health.window.from);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    }
  });

  it("uses only activity/v1 event types", () => {
    for (const type of ACTIVITY_EVENTS) expect(ACTIVITY_EVENT_TYPES).toContain(type);
    for (const { metrics } of DEMO_INSTALLATIONS) {
      if (metrics.activity.state !== "reported") continue;
      for (const { eventType } of metrics.activity.data.events) expect(ACTIVITY_EVENT_TYPES).toContain(eventType);
    }
  });
});

describe("isEmpty (M6)", () => {
  it("is true only when every figure is a reported zero", () => {
    expect(isEmpty("activity", activity())).toBe(true);
    expect(isEmpty("runs", runs())).toBe(true);
    expect(isEmpty("health", { workers: [] } satisfies HealthData)).toBe(true);
  });

  it("is false when anything is not reported, or anything happened", () => {
    expect(isEmpty("activity", activity({ activePeople: null }))).toBe(false);
    const oneUnknown = activity();
    oneUnknown.events[2] = { ...oneUnknown.events[2]!, count: null };
    expect(isEmpty("activity", oneUnknown)).toBe(false);
    expect(isEmpty("activity", activity({ activePeople: 1 }))).toBe(false);
    expect(isEmpty("runs", runs({ cancelled: null }))).toBe(false);
    expect(isEmpty("runs", runs({ unknown: 1 }))).toBe(false);
    expect(isEmpty("health", { workers: [{ worker: "w", requests: 0, errors: 0, p95WallTimeMs: null }] })).toBe(false);
  });
});

describe("load generations", () => {
  it("clears the view on a new load and ignores an earlier load's answer", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    expect(second.view).toEqual({ kind: "loading" });
    const late = { ok: false, reason: "unknown-installation" } as const;
    expect(finishLoad(second, first.generation, late)).toBe(second);
    expect(finishLoad(second, second.generation, late).view).toEqual({ kind: "failed", result: late });
  });
});

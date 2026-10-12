// @vitest-environment node
// The pure rules: totals never invent a figure, amounts carry units, staleness, load generations.
import { describe, expect, it } from "vitest";
import { DEMO_WINDOW, DEMO_WORKSPACES } from "../files/lib/fixture.ts";
import type { ModelUsageRow } from "../files/lib/protocol.ts";
import {
  finishLoad, formatTokens, formatUsd, freshness, initialState, startLoad, totals,
} from "../files/lib/usage.ts";

const row = (over: Partial<ModelUsageRow>): ModelUsageRow => ({
  model: "m", provider: "p", inputTokens: 0, outputTokens: 0,
  estimatedCents: 0, providerReportedCents: 0, billedCents: null, ...over,
});

describe("totals", () => {
  it("adds every token and every complete cost column exactly", () => {
    const t = totals([
      row({ inputTokens: 1_250_000, outputTokens: 310_000, estimatedCents: 1_860, providerReportedCents: 1_912 }),
      row({ inputTokens: 4_800_000, outputTokens: 920_000, estimatedCents: 744, providerReportedCents: 731 }),
    ]);
    expect(t.inputTokens).toBe(6_050_000);
    expect(t.outputTokens).toBe(1_230_000);
    expect(t.cost.estimatedCents).toEqual({ cents: 2_604, missing: 0 });
    expect(t.cost.providerReportedCents).toEqual({ cents: 2_643, missing: 0 });
  });

  it("never reports a partial sum: one missing figure makes that total unknown", () => {
    const t = totals([row({ providerReportedCents: 500 }), row({ providerReportedCents: null })]);
    expect(t.cost.providerReportedCents).toEqual({ cents: null, missing: 1 });
    expect(t.cost.billedCents).toEqual({ cents: null, missing: 2 });
  });

  it("an empty window totals zero tokens and zero known cost", () => {
    expect(totals([])).toEqual({
      inputTokens: 0, outputTokens: 0,
      cost: { estimatedCents: { cents: 0, missing: 0 }, providerReportedCents: { cents: 0, missing: 0 },
        billedCents: { cents: 0, missing: 0 } },
    });
  });
});

describe("formatting", () => {
  it("shows units and never turns a missing figure into 0", () => {
    expect(formatTokens(1_250_000)).toBe("1,250,000 tokens");
    expect(formatUsd(2_604)).toBe("26.04 USD");
    expect(formatUsd(5)).toBe("0.05 USD");
    expect(formatUsd(123_456_789)).toBe("1,234,567.89 USD");
    expect(formatUsd(null)).toBe("Unknown");
  });

  it("marks figures stale when last updated more than 24 hours before the window's end", () => {
    expect(freshness("2026-10-11T23:00:00.000Z", DEMO_WINDOW.to))
      .toEqual({ stale: false, text: "Last updated 2026-10-11T23:00:00.000Z." });
    expect(freshness("2026-10-10T00:00:00.000Z", DEMO_WINDOW.to)).toEqual({
      stale: true,
      text: "Stale: last updated 2026-10-10T00:00:00.000Z, 48 hours before the end of the window.",
    });
  });
});

describe("load generations", () => {
  it("draws only the latest load's answer", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    const late = finishLoad(second, first.generation, { ok: false, reason: "unknown-workspace" });
    expect(late).toBe(second);
    expect(finishLoad(second, second.generation, { ok: false, reason: "unknown-workspace" }).view.kind).toBe("failed");
  });
});

describe("the demo fixture", () => {
  it("holds workspace totals only: no person, session, chat, email or account field anywhere", () => {
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(DEMO_WORKSPACES);
    expect([...keys].toSorted()).toEqual([
      "asOf", "billedCents", "data", "estimatedCents", "inputTokens", "kind", "message", "model",
      "outputTokens", "provider", "providerReportedCents", "rows", "usage", "workspace", "workspaceId",
      "workspaceName",
    ]);
    expect(JSON.stringify(DEMO_WORKSPACES)).not.toMatch(/@|person|user|session|chat|email|token[A-Za-z]*Id/i);
  });

  it("never claims a billed figure: no billing source exists", () => {
    for (const { data } of DEMO_WORKSPACES) {
      if (data.kind === "usage") for (const r of data.usage.rows) expect(r.billedCents).toBeNull();
    }
  });
});

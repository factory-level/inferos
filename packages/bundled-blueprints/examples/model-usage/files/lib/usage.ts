// The Model usage gadget's pure rules: totals that never invent a figure, how amounts read, when
// figures are stale, and which load answer is current. No DOM and no I/O, so both sides and the
// tests share them.

import type { LoadUsageResult, ModelUsageRow } from "./protocol.ts";

/** Figures last updated more than this long before the window's end are drawn as stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type CostKind = "estimatedCents" | "providerReportedCents" | "billedCents";

/** The three kinds of cost, kept apart: what each one is, as the view explains it. */
export const COST_KINDS: ReadonlyArray<{ key: CostKind; label: string; meaning: string }> = [
  { key: "estimatedCents", label: "Estimated", meaning: "computed from token counts and a price table" },
  { key: "providerReportedCents", label: "Provider-reported", meaning: "as the model provider or gateway reported it" },
  { key: "billedCents", label: "Billed", meaning: "as an invoice charged it; no billing source is connected" },
];

/** A cost total: the sum, or `null` with how many rows lack the figure. Never a partial sum. */
export type CostTotal = { cents: number | null; missing: number };

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  cost: Record<CostKind, CostTotal>;
}

/**
 * Sum the rows. Tokens always add up. A cost total is the sum only when every row has that figure;
 * if any row lacks it the total is unknown, because a partial sum would read as the whole.
 */
export function totals(rows: readonly ModelUsageRow[]): Totals {
  const cost = {} as Record<CostKind, CostTotal>;
  for (const { key } of COST_KINDS) {
    const missing = rows.filter(row => row[key] === null).length;
    cost[key] = {
      cents: missing === 0 ? rows.reduce((sum, row) => sum + (row[key] as number), 0) : null,
      missing,
    };
  }
  return {
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    cost,
  };
}

const TOKENS = new Intl.NumberFormat("en-US");

/** A token count as shown, with its unit: "1,250,000 tokens". */
export function formatTokens(count: number): string {
  return `${TOKENS.format(count)} tokens`;
}

/** An amount in cents as shown, with its unit, or "Unknown" — never "0" for a missing figure. */
export function formatUsd(cents: number | null): string {
  if (cents === null) return "Unknown";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")} USD`;
}

/** Whether the figures are stale, and the freshness line the view shows. */
export function freshness(asOf: string, windowTo: string): { stale: boolean; text: string } {
  const lag = Date.parse(windowTo) - Date.parse(asOf);
  const stale = lag > STALE_AFTER_MS;
  const hours = Math.round(lag / 3_600_000);
  return {
    stale,
    text: stale
      ? `Stale: last updated ${asOf}, ${hours} hours before the end of the window.`
      : `Last updated ${asOf}.`,
  };
}

/** What the gadget shows. Only `ready` holds figures; every other state holds none. */
export type View =
  | { kind: "loading" }
  | { kind: "failed"; result: Extract<LoadUsageResult, { ok: false }> }
  | { kind: "ready"; result: Extract<LoadUsageResult, { ok: true }> };

export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/** Start a load: whatever was shown is cleared, so one workspace's figures never show under another. */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/** Finish the load of `generation`; an answer to an earlier load is ignored. */
export function finishLoad(state: State, generation: number, result: LoadUsageResult): State {
  if (generation !== state.generation) return state;
  return { generation, view: result.ok ? { kind: "ready", result } : { kind: "failed", result } };
}

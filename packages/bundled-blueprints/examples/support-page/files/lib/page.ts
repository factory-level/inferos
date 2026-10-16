// The tech-support page's pure rules: when a region is stale, how counts read, when the board or the
// runbook is empty, how an issue reads, and which load answer is current. No DOM and no I/O, so
// both sides and the tests share them.

import type { BoardData, IssuePriority, LoadSupportPageResult, RunbookData, SupportIssue } from "./protocol.ts";

export type StaleRegion = "tile" | "board";

/**
 * A region is stale when it was last updated more than this long before the page was read. Demo
 * engineering constants, not owner policy: tiles roll up hourly, the board is a near-live read.
 */
export const STALE_AFTER_MS: Readonly<Record<StaleRegion, number>> = {
  tile: 60 * 60 * 1000,
  board: 15 * 60 * 1000,
};

/** Whether a region is stale against the page's read time (never the wall clock), and its line. */
export function freshness(region: StaleRegion, asOf: string, readAt: string): { stale: boolean; text: string } {
  const lag = Date.parse(readAt) - Date.parse(asOf);
  const stale = lag > STALE_AFTER_MS[region];
  const hours = Math.round(lag / 3_600_000);
  return {
    stale,
    text: stale ? `Stale: last updated ${asOf}, ${hours} hours before this page was read.` : `Last updated ${asOf}.`,
  };
}

const COUNT = new Intl.NumberFormat("en-US");
const PLURAL: Record<string, string> = { person: "people" };

/** A count with its unit ("6 people", "1 run"), or "Unknown" — never "0" for a missing figure. */
export function formatCount(count: number | null, unit: string): string {
  if (count === null) return "Unknown";
  return `${COUNT.format(count)} ${count === 1 ? unit : (PLURAL[unit] ?? `${unit}s`)}`;
}

/** The board is empty only when every column has no issue. */
export function boardIsEmpty(board: BoardData): boolean {
  return board.columns.every(column => column.issues.length === 0);
}

/** The runbook is empty when it has no section, or every block's text is blank. */
export function runbookIsEmpty(runbook: RunbookData): boolean {
  return runbook.sections.every(section => section.blocks.every(block =>
    block.kind === "paragraph" ? block.text.trim() === "" : block.items.every(item => item.trim() === "")));
}

const PRIORITY: Readonly<Record<IssuePriority, string>> = {
  urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority",
};

/** An issue's lines, as text: identifier and title, priority, then the due date and block reason if any. */
export function issueLine(issue: SupportIssue): string[] {
  return [
    `${issue.identifier}  ${issue.title}`,
    PRIORITY[issue.priority],
    ...(issue.targetDate ? [`Due ${issue.targetDate}`] : []),
    ...(issue.blockedReason ? [`Blocked: ${issue.blockedReason}`] : []),
  ];
}

/** What the gadget shows. Only `ready` holds figures; every other state holds none. */
export type View =
  | { kind: "loading" }
  | { kind: "failed"; result: Extract<LoadSupportPageResult, { ok: false }> }
  | { kind: "ready"; result: Extract<LoadSupportPageResult, { ok: true }> };

export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/** Start a load: every region is cleared, so one installation's figures never show under another. */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/** Finish the load of `generation`; an answer to an earlier load is ignored. */
export function finishLoad(state: State, generation: number, result: LoadSupportPageResult): State {
  if (generation !== state.generation) return state;
  return { generation, view: result.ok ? { kind: "ready", result } : { kind: "failed", result } };
}

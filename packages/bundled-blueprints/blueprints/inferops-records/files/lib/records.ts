// The Records gadget's pure rules: which load result is current, what a refusal means, and how a
// cell reads. No DOM and no I/O, so both sides and the tests share them.

import type { LoadRowsResult, TableColumn, TableRecord } from "./protocol.ts";

/** The most rows one load shows: the binding's own limit. */
export const ROW_LIMIT = 50;

/** What the gadget shows. Only `ready` holds rows; every other state holds none. */
export type View =
  | { kind: "loading" }
  | Extract<LoadRowsResult, { ok: false }> & { kind: "failed" }
  | { kind: "ready"; result: Extract<LoadRowsResult, { ok: true }> };

/** The client's state: what it shows, and the generation of the load it is waiting for. */
export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/**
 * Start a load. Whatever was shown is cleared: the gadget cannot tell whether its binding changed
 * since the last load, so it never shows one load's rows while waiting for another.
 */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/**
 * Finish the load of `generation`. An answer to any earlier load is ignored, so a slow answer for a
 * previous binding or account can never replace a newer one. A failure replaces the rows.
 */
export function finishLoad(state: State, generation: number, result: LoadRowsResult): State {
  if (generation !== state.generation) return state;
  return {
    generation,
    view: result.ok ? { kind: "ready", result } : { ...result, kind: "failed" },
  };
}

const FAILURES: ReadonlyArray<[string, Exclude<Extract<LoadRowsResult, { ok: false }>["reason"], "not-connected">]> = [
  ["NOT_FOUND", "unavailable"], ["UNAUTHORIZED", "unavailable"], ["FORBIDDEN", "unavailable"],
  ["DISABLED", "disabled"],
];

/** How a caught binding failure is shown: its kind, from the code the gatekeeper leads with. */
export function classify(error: unknown): Extract<LoadRowsResult, { ok: false; message: string }> {
  const text = error instanceof Error ? error.message : String(error);
  const code = /^(?:\w*Error: )?([A-Z_]+): /.exec(text)?.[1];
  const reason = FAILURES.find(([name]) => name === code)?.[1] ?? "error";
  return { ok: false, reason, message: text.replace(/^(?:\w*Error: )?[A-Z_]+: /, "") };
}

/** A cell's text: empty for no value, Yes/No for a boolean, the value as written otherwise. */
export function cellText(record: TableRecord, column: TableColumn): string {
  const value = record.values[column.name];
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** How many links a row has in each relation, by relation name. */
export function linkCounts(record: TableRecord): Map<string, number> {
  const counts = new Map<string, number>();
  for (const link of record.links) counts.set(link.relation, (counts.get(link.relation) ?? 0) + 1);
  return counts;
}

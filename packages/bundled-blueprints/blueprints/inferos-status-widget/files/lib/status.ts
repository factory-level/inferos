// What the Status Widget shows for each of its declared states: a label and the colour its header
// mark takes. A pure table, so the client and its tests read the same thing.

/** How the widget shows one state. */
export type StatusLook = {
  /** The words under the mark. */
  label: string;
  /** The mark's stroke colour. */
  color: string;
  /** Whether the mark pulses, for work in progress. */
  pulse: boolean;
};

/** Neutral: no state known yet, or one this widget doesn't recognise. */
export const NEUTRAL = "#8b929c";

/** The widget's states, as states.json declares them. */
export const LOOKS: Readonly<Record<string, StatusLook>> = Object.freeze({
  idle: { label: "Idle", color: NEUTRAL, pulse: false },
  working: { label: "Working", color: "#ff4801", pulse: true },
  done: { label: "Done", color: "#1f9d55", pulse: false },
  failed: { label: "Failed", color: "#d4351c", pulse: false },
});

/** The look for `state`, or `null` before the host has said which state the widget is in. */
export function lookFor(state: string | null): StatusLook {
  if (state === null) return { label: "Open this widget in Operate to see its state.", color: NEUTRAL, pulse: false };
  return LOOKS[state] ?? { label: state, color: NEUTRAL, pulse: false };
}

/** A `widget-state` message from the host, or `null` for anything else. */
export function widgetStateOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  let { type, state } = data as Record<string, unknown>;
  return type === "widget-state" && typeof state === "string" && state.length <= 40 ? state : null;
}

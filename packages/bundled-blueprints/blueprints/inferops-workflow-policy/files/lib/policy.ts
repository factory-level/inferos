// The Workflow policy gadget's pure rules: which load result is current, what a refusal means, and
// how each part of the policy reads. No DOM and no I/O, so both sides and the tests share them.
//
// Every text here restates one field as the binding gave it. Nothing combines rules, resolves
// fragments, applies guards or works out who may do what: the gadget shows the published document,
// it does not evaluate it.

import type {
  LoadPolicyResult, WorkflowPolicyGuard, WorkflowPolicyLane, WorkflowPolicyRule, WorkflowPolicySubject,
} from "./protocol.ts";

/** What the gadget shows. Only `ready` holds a policy; every other state holds none. */
export type View =
  | { kind: "loading" }
  | Extract<LoadPolicyResult, { ok: false }> & { kind: "failed" }
  | { kind: "ready"; result: Extract<LoadPolicyResult, { ok: true }> };

/** The client's state: what it shows, and the generation of the load it is waiting for. */
export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/**
 * Start a load. Whatever was shown is cleared: the gadget cannot tell whether its binding changed
 * since the last load, so it never shows one load's policy while waiting for another.
 */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/**
 * Finish the load of `generation`. An answer to any earlier load is ignored, so of two loads in
 * flight the earlier one's late answer is never drawn. A failure replaces the policy.
 */
export function finishLoad(state: State, generation: number, result: LoadPolicyResult): State {
  if (generation !== state.generation) return state;
  return {
    generation,
    view: result.ok ? { kind: "ready", result } : { ...result, kind: "failed" },
  };
}

const FAILURES: ReadonlyArray<[string, Exclude<Extract<LoadPolicyResult, { ok: false }>["reason"], "not-connected">]> = [
  ["NOT_FOUND", "unavailable"], ["UNAUTHORIZED", "unavailable"], ["FORBIDDEN", "unavailable"],
  ["DISABLED", "disabled"],
];

/** How a caught binding failure is shown: its kind, from the code the gatekeeper leads with. */
export function classify(error: unknown): Extract<LoadPolicyResult, { ok: false; message: string }> {
  const text = error instanceof Error ? error.message : String(error);
  const code = /^(?:\w*Error: )?([A-Z_]+): /.exec(text)?.[1];
  const reason = FAILURES.find(([name]) => name === code)?.[1] ?? "error";
  return { ok: false, reason, message: text.replace(/^(?:\w*Error: )?[A-Z_]+: /, "") };
}

const KINDS: Record<string, string> = { user: "person", service_account: "agent", system: "system" };

/** One subject as written: a named principal, every principal of a kind, or a role. */
export function subjectText(subject: WorkflowPolicySubject): string {
  if ("principalId" in subject) return `principal ${subject.principalId}`;
  if ("kind" in subject) return `every ${KINDS[subject.kind] ?? subject.kind}`;
  return `role ${subject.role}`;
}

/** A rule's subjects, in the order given. */
export function subjectsText(subjects: readonly WorkflowPolicySubject[]): string {
  return subjects.map(subjectText).join(", ");
}

/** A transition's subjects: empty means the lanes' own rules decide who may take it. */
export function transitionSubjectsText(subjects: readonly WorkflowPolicySubject[]): string {
  return subjects.length === 0 ? "Anyone the lanes' rules allow" : subjectsText(subjects);
}

/** A rule's effect and actions, in the order given. */
export function ruleText(rule: WorkflowPolicyRule): string {
  return `${rule.effect === "deny" ? "Deny" : "Allow"} ${rule.actions.join(", ")}`;
}

/** One guard as written. */
export function guardText(guard: WorkflowPolicyGuard): string {
  if (guard.kind === "required-field") return `required field: ${guard.field ?? ""}`;
  if (guard.kind === "actor-kind") return `actor must be: ${KINDS[guard.actorKind ?? ""] ?? guard.actorKind ?? ""}`;
  return guard.kind;
}

/** A lane reference by its name in this policy; `*` is any lane, and an unknown id is shown as is. */
export function laneName(lanes: readonly WorkflowPolicyLane[], ref: string): string {
  if (ref === "*") return "Any lane";
  return lanes.find(lane => lane.id === ref)?.name ?? ref;
}

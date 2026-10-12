// The Members gadget's pure rules: which load result is current, what a refusal means, and how a
// member reads. No DOM and no I/O, so both sides and the tests share them.

import type { LoadMembersResult, WorkspaceMember } from "./protocol.ts";

/** What the gadget shows. Only `ready` holds members; every other state holds none. */
export type View =
  | { kind: "loading" }
  | Extract<LoadMembersResult, { ok: false }> & { kind: "failed" }
  | { kind: "ready"; result: Extract<LoadMembersResult, { ok: true }> };

/** The client's state: what it shows, and the generation of the load it is waiting for. */
export type State = { view: View; generation: number };

export const initialState: State = { view: { kind: "loading" }, generation: 0 };

/**
 * Start a load. Whatever was shown is cleared: the gadget cannot tell whether its binding changed
 * since the last load, so it never shows one load's members while waiting for another.
 */
export function startLoad(state: State): State {
  return { view: { kind: "loading" }, generation: state.generation + 1 };
}

/**
 * Finish the load of `generation`. An answer to any earlier load is ignored, so of two loads in
 * flight the earlier one's late answer is never drawn. (That an account change discards an answer
 * is the gatekeeper's job, not this rule's.) A failure replaces the members.
 */
export function finishLoad(state: State, generation: number, result: LoadMembersResult): State {
  if (generation !== state.generation) return state;
  return {
    generation,
    view: result.ok ? { kind: "ready", result } : { ...result, kind: "failed" },
  };
}

const FAILURES: ReadonlyArray<[string, Exclude<Extract<LoadMembersResult, { ok: false }>["reason"], "not-connected">]> = [
  ["NOT_FOUND", "unavailable"], ["UNAUTHORIZED", "unavailable"], ["FORBIDDEN", "unavailable"],
  ["DISABLED", "disabled"],
];

/** How a caught binding failure is shown: its kind, from the code the gatekeeper leads with. */
export function classify(error: unknown): Extract<LoadMembersResult, { ok: false; message: string }> {
  const text = error instanceof Error ? error.message : String(error);
  const code = /^(?:\w*Error: )?([A-Z_]+): /.exec(text)?.[1];
  const reason = FAILURES.find(([name]) => name === code)?.[1] ?? "error";
  return { ok: false, reason, message: text.replace(/^(?:\w*Error: )?[A-Z_]+: /, "") };
}

/** A member's kind as shown: a person or an agent. */
export function kindLabel(member: WorkspaceMember): string {
  return member.type === "service_account" ? "Agent" : "Person";
}

/** A member's denies as shown: "None", or the denied permissions in the order given. */
export function deniedText(member: WorkspaceMember): string {
  return member.deniedPermissions.length === 0 ? "None" : member.deniedPermissions.join(", ");
}

/** The product a workspace belongs to, as shown. */
export function productLabel(product: string): string {
  return product === "infermind" ? "InferMind" : product === "inferops" ? "InferOps" : product;
}

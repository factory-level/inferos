// Scenario `operate-explicit-approval` version 1: one programmed explicit approval of one InferOps
// board transition, answered through the real Workshop's AG-UI approval bridge by the stock
// `@ag-ui/client`. The contract is `operate-explicit-approval.md` beside this file; this module holds
// its data, and the runner is `__tests__/operate-approval-scenario.test.ts`.
//
// Only the InferOps and InferLab provider answers are programmed (`InferOpsFake`). Sign-in, the
// gatekeeper session that proposes the transition, the action journal, the interrupt, the caller
// binding and every approval check, and the provider write through the gatekeeper all run real code.
// No model takes part: the proposal is the fixture's own call on the board session.

import { boardUrl } from "../inferops-fake.js";
import {
  assertLoopbackTarget as assertLoopback, scenarioVerdict as verdictFor,
  type ScenarioCase, type ScenarioIsolation, type ScenarioReport as Report,
} from "./scenario-report.js";

/** Bump `version` whenever a fixture input or an expected result below changes. */
export const SCENARIO = { id: "operate-explicit-approval", version: 1 } as const;

/** The synthetic board the proposal is made on, served by the fake InferOps. */
export const SCENARIO_BOARD = boardUrl("operations", "ENG");

/** The InferOps workspace the connected fixture person holds. */
export const SCENARIO_WORKSPACE = "operations";

/** The seeded issue whose state the proposal moves. */
export const SCENARIO_ISSUE = "ENG-1";

/** The fixture each case starts from: a new account and workspace, one pending transition. */
export const INITIAL_STATE = { pendingActions: 1, providerWrites: 0, issueMoved: false } as const;

/** What the first, unanswered run must show. */
export const EXPECTED_INTERRUPT = {
  eventTypes: ["RUN_STARTED", "STATE_SNAPSHOT", "MESSAGES_SNAPSHOT", "RUN_FINISHED"],
  reason: "inferos.gatekeeper.approval.v1",
  required: ["approved"],
  status: "pending",
  /** The deadline is ten minutes out; at least this many milliseconds must remain. */
  minimumRemainingMs: 500_000,
} as const;

/** An explicit approval: applied once, by the person, and an identical answer changes nothing. */
export const EXPECTED_APPROVE = { status: "applied", providerWrites: 1, retryStatus: "applied", reloadStatus: "applied" } as const;

/** An explicit denial: rejected, with no provider write, and an identical answer changes nothing. */
export const EXPECTED_DENY = { status: "rejected", providerWrites: 0, retryStatus: "rejected" } as const;

/** Refusals, each before any effect: a caller who is not the approver, and a conflicting answer. */
export const EXPECTED_REFUSALS = {
  wrongCaller: { status: 403, error: "APPROVAL_REFUSED" },
  conflictingAnswer: { status: 403 },
} as const;

/** Refuse any target that is not a plain-HTTP loopback Workshop. */
export function assertLoopbackTarget(target: URL): URL {
  return assertLoopback(target, SCENARIO.id);
}

export type { ScenarioCase };

/** The bounded, credential-free report a run writes. */
export type ScenarioReport = Report<typeof SCENARIO.id>;

/** The case names a complete run records, in order. */
export const CASE_NAMES = ["loopback-only", "approve", "approve-repeat", "deny", "refusals"] as const;

/** PASS only for every case passing and an isolation check that ran and found no unanswered request. */
export function scenarioVerdict(cases: readonly ScenarioCase[], isolation: ScenarioIsolation): ScenarioReport["verdict"] {
  return verdictFor(CASE_NAMES, cases, isolation);
}

/** Which parts of the run are programmed and which are the real code paths. */
export const BOUNDARIES = {
  mocked: [
    "InferOps and InferLab provider answers (InferOpsFake synthetic board, issue, sign-in and write log)",
    "synthetic password accounts and InferLab identities; no per-person live identity",
    "the proposal itself: the fixture calls the board session's transition, no model is involved",
  ],
  real: [
    "Workshop password sign-in and bearer session",
    "InferOps gatekeeper Worker connection, its transition proposal and its provider write",
    "the Workshop action journal and its approve/reject decisions",
    "POST /api/operate/agui/approval (AG-UI 1.0): interrupt, caller binding, answer validation and replay",
    "@ag-ui/client HttpAgent 1.0.2, unmodified",
  ],
};

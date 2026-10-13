// The contract between this gadget's client and its Durable Object, plus the slice of the InferOps
// gatekeeper's agent-facing API (InferOpsWorkflowPolicySession) the Durable Object calls. Imported
// type-only, so nothing of it ships. The shapes are the gatekeeper's projection: rule reasons, agent
// notes and the publisher are already left out there, and nothing here adds them back.

/** Who a rule or transition speaks about: one principal, every principal of a kind, or a role. */
export type WorkflowPolicySubject =
  | { principalId: string }
  | { kind: "user" | "service_account" | "system" }
  | { role: string };

/** One rule: an allow or deny of some actions for some subjects. */
export interface WorkflowPolicyRule {
  id: string;
  effect: "allow" | "deny";
  subjects: WorkflowPolicySubject[];
  actions: string[];
}

/** A condition every mutating action at a lane, or a move along a transition, must also satisfy. */
export interface WorkflowPolicyGuard {
  kind: "required-field" | "lease-holder" | "actor-kind" | "not-blocked" | "approval-ref";
  field?: string;
  actorKind?: string;
}

/** One lane of the workflow, in board order. */
export interface WorkflowPolicyLane {
  id: string;
  name: string;
  group: string;
}

export interface WorkflowPolicyFragment {
  id: string;
  version: number;
  use?: string[];
  rules: WorkflowPolicyRule[];
}

export interface WorkflowPolicyLaneBinding {
  laneId: string;
  use?: string[];
  rules?: WorkflowPolicyRule[];
  guards?: WorkflowPolicyGuard[];
}

export interface WorkflowPolicyTransition {
  id: string;
  /** A lane id, or "*" for any lane. */
  from: string;
  to: string;
  /** Empty: anyone the lanes' rules allow may take it. */
  subjects: WorkflowPolicySubject[];
  guards?: WorkflowPolicyGuard[];
  rules?: WorkflowPolicyRule[];
}

export interface WorkflowPolicyV2 {
  schemaVersion: 2;
  workflow: "content";
  entryLaneId: string;
  lanes: WorkflowPolicyLane[];
  fragments?: WorkflowPolicyFragment[];
  laneBindings?: WorkflowPolicyLaneBinding[];
  rules?: WorkflowPolicyRule[];
  transitions?: WorkflowPolicyTransition[];
}

/** The published content-workflow policy head of one project, as the binding returns it. */
export interface WorkflowPolicyHead {
  projectId: string;
  workflow: "content";
  configured: boolean;
  revision: string;
  policy: WorkflowPolicyV2 | null;
  /** InferOps' hash of its compiled source policy: source metadata, not a hash of this view. */
  compiledHash: string | null;
  legacyUpgraded: boolean;
  publishedAt?: string;
}

/** The `policy` binding: one project's published content-workflow policy, fixed by the connection. */
export interface InferOpsWorkflowPolicySession {
  readWorkflowPolicy(): Promise<WorkflowPolicyHead>;
}

/**
 * One load. `unavailable` covers a policy that is missing or refused, or whose sign-in ended (the
 * binding says which only in its message); `disabled` is the deployment's switch.
 */
export type LoadPolicyResult =
  | { ok: true; head: WorkflowPolicyHead }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "unavailable" | "disabled" | "error"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  loadPolicy(): Promise<LoadPolicyResult>;
}

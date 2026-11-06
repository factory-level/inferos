import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  agentName: string;
  autoProvisioned: boolean;
  blueprintId: string;
  callbackInitiated: boolean;
  chatId: number;
  claimedType: string;
  commitCount: number;
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  /** Bytes in the fixed compile dependency closure. */
  dependencyBytes: number;
  /** The lockfile hash for the reviewed compile dependency closure. */
  dependencyLockHash: string;
  /** Bytes in the pinned esbuild wasm module. */
  wasmBytes: number;
  event: string;
  executionId: string;
  failureCount: number;
  gadgetId: string;
  gatekeeperId: number | string;
  handoffKind: "connect" | "restore";
  hookId: number;
  /** A workflow run's id (FAC-111), never a secret: what a run's log lines are joined on. */
  runId: string;
  /** Who asked for a workflow run (FAC-104): `person:<profile id>` or `trigger`. A record, never authority. */
  initiator: string;
  /** Who a workflow run acts as (FAC-104): `service_account:<connection id>` or `gadget_bindings`. */
  executor: string;
  logBytes: number;
  modelId: string;
  observerId: string;
  oidCount: number;
  oidPrefix: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "no_email" | "signups_disabled";
  path: string;
  recordedType: string;
  resourceTitle: string;
  sequence: number;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return obsContext.createLogger({ component });
}

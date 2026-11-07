import { createLogger } from "@gadgets/observability/logger";
import { createObservabilityContext } from "@gadgets/observability/observability-context";

type Phase = "rpc" | "provider" | "observation" | "authorize" | "http";
type Details = { success: boolean; requestId?: string; operationMs?: number; fenceMs?: number; attempts?: number };
type Measurements = {
  closed: boolean;
  phases: Partial<Record<Phase, { count: number; durationMs: number; success: boolean }>>;
  httpAttempts: { requestId: string; durationMs: number; success: boolean }[];
  omittedAttempts: number; operationMs: number; fenceMs: number; attempts: number;
};
const context = createObservabilityContext<{ queryCallId: string; measurements: Measurements }>();
type CompletionFields = {
  queryCallId: string; rpcMs: number; providerMs: number; observationMs: number; authorizeMs: number;
  operationMs: number; fenceMs: number; attempts: number; success: boolean;
  http1Id: string; http1Ms: number; http1Success: boolean;
  http2Id: string; http2Ms: number; http2Success: boolean; omittedAttempts: number;
};
const log = createLogger<CompletionFields>({ component: "gatekeeper.inferops.service-query" });
/** Record fixed numeric fields. One RPC completion log includes at most two HTTP attempt IDs. */
export function recordServiceQueryTiming(phase: Phase, durationMs: number, details: Details): void {
  const measurements = context.get().measurements;
  if (!measurements || measurements.closed || !Number.isFinite(durationMs) || durationMs < 0) return;
  const before = measurements.phases[phase];
  measurements.phases[phase] = { count: (before?.count ?? 0) + 1,
    durationMs: (before?.durationMs ?? 0) + durationMs, success: (before?.success ?? true) && details.success };
  if (phase === "http" && details.requestId) {
    if (measurements.httpAttempts.length < 2) measurements.httpAttempts.push({ requestId: details.requestId, durationMs, success: details.success });
    else measurements.omittedAttempts++;
  }
  if (phase === "authorize") {
    for (const key of ["operationMs", "fenceMs", "attempts"] as const) {
      const value = details[key];
      if (value !== undefined && Number.isFinite(value) && value >= 0) measurements[key] += value;
    }
  }
  if (phase === "rpc") {
    measurements.closed = true;
    try {
      const [first, second] = measurements.httpAttempts;
      // Flat primitives survive local console inspection as well as deployed structured logs.
      log.debug("Service query completed", { event: "service_query.completed",
        queryCallId: context.get().queryCallId,
        rpcMs: measurements.phases.rpc?.durationMs,
        providerMs: measurements.phases.provider?.durationMs,
        observationMs: measurements.phases.observation?.durationMs,
        authorizeMs: measurements.phases.authorize?.durationMs,
        operationMs: measurements.operationMs, fenceMs: measurements.fenceMs,
        attempts: measurements.attempts, success: measurements.phases.rpc?.success,
        http1Id: first?.requestId, http1Ms: first?.durationMs, http1Success: first?.success,
        http2Id: second?.requestId, http2Ms: second?.durationMs, http2Success: second?.success,
        omittedAttempts: measurements.omittedAttempts,
      });
    }
    catch { /* Diagnostic delivery must never replace the query outcome. */ }
  }
}
/** Time one phase while retaining its original result or exception. */
export async function measureServiceQueryPhase<T>(phase: Phase, run: () => Promise<T>): Promise<T> {
  const start = performance.now(); let success = false;
  try { const result = await run(); success = true; return result; }
  finally { recordServiceQueryTiming(phase, performance.now() - start, { success }); }
}
/** Re-establish observability at RPC entry; IDs never select authority, data or cache entries. */
export function withServiceQueryTiming<T>(run: (queryCallId: string) => Promise<T>): Promise<T> {
  const queryCallId = crypto.randomUUID();
  return context.with({ queryCallId, measurements: { closed: false, phases: {}, httpAttempts: [], omittedAttempts: 0,
    operationMs: 0, fenceMs: 0, attempts: 0 } }, () => measureServiceQueryPhase("rpc", () => run(queryCallId)));
}
/** Each attempted HTTP send gets a distinct ID, including credential refresh retries. */
export async function serviceQueryHttpAttempt<T>(run: (requestId?: string) => Promise<T>): Promise<T> {
  if (!context.get().queryCallId) return run();
  const requestId = crypto.randomUUID(), start = performance.now(); let success = false;
  try { const result = await run(requestId); success = true; return result; }
  finally { recordServiceQueryTiming("http", performance.now() - start, { requestId, success }); }
}

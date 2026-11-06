// Assigned runs of configured system workflows (FAC-102, inferops ADR 0011 S1-S4, inferos ADR
// 0011; see docs/architecture/operate-mode.md, "Running a trigger on request"). An admitted request
// for a trigger with an assignment runs the delivery's pinned commit in a fresh, run-scoped worker
// whose `env` holds only the gadget's bindings to the assigned connection. Each binding is a
// loopback whose caller is `systemRun`, set server-side in its props, and its sessions open on the
// connection vendor's system class for the assignment's credential reference: the service account,
// never a person. Nothing here is reachable from a client, a gadget or an agent; the Overseer wires it.

import { RpcTarget } from "cloudflare:workers";
import type { Gatekeeper, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import type { TriggerAssignment } from "@gadgets/workshop-shared/workflow-definition";

/** Refusal: an assigned run's assignment changed or was removed after the run was admitted. */
export const SYSTEM_RUN_ASSIGNMENT_CHANGED =
  "This trigger's assignment changed since the run was admitted. Ask again.";

/** Refusal: the assigned connection's vendor can't run a workflow as a service account. */
export const SYSTEM_RUN_UNSUPPORTED =
  "This connection can't run workflows as a service account, so the run didn't start.";

/** Refusal: a session asked for by a run that isn't running (ended, or never started here). */
export const SYSTEM_RUN_ENDED = "This workflow run has ended.";

/** The refusal for assigning, giving a key or an assigned run while assignments are off (FAC-102). */
export const WORKFLOW_ASSIGNMENTS_DISABLED = "Workflow assignments aren't enabled on this instance.";

/**
 * Refusal: an approved write an assigned run proposed, whose assignment changed or ended, or whose
 * connection the trigger's gadget no longer binds, since it was proposed (FAC-102 follow-up). Left
 * pending, with nothing sent, for a person to reject.
 */
export const ASSIGNED_ACTION_STALE =
  "This action's workflow assignment changed or ended since it was proposed, so it can't be applied. Reject it.";

/** Who an assigned run's proposed action was proposed as: recorded on the action when it is queued. */
export type AssignedExecution = {
  hookId: number;
  deliveryId: number;
  credentialRef: string;
  /** The run that proposed it (FAC-104): absent on actions recorded before it. */
  runId?: string;
  /**
   * Who asked for that run (FAC-104), the initiator, beside `credentialRef`, the executor: the
   * person's profile id, or null when the trigger fired it itself. A record, never authority.
   */
  requestedBy?: string | null;
};

/**
 * Why an approved write an assigned run proposed may not apply now, or null when it may (FAC-102
 * follow-up A): assignments must be on (`enabled`), the trigger's assignment must still be the one
 * that proposed it (the same `credentialRef`, minted fresh for every assignment) on the same
 * connection, and the trigger's live gadget must still bind that connection. The run itself may
 * have ended: approval can come long after it.
 */
export function assignedActionProblem(
    host: Pick<SystemRunHost, "assignmentOf" | "liveHookGadget" | "bindingsOf" | "vendorIdOf">,
    executedAs: AssignedExecution, gatekeeperId: number, enabled: boolean): string | null {
  if (!enabled) return WORKFLOW_ASSIGNMENTS_DISABLED;
  let assignment = host.assignmentOf(executedAs.hookId);
  if (assignment?.credentialRef !== executedAs.credentialRef || assignment.gatekeeperId !== gatekeeperId) {
    return ASSIGNED_ACTION_STALE;
  }
  let gadgetId: number;
  try {
    gadgetId = host.liveHookGadget(executedAs.hookId);
  } catch {
    return ASSIGNED_ACTION_STALE;
  }
  if (host.vendorIdOf(gatekeeperId) === undefined ||
      systemRunBindingNames(host.bindingsOf(gadgetId), gatekeeperId).length === 0) {
    return ASSIGNED_ACTION_STALE;
  }
  return null;
}

/** Refusal: a run's binding asked for anything but the connection its trigger is assigned to. */
export const SYSTEM_RUN_WRONG_CONNECTION = "A workflow run reaches only the connection its trigger is assigned to.";

/** The caller a run-scoped worker's bindings carry. */
export type SystemRunCaller = { from: "systemRun"; hookId: number; deliveryId: number };

/** What one running delivery may reach. */
export type SystemRun = { hookId: number; gatekeeperId: number; credentialRef: string };

/** The delivery an assigned run executes: its id, the pinned commit and the assignment it was admitted under. */
export type AssignedDelivery = { deliveryId: number; commitId: string; credentialRef: string };

/**
 * The facet one delivery's system sessions open on: its own, per run, aborted when the run ends, so
 * every capability a session handed out dies with it (#374 round 3).
 */
export function systemGatekeeperFacetName(credentialRef: string, deliveryId: number): string {
  return `systemgatekeeper-${credentialRef}-${deliveryId}`;
}

/**
 * The runs in flight, by delivery id. A run is present only while its `WorkflowRun` call runs, so
 * a session asked for after it, or for a delivery that never started here, finds nothing. Memory
 * only: a reset of the Overseer ends every run, failing closed.
 */
export class SystemRunRegistry {
  #runs = new Map<number, SystemRun>();

  /** Records `deliveryId` as running; refuses one already running. */
  begin(deliveryId: number, run: SystemRun): void {
    if (this.#runs.has(deliveryId)) throw new Error("This run already started.");
    this.#runs.set(deliveryId, { ...run });
  }

  /** Ends `deliveryId`'s run. */
  end(deliveryId: number): void {
    this.#runs.delete(deliveryId);
  }

  /** The running delivery `caller` names, or a refusal when it isn't running or names another hook. */
  require(caller: SystemRunCaller): SystemRun {
    let run = this.#runs.get(caller.deliveryId);
    if (!run || run.hookId !== caller.hookId) throw new Error(SYSTEM_RUN_ENDED);
    return run;
  }

  /** Whether `deliveryId` is running. */
  has(deliveryId: number): boolean {
    return this.#runs.has(deliveryId);
  }

  /** The running deliveries of `credentialRef`'s assignment. */
  deliveriesOf(credentialRef: string): number[] {
    let ids: number[] = [];
    for (let [id, run] of this.#runs) if (run.credentialRef === credentialRef) ids.push(id);
    return ids;
  }
}

/** The binding names of a gadget that reach `gatekeeperId`: the only ones a run's `env` holds. */
export function systemRunBindingNames(bindings: Iterable<[string, { target: number }]>, gatekeeperId: number): string[] {
  let names: string[] = [];
  for (let [name, edge] of bindings) if (edge.target === gatekeeperId) names.push(name);
  return names;
}

/** What `runAssignedDelivery` and `openSystemRunSession` need of the Overseer. */
export interface SystemRunHost {
  systemRuns: SystemRunRegistry;
  /** The trigger's live assignment, or null. */
  assignmentOf(hookId: number): TriggerAssignment | null;
  /** Throws unless the hook is live. Returns the gadget it wakes. */
  liveHookGadget(hookId: number): number;
  /** The gadget's bindings, by name. */
  bindingsOf(gadgetId: number): Iterable<[string, { target: number }]>;
  /** The binding loopback a run's env holds for `gatekeeperId`. */
  makeLoopback(gatekeeperId: number, caller: SystemRunCaller): unknown;
  /** The gadget modules of `commitId`. */
  readModules(commitId: string): Promise<Record<string, string>>;
  /** Loads code as a fresh dynamic worker. */
  loadWorker(code: { mainModule: string; modules: Record<string, string>; env: Record<string, unknown> }):
      { getEntrypoint(name: string): unknown };
  /** The resource connection `gatekeeperId` serves, from its own record, or undefined. */
  resourceUrlOf(gatekeeperId: number): string | undefined;
  /** The vendor id of connection `gatekeeperId`, or undefined. */
  vendorIdOf(gatekeeperId: number): string | undefined;
  /** The deployment's gatekeeper vendors, by id. */
  vendor(vendorId: string): Pick<GatekeeperVendor, "getSystemGatekeeperClass"> | undefined;
  /** The facet named `name`, created with `cls` when it doesn't exist. */
  facet(name: string, cls: DurableObjectClass<Gatekeeper<any>>): Fetcher<Gatekeeper<any>>;
  /** Opens a gatekeeper session on `facet` for connection `gatekeeperId`. */
  openSession(gatekeeperId: number, facet: Fetcher<Gatekeeper<any>>, caller: SystemRunCaller): Promise<unknown>;
  /** Aborts the facet named `name`, ending everything running in it. */
  abortFacet(name: string): void;
  /** Makes the revocable wrapper an RPC capability (a stub over it), so every call reaches it. */
  wrapSession(wrapper: object): unknown;
}

// Refuses unless `caller`'s run is live now: still running, its assignment and credential reference
// unchanged, and its hook live. Every refusal reads the same and names nothing.
function assertRunLive(host: SystemRunHost, caller: SystemRunCaller, run: SystemRun): void {
  let assignment = host.assignmentOf(run.hookId);
  let gadgetId: number;
  try {
    host.systemRuns.require(caller);
    gadgetId = host.liveHookGadget(run.hookId);
  } catch {
    throw new Error(SYSTEM_RUN_ENDED);
  }
  if (assignment?.credentialRef !== run.credentialRef || assignment.gatekeeperId !== run.gatekeeperId) {
    throw new Error(SYSTEM_RUN_ENDED);
  }
  // The assigned connection must still exist and still be bound to the trigger's gadget (#374 round 3).
  if (host.vendorIdOf(run.gatekeeperId) === undefined ||
      systemRunBindingNames(host.bindingsOf(gadgetId), run.gatekeeperId).length === 0) {
    throw new Error(SYSTEM_RUN_ENDED);
  }
}

/**
 * The session a run's binding gets: every call, whichever method, first checks that the run is live
 * (`assertRunLive`), then forwards to the system session. A run ending, its assignment changing or
 * going, or its hook being deleted makes the next call fail, even through a stub the worker kept.
 */
export function revocableSession(session: object, assertLive: () => void): object {
  // Workers RPC finds no methods on a Proxy over a plain object ("The RPC receiver does not
  // implement the method"), so, as makeSystemRunCallback does, the target is callable and the
  // Proxy reports RpcTarget's prototype: every property then reaches the `get` trap below.
  return new Proxy((() => {}) as unknown as RpcTarget, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      // Async, so a refused call is that call's rejection, never a throw into the RPC machinery.
      return async (...args: unknown[]) => {
        assertLive();
        return (session as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  });
}

/**
 * Runs one admitted delivery of an assigned trigger: the delivery's pinned commit, loaded fresh,
 * whose `env` holds only the gadget's bindings to the assigned connection, each a loopback with the
 * `systemRun` caller. No `GADGET`, `GIT` or other binding is there, and the worker has no outbound
 * network, so no person's token is reachable and nothing falls back to one. Calls the code's
 * `WorkflowRun` entrypoint: `method` on it, or `run` when the firing calls the callback itself.
 */
export async function runAssignedDelivery(host: SystemRunHost, hookId: number, delivery: AssignedDelivery,
                                          method: string | null, args: unknown[]): Promise<unknown> {
  let assignment = host.assignmentOf(hookId);
  if (!assignment || assignment.credentialRef !== delivery.credentialRef) throw new Error(SYSTEM_RUN_ASSIGNMENT_CHANGED);
  if (host.systemRuns.has(delivery.deliveryId)) throw new Error("This run already started.");
  let gadgetId = host.liveHookGadget(hookId);
  let caller: SystemRunCaller = { from: "systemRun", hookId, deliveryId: delivery.deliveryId };
  let env: Record<string, unknown> = {};
  for (let name of systemRunBindingNames(host.bindingsOf(gadgetId), assignment.gatekeeperId)) {
    env[name] = host.makeLoopback(assignment.gatekeeperId, caller);
  }
  if (Object.keys(env).length === 0) {
    throw new Error("This trigger's gadget no longer binds the connection its runs are assigned to.");
  }
  let modules = await host.readModules(delivery.commitId);
  // Re-checked after the await: an assignment changed meanwhile never runs on the old one.
  if (host.assignmentOf(hookId)?.credentialRef !== delivery.credentialRef) throw new Error(SYSTEM_RUN_ASSIGNMENT_CHANGED);
  host.systemRuns.begin(delivery.deliveryId,
      { hookId, gatekeeperId: assignment.gatekeeperId, credentialRef: assignment.credentialRef });
  try {
    let worker = host.loadWorker({ mainModule: "server.js", modules, env });
    let entry = worker.getEntrypoint("WorkflowRun") as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return await entry[method ?? "run"](...args);
  } finally {
    host.systemRuns.end(delivery.deliveryId);
    // The delivery's own facet goes with it, and every capability its sessions handed out.
    host.abortFacet(systemGatekeeperFacetName(delivery.credentialRef, delivery.deliveryId));
  }
}

/**
 * A session for a running assigned delivery: only on the connection it's assigned to, through that
 * connection vendor's system class for the assignment's credential reference, never the connection's
 * own facet (a person's). Anything else is refused; there is no fallback.
 */
export async function openSystemRunSession(host: SystemRunHost, target: { type: string; id?: number },
                                           caller: SystemRunCaller): Promise<unknown> {
  let run = host.systemRuns.require(caller);
  if (target.type !== "gatekeeper" || target.id !== run.gatekeeperId) throw new Error(SYSTEM_RUN_WRONG_CONNECTION);
  let vendorId = host.vendorIdOf(run.gatekeeperId);
  let vendor = vendorId === undefined ? undefined : host.vendor(vendorId);
  let resourceUrl = host.resourceUrlOf(run.gatekeeperId);
  if (!vendor?.getSystemGatekeeperClass || resourceUrl === undefined) throw new Error(SYSTEM_RUN_UNSUPPORTED);
  let cls: DurableObjectClass<Gatekeeper<any>>;
  try {
    cls = await vendor.getSystemGatekeeperClass(run.credentialRef, { resourceUrl });
  } catch (error) {
    throw new Error(SYSTEM_RUN_UNSUPPORTED, { cause: error });
  }
  // Re-checked after the await, against the live state.
  let assignment = host.assignmentOf(run.hookId);
  if (!host.systemRuns.has(caller.deliveryId) || assignment?.credentialRef !== run.credentialRef ||
      assignment.gatekeeperId !== run.gatekeeperId) {
    throw new Error(SYSTEM_RUN_ASSIGNMENT_CHANGED);
  }
  assertRunLive(host, caller, run);
  let session = await host.openSession(run.gatekeeperId,
      host.facet(systemGatekeeperFacetName(run.credentialRef, caller.deliveryId), cls), caller);
  return host.wrapSession(revocableSession(session as object, () => assertRunLive(host, caller, run)));
}

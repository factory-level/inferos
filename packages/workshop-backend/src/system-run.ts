// Assigned runs of configured system workflows (FAC-102, inferops ADR 0011 S1-S4, inferos ADR
// 0011; see docs/architecture/operate-mode.md, "Running a trigger on request"). An admitted request
// for a trigger with an assignment runs the delivery's pinned commit in a fresh, run-scoped worker
// whose `env` holds only the gadget's bindings to the assigned connection. Each binding is a
// loopback whose caller is `systemRun`, set server-side in its props, and its sessions open on the
// connection vendor's system class for the assignment's credential reference: the service account,
// never a person. Nothing here is reachable from a client, a gadget or an agent; the Overseer wires it.

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

/** Refusal: a run's binding asked for anything but the connection its trigger is assigned to. */
export const SYSTEM_RUN_WRONG_CONNECTION = "A workflow run reaches only the connection its trigger is assigned to.";

/** The caller a run-scoped worker's bindings carry. */
export type SystemRunCaller = { from: "systemRun"; hookId: number; deliveryId: number };

/** What one running delivery may reach. */
export type SystemRun = { hookId: number; gatekeeperId: number; credentialRef: string };

/** The delivery an assigned run executes: its id, the pinned commit and the assignment it was admitted under. */
export type AssignedDelivery = { deliveryId: number; commitId: string; credentialRef: string };

/** The facet a system run's sessions open on, one per assignment credential reference. */
export function systemGatekeeperFacetName(credentialRef: string): string {
  return `systemgatekeeper-${credentialRef}`;
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
  /** The vendor id of connection `gatekeeperId`, or undefined. */
  vendorIdOf(gatekeeperId: number): string | undefined;
  /** The deployment's gatekeeper vendors, by id. */
  vendor(vendorId: string): Pick<GatekeeperVendor, "getSystemGatekeeperClass"> | undefined;
  /** The facet named `name`, created with `cls` when it doesn't exist. */
  facet(name: string, cls: DurableObjectClass<Gatekeeper<any>>): Fetcher<Gatekeeper<any>>;
  /** Opens a gatekeeper session on `facet` for connection `gatekeeperId`. */
  openSession(gatekeeperId: number, facet: Fetcher<Gatekeeper<any>>, caller: SystemRunCaller): Promise<unknown>;
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
  if (!vendor?.getSystemGatekeeperClass) throw new Error(SYSTEM_RUN_UNSUPPORTED);
  let cls: DurableObjectClass<Gatekeeper<any>>;
  try {
    cls = await vendor.getSystemGatekeeperClass(run.credentialRef);
  } catch (error) {
    throw new Error(SYSTEM_RUN_UNSUPPORTED, { cause: error });
  }
  // Re-checked after the await, against the live state.
  let assignment = host.assignmentOf(run.hookId);
  if (!host.systemRuns.has(caller.deliveryId) || assignment?.credentialRef !== run.credentialRef ||
      assignment.gatekeeperId !== run.gatekeeperId) {
    throw new Error(SYSTEM_RUN_ASSIGNMENT_CHANGED);
  }
  host.liveHookGadget(run.hookId);
  return host.openSession(run.gatekeeperId, host.facet(systemGatekeeperFacetName(run.credentialRef), cls), caller);
}

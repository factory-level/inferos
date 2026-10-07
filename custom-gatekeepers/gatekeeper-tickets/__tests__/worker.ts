// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object that plays the overseer: it instantiates the
// gatekeeper as a facet with props, hands it an approval queue that records what it is told, and
// applies the actions it collected.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionApplyFailure, ActionDescription, GatekeeperUser, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  TicketsQueueGatekeeper, TicketsFakeProvider as BaseProvider,
} from "../src/tickets.js";
import { TicketsError } from "../src/client.js";
import { FAKE_DATA_KEY, type FakeData } from "../src/fake-provider.js";
import type { Revision, Ticket, TicketStatus, TicketsQueueSession } from "../src/types.js";

export { default } from "../src/tickets.js";
// Vitest's ctx.exports analyzer does not follow `export *`, so the classes are named explicitly.
export {
  GatekeeperVendor, TicketsAccount, TicketsQueueGatekeeper, TicketsVerifier,
} from "../src/tickets.js";

/** A fault the next write meets: refused before commit, or committed with its reply lost. */
export type WriteFault = "unavailable" | "lost";

const FAULT_KEY = "test:fault";

/**
 * The fake provider plus test levers. Exported under the production name, so
 * `ctx.exports.TicketsFakeProvider` -- what every client opens -- is this class.
 */
export class TestProvider extends BaseProvider {
  /** Arms `fault` for the next write. */
  async failNextWrite(fault: WriteFault): Promise<void> {
    this.ctx.storage.kv.put(FAULT_KEY, fault);
  }

  /** Applied writes so far; 0 once the account's data is gone. */
  async appliedWrites(): Promise<number> {
    return this.ctx.storage.kv.get<FakeData>(FAKE_DATA_KEY)?.writes ?? 0;
  }

  /** One ticket as stored, bypassing the gatekeeper. */
  async peek(queueId: string, ticketId: string): Promise<Ticket | undefined> {
    return this.ctx.storage.kv.get<FakeData>(FAKE_DATA_KEY)?.queues
      .find(c => c.id === queueId)?.tickets.find(i => i.id === ticketId);
  }

  /** Changes an ticket behind the gatekeeper's back, as another user would, without counting a write. */
  async advance(queueId: string, ticketId: string): Promise<void> {
    await this.readTicket(queueId, ticketId);
    const data = this.ctx.storage.kv.get<FakeData>(FAKE_DATA_KEY)!;
    const ticket = data.queues.find(c => c.id === queueId)!.tickets.find(i => i.id === ticketId)!;
    ticket.revision = String(Number(ticket.revision) + 1);
    this.ctx.storage.kv.put(FAKE_DATA_KEY, data);
  }

  override async setStatus(queueId: string, ticketId: string, status: TicketStatus,
                            expectedRevision: Revision, idempotencyKey: string): Promise<Ticket> {
    const fault = this.ctx.storage.kv.get<WriteFault>(FAULT_KEY);
    this.ctx.storage.kv.delete(FAULT_KEY);
    if (fault === "unavailable") throw new TicketsError("UNAVAILABLE", "The provider answered 503.");
    const ticket = await super.setStatus(queueId, ticketId, status, expectedRevision, idempotencyKey);
    if (fault === "lost") throw new TicketsError("UNAVAILABLE", "The provider's response was lost.");
    return ticket;
  }
}
export { TestProvider as TicketsFakeProvider };

/** The props the Workshop bakes into one binding. */
export type BindingProps = { accountId: string; workspace: string; queueId: string };

/** What the recording approval queue was told, in order. */
export type QueueLog = {
  observations: string[];
  /** Each observation's collaborator exclusions, parallel to `observations`. */
  excluded: string[][];
  actions: Array<{ id: number; title: string }>;
};

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly log: QueueLog) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.observations.push(description.title);
    this.log.excluded.push([...(description.excludeObservers ?? [])]);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.log.actions.push({ id, title: description.title });
  }
}

/** Stands in for another account during an observer admission check. */
class TestVerifier extends RpcTarget {
  constructor(private readonly hasAccess: boolean) {
    super();
  }

  async hasQueueAccess(): Promise<boolean> {
    return this.hasAccess;
  }
}

/** Stands in for the git cache the overseer passes to `applyAction()`; never touched. */
class NoGitCache extends RpcTarget {}

type TestExports = {
  TicketsQueueGatekeeper(options: { props: BindingProps }): DurableObjectClass<TicketsQueueGatekeeper>;
  TicketsAccount(options: { props: { accountId: string } }): Fetcher<GatekeeperUser>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plays the overseer for one account. */
export class TestHooks extends DurableObject<Cloudflare.Env> {
  #log: QueueLog = { observations: [], excluded: [], actions: [] };

  #gatekeeper(props: BindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TicketsQueueGatekeeper>(
      `${props.accountId}/${props.queueId}`,
      () => ({ class: exports.TicketsQueueGatekeeper({ props }) }));
  }

  async log(): Promise<QueueLog> {
    return this.#log;
  }

  async startSession(props: BindingProps): Promise<TicketsQueueSession> {
    return this.#gatekeeper(props).startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Applies an action; the failure message, or null on success. */
  async apply(props: BindingProps, actionId: number): Promise<string | null> {
    try {
      const result = await this.#gatekeeper(props).applyAction(actionId, new RpcStub(new NoGitCache()) as never);
      return result?.failed.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Applies an action; what it reports: null once applied, the returned failure, or a thrown message. */
  async applyOutcome(props: BindingProps, actionId: number):
      Promise<ActionApplyFailure | { thrown: string } | null> {
    try {
      const result = await this.#gatekeeper(props).applyAction(actionId, new RpcStub(new NoGitCache()) as never);
      return result?.failed ?? null;
    } catch (error) {
      return { thrown: messageOf(error) };
    }
  }

  /** Admits a collaborator who can or cannot see the queue; the refusal, or null. */
  async addObserver(props: BindingProps, canSee: boolean): Promise<string | null> {
    try {
      await this.#gatekeeper(props).addObserver("observer-1", new RpcStub(new TestVerifier(canSee)) as never);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async revokeAccount(props: { accountId: string }): Promise<void> {
    await (this.ctx.exports as unknown as TestExports).TicketsAccount({ props }).revoke();
  }
}

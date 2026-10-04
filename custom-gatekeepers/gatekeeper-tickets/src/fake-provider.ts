// The synthetic Tickets service, one Durable Object per account. It stands in for the
// real API so the gatekeeper and the shared conformance suite run with no network and no
// credentials. It behaves like a careful provider should: revisions, idempotency keys and
// revocation are all enforced here, so the gatekeeper is tested against them.

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { TicketsError } from "./client";
import type { Revision, Ticket, TicketStatus } from "./types";

/** Storage key of the account's data; the test worker reads it directly. */
export const FAKE_DATA_KEY = "data";
const REVOKED_KEY = "revoked";
const APPLIED_PREFIX = "applied:";

/** The account's synthetic data. `writes` counts applied writes, never replays. */
export type FakeData = { queues: { id: string; tickets: Ticket[] }[]; writes: number };

const SEED: FakeData = {
  queues: [
    { id: "support", tickets: [
      { id: "T-1", title: "Cannot sign in", status: "open", revision: "1" },
      { id: "T-2", title: "Invoice shows the wrong address", status: "pending", revision: "1" },
      { id: "T-3", title: "Export times out", status: "closed", revision: "1" },
    ] },
    { id: "billing", tickets: [
      { id: "T-9", title: "Refund request", status: "open", revision: "1" },
    ] },
  ],
  writes: 0,
};

const notFound = () => new TicketsError("NOT_FOUND", "No such ticket in this queue.");

@validateRpc()
export class TicketsFakeProvider extends DurableObject<Cloudflare.Env> {
  /** Refuses every call once the account was revoked; its data is gone and must not re-seed. */
  #assertLive(): void {
    if (this.ctx.storage.kv.get<boolean>(REVOKED_KEY)) {
      throw new TicketsError("UNAUTHORIZED", "This account was disconnected.");
    }
  }

  #data(): FakeData {
    this.#assertLive();
    let data = this.ctx.storage.kv.get<FakeData>(FAKE_DATA_KEY);
    if (!data) this.ctx.storage.kv.put(FAKE_DATA_KEY, data = structuredClone(SEED));
    return data;
  }

  #queue(data: FakeData, queueId: string) {
    const queue = data.queues.find(c => c.id === queueId);
    if (!queue) throw notFound();
    return queue;
  }

  async hasQueue(queueId: string): Promise<boolean> {
    return this.#data().queues.some(c => c.id === queueId);
  }

  async listTickets(queueId: string): Promise<Ticket[]> {
    return this.#queue(this.#data(), queueId).tickets;
  }

  async readTicket(queueId: string, ticketId: string): Promise<Ticket> {
    const ticket = this.#queue(this.#data(), queueId).tickets.find(i => i.id === ticketId);
    if (!ticket) throw notFound();
    return ticket;
  }

  async setStatus(queueId: string, ticketId: string, status: TicketStatus,
                   expectedRevision: Revision, idempotencyKey: string): Promise<Ticket> {
    const data = this.#data();
    const replay = this.ctx.storage.kv.get<Ticket>(APPLIED_PREFIX + idempotencyKey);
    if (replay) return replay;
    const ticket = this.#queue(data, queueId).tickets.find(i => i.id === ticketId);
    if (!ticket) throw notFound();
    if (ticket.revision !== expectedRevision) {
      throw new TicketsError("STALE_REVISION", "The ticket changed after this was proposed.");
    }
    if (ticket.status === "closed" || ticket.status === status) {
      throw new TicketsError("INVALID_STATE", "The ticket is closed or already has that status.");
    }
    ticket.status = status;
    ticket.revision = String(Number(ticket.revision) + 1);
    data.writes += 1;
    this.ctx.storage.kv.put(FAKE_DATA_KEY, data);
    this.ctx.storage.kv.put(APPLIED_PREFIX + idempotencyKey, ticket);
    return ticket;
  }

  /** Deletes the account's data and leaves a tombstone, so nothing re-seeds it. */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(REVOKED_KEY, true);
  }
}

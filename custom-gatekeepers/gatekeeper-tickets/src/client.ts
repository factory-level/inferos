// The typed Tickets client the gatekeeper calls, over the synthetic `TicketsFakeProvider`. There
// is no real Tickets service; this stays a stub, never a trusted proxy. A connector with a real
// provider replaces it under the same rules:
// - keep one named method per provider call, each classified as a read or a write in
//   connection.json (never a generic `request(path)` an agent's input could steer);
// - every write takes the idempotency key the gatekeeper passes, and the revision it was proposed
//   against when the provider has one;
// - map every provider failure onto an `ErrorCode` here, and list each in connection.json's
//   providerErrors with whether a retry can succeed;
// - credentials come from the account, never from the binding or the agent.

import type { Revision, Ticket, TicketStatus } from "./types";

/** What a provider failure means, as the gatekeeper and connection.json classify it. */
export type ErrorCode =
  "NOT_FOUND" | "STALE_REVISION" | "INVALID_REQUEST" | "INVALID_STATE" | "UNAUTHORIZED" | "UNAVAILABLE";

const CODES: ReadonlySet<string> = new Set<ErrorCode>(
  ["NOT_FOUND", "STALE_REVISION", "INVALID_REQUEST", "INVALID_STATE", "UNAUTHORIZED", "UNAVAILABLE"]);

/** A classified provider failure. Its message starts with the code, which survives RPC. */
export class TicketsError extends Error {
  constructor(readonly code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TicketsError";
  }
}

/** The code a caught error carries, or null for any other failure. */
export function errorCode(error: unknown): ErrorCode | null {
  if (!(error instanceof Error)) return null;
  const match = /\b([A-Z_]+): /.exec(error.message);
  return match && CODES.has(match[1]!) ? match[1] as ErrorCode : null;
}

/** Every provider call the gatekeeper makes, for one account. */
export interface TicketsClient {
  /** Read: whether the account can see the queue. */
  hasQueue(queueId: string): Promise<boolean>;
  /** Read: every ticket of one queue. */
  listTickets(queueId: string): Promise<Ticket[]>;
  /** Read: one ticket of one queue; NOT_FOUND for an ticket of any other queue. */
  readTicket(queueId: string, ticketId: string): Promise<Ticket>;
  /** Write: move one ticket to `status` if it is still at `expectedRevision`, once per `idempotencyKey`. */
  setStatus(queueId: string, ticketId: string, status: TicketStatus, expectedRevision: Revision,
             idempotencyKey: string): Promise<Ticket>;
  /** Revocation: forget the account; every later call is refused UNAUTHORIZED. */
  forget(): Promise<void>;
}

/** The client for one account: always the fake provider. */
export function openClient(exports: Cloudflare.Exports, accountId: string): TicketsClient {
  const stub = exports.TicketsFakeProvider.getByName(accountId);
  return {
    hasQueue: queueId => stub.hasQueue(queueId),
    listTickets: queueId => stub.listTickets(queueId),
    readTicket: (queueId, ticketId) => stub.readTicket(queueId, ticketId),
    setStatus: (queueId, ticketId, status, expectedRevision, idempotencyKey) =>
      stub.setStatus(queueId, ticketId, status, expectedRevision, idempotencyKey),
    forget: () => stub.forget(),
  };
}

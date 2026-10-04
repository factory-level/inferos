/** A ticket's version as a nonnegative decimal string. A write names the one it was proposed against. */
export type Revision = string;

/** Where a ticket stands. `closed` is final for this connector: a closed ticket cannot be reopened here. */
export type TicketStatus = "open" | "pending" | "closed";

/** One ticket of the bound queue. */
export interface Ticket {
  /** Stable ticket id. */
  id: string;
  /** One-line summary. */
  title: string;
  /** Current status. */
  status: TicketStatus;
  /** The ticket's current revision. */
  revision: Revision;
}

/**
 * One support queue of the synthetic Tickets service. Every read is shown to the person as an
 * observation; every status change is a proposal they approve before anything happens.
 */
export interface TicketsQueueSession {
  /** List every ticket in the bound queue. */
  listTickets(): Promise<Ticket[]>;
  /**
   * Read one ticket of the bound queue. A ticket of another queue fails exactly as an unknown id
   * does, with NOT_FOUND.
   */
  readTicket(ticketId: string): Promise<Ticket>;
  /**
   * Propose moving one ticket to `status`, pinned to the revision you read. Nothing changes until
   * it is approved, and you wait for the decision. A closed ticket, or the status it already has,
   * fails with INVALID_STATE. If the ticket changed in the meantime the change fails with
   * STALE_REVISION; read it again and propose anew.
   */
  setStatus(ticketId: string, status: TicketStatus, expectedRevision: Revision): Promise<void>;
}

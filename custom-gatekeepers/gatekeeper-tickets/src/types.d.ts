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
  /**
   * The queue as a governed resource (FAC-9): its fields (`title`, and `status` with the values it
   * can take) and its one declared command, `setStatus`. Logged as an observation.
   */
  describe(): Promise<GovernedDescription>;
  /**
   * One page of the queue's tickets, filtered, sorted and paged here. Only the declared fields can
   * be filtered or sorted on, and a filter's value must have the field's type; anything else is
   * refused with INVALID_REQUEST before anything is read or logged. Logged as an observation; no
   * filter value is repeated into it.
   */
  list(query?: GovernedListQuery): Promise<GovernedListResult>;
  /** One ticket of the bound queue by id, or null when it has none. Logged as an observation. */
  get(id: string): Promise<GovernedRow | null>;
  /**
   * Propose a declared command on one ticket, exactly as `setStatus` does: `{ command: "setStatus",
   * id, values: { status }, expectedRevision }`. Nothing changes until it is approved. Anything but
   * a declared command with exactly its fields, an allowed value and a revision is refused with
   * INVALID_REQUEST; another queue's ticket with NOT_FOUND; a closed ticket or a no-op with
   * INVALID_STATE.
   */
  command(request: GovernedCommandRequest): Promise<{ outcome: "proposed" }>;
}

/** A field of a governed resource (FAC-9). */
export interface GovernedField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "date";
  filterable: boolean;
  sortable: boolean;
  personal?: boolean;
  /** The only values a command may set it to. */
  options?: readonly string[];
}

/** A write a governed resource declares: the only writes it takes, each proposed for a decision. */
export interface GovernedCommand {
  name: string;
  label: string;
  fields: string[];
}

/** What a governed resource offers. */
export interface GovernedDescription {
  resource: "object/table" | "tickets/queue";
  fields: GovernedField[];
  commands: GovernedCommand[];
}

/** A governed list request: at most 4 filters (all hold), one sort key, 1 to 50 rows a page. */
export interface GovernedListQuery {
  /** `eq` against a value of the field's type or null; `contains` on a text field. */
  filters?: { field: string; op: "eq" | "contains"; value: string | number | boolean | null }[];
  sort?: { field: string; order: "asc" | "desc" };
  pageSize?: number;
  /** The `nextCursor` a previous page of this same request returned. */
  cursor?: string;
}

/** One row of a governed resource. */
export interface GovernedRow {
  id: string;
  values: Record<string, string | number | boolean | null>;
  revision?: string;
}

/** One page of a governed list. */
export interface GovernedListResult {
  rows: GovernedRow[];
  nextCursor: string | null;
  total: number;
  truncated: boolean;
}

/** A declared command on one row, at the revision the row was read at. */
export interface GovernedCommandRequest {
  command: string;
  id: string;
  values: Record<string, string | number | boolean>;
  expectedRevision: Revision;
}

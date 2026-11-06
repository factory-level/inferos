/**
 * The governed data contract (FAC-9; inferops ADR 0013 W3–W5, proposed): what a source-agnostic
 * Refine provider reads and writes through, on any connector. A connector's resource session
 * describes its fields and declared commands; a list request names only those fields, through a
 * closed set of operators, and is validated here before anything is read. Listing runs on the
 * server, in the connector, over a bounded snapshot of the resource it already reads under its own
 * authority. Nothing here names a URL, a method or a service: there is no generic request.
 *
 * It grants nothing. The connection, workspace and person are the session's, fixed where the
 * session was opened; a request can only narrow what that session already returns.
 */

/** The resources a governed session serves (FAC-9): custom tables, and ticket queues. */
export type GovernedResource = "object/table" | "tickets/queue";

/**
 * The filter operators a request may use: `eq`, equality with a value of the field's own type (or
 * null), and `contains`, case-insensitive substring, on a text field only.
 */
export const GOVERNED_FILTER_OPERATORS = ["eq", "contains"] as const;
/** One of `GOVERNED_FILTER_OPERATORS`. */
export type GovernedFilterOperator = (typeof GOVERNED_FILTER_OPERATORS)[number];

/** The most rows a list reads from its resource; beyond it, `truncated` says so. */
export const GOVERNED_SNAPSHOT_MAX = 200;
/** The most rows one page returns. */
export const GOVERNED_PAGE_MAX = 50;
/** The page size when a request asks for none. */
export const GOVERNED_PAGE_DEFAULT = 25;
/** The most filters one request may combine (all must hold). */
export const GOVERNED_FILTERS_MAX = 4;

/** A field of a governed resource, as its connector describes it. */
export interface GovernedField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "date";
  /** Whether a request may filter on it. Never true for a personal field. */
  filterable: boolean;
  /** Whether a request may sort on it. Never true for a personal field. */
  sortable: boolean;
  /** Holds personal data: shown when read, never filtered or sorted on, so it can't be probed. */
  personal?: boolean;
}

/**
 * A write a connector declares for its resource (ADR 0013 W4–W6): the only writes a provider can
 * make. `fields` are the values it takes; it is proposed, decided by a person or a rule, and
 * applied by the connector, never sent directly.
 */
export interface GovernedCommand {
  name: string;
  label: string;
  fields: string[];
}

/** What a governed resource offers: its fields and its declared commands. */
export interface GovernedDescription {
  resource: GovernedResource;
  fields: GovernedField[];
  commands: GovernedCommand[];
}

/** One filter: `field` compared with `value` by `op`. */
export interface GovernedFilter {
  field: string;
  op: GovernedFilterOperator;
  value: string | number | boolean | null;
}

/** One sort key. */
export interface GovernedSort {
  field: string;
  order: "asc" | "desc";
}

/** A validated list request (`parseGovernedListRequest`). */
export interface GovernedListRequest {
  filters: GovernedFilter[];
  sort?: GovernedSort;
  pageSize: number;
  /** A cursor a previous page of this same request returned. */
  cursor?: string;
}

/** One row of a governed resource: its id, its values by field name, and its revision if it has one. */
export interface GovernedRow {
  id: string;
  values: Record<string, unknown>;
  revision?: string;
}

/** One page of a list. */
export interface GovernedListResult {
  rows: GovernedRow[];
  /** The cursor for the next page of the same request, or null after the last. */
  nextCursor: string | null;
  /** How many rows matched, within the snapshot. */
  total: number;
  /** Whether the snapshot hit `GOVERNED_SNAPSHOT_MAX`, so rows beyond it weren't considered. */
  truncated: boolean;
}

/**
 * A governed resource session (FAC-9): the read surface a connector offers for one resource,
 * fixed to its connection, workspace and person where it was opened. Each read is logged as an
 * observation by the connector.
 */
export interface GovernedReadSession {
  /** The resource's fields and declared commands. */
  describe(): Promise<GovernedDescription>;
  /** One page of rows matching `request`, validated against `describe()` first. */
  list(request: unknown): Promise<GovernedListResult>;
  /** One row by id, or null when there's no such row in this resource. */
  get(id: string): Promise<GovernedRow | null>;
}

/** Why a request was refused: fixed codes, never the data. */
export type GovernedRequestCode =
  | "INVALID_REQUEST" | "FIELD_NOT_FILTERABLE" | "FIELD_NOT_SORTABLE" | "OPERATOR_NOT_ALLOWED" | "INVALID_CURSOR";

/** A refused request: nothing was read. */
export class GovernedRequestError extends Error {
  constructor(readonly code: GovernedRequestCode, message: string) {
    super(message);
    this.name = "GovernedRequestError";
  }
}

const refuse = (code: GovernedRequestCode, message: string): never => {
  throw new GovernedRequestError(code, message);
};

const plain = (value: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("INVALID_REQUEST", `The ${what} must be an object.`);
  for (const key of Object.keys(value as object)) {
    if (!keys.includes(key)) refuse("INVALID_REQUEST", `The ${what} can't have "${key}".`);
  }
  return value as Record<string, unknown>;
};

/**
 * Validate a list request against `description`, before anything is read: only `filters`, `sort`,
 * `pageSize` and `cursor`; filters on declared filterable fields with an allowed operator and a
 * value of the field's type; one sort key on a sortable field; a page size within bounds. Anything
 * else, a URL, a method or a `meta`, is refused.
 *
 * With `description` null, only the request's shape is checked (keys, counts, operators, plain
 * values, page size): what a connector checks before it reads, when the fields come from that read.
 */
export function parseGovernedListRequest(value: unknown, description: GovernedDescription | null): GovernedListRequest {
  const request = plain(value ?? {}, ["filters", "sort", "pageSize", "cursor"], "request");
  const fields = new Map((description?.fields ?? []).map(field => [field.name, field]));
  const shapeOnly = description === null;
  const filters: GovernedFilter[] = [];
  if (request.filters !== undefined) {
    if (!Array.isArray(request.filters) || request.filters.length > GOVERNED_FILTERS_MAX) {
      refuse("INVALID_REQUEST", `A request takes at most ${GOVERNED_FILTERS_MAX} filters.`);
    }
    for (const raw of request.filters as unknown[]) {
      const filter = plain(raw, ["field", "op", "value"], "filter");
      if (typeof filter.field !== "string") refuse("INVALID_REQUEST", "A filter names one field.");
      if (!GOVERNED_FILTER_OPERATORS.includes(filter.op as GovernedFilterOperator)) {
        refuse("OPERATOR_NOT_ALLOWED", "That filter operator isn't offered.");
      }
      const plainValue = filter.value === null || ["string", "number", "boolean"].includes(typeof filter.value);
      if (!plainValue) refuse("INVALID_REQUEST", "A filter compares with one plain value.");
      if (shapeOnly) {
        filters.push({ field: filter.field as string, op: filter.op as GovernedFilterOperator, value: filter.value as GovernedFilter["value"] });
        continue;
      }
      const field = fields.get(filter.field as string);
      if (!field || !field.filterable || field.personal) refuse("FIELD_NOT_FILTERABLE", "That field can't be filtered on.");
      // A value that can't match the field's type is refused, never read as an empty result.
      if (filter.op === "contains" && field!.type !== "text") {
        refuse("OPERATOR_NOT_ALLOWED", "Only a text field can be searched for a part of its value.");
      }
      const expected = field!.type === "number" ? "number" : field!.type === "boolean" ? "boolean" : "string";
      const typed = filter.op === "contains"
        ? typeof filter.value === "string"
        : filter.value === null || typeof filter.value === expected;
      if (!typed) refuse("INVALID_REQUEST", "A filter compares with one value of the field's own type.");
      filters.push({ field: field!.name, op: filter.op as GovernedFilterOperator, value: filter.value as GovernedFilter["value"] });
    }
  }
  let sort: GovernedSort | undefined;
  if (request.sort !== undefined) {
    const raw = plain(request.sort, ["field", "order"], "sort");
    if (typeof raw.field !== "string") refuse("INVALID_REQUEST", "A sort names one field.");
    if (raw.order !== "asc" && raw.order !== "desc") refuse("INVALID_REQUEST", "A sort is ascending or descending.");
    const field = fields.get(raw.field as string);
    if (!shapeOnly && (!field || !field.sortable || field.personal)) refuse("FIELD_NOT_SORTABLE", "That field can't be sorted on.");
    sort = { field: raw.field as string, order: raw.order as GovernedSort["order"] };
  }
  const pageSize = request.pageSize ?? GOVERNED_PAGE_DEFAULT;
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > GOVERNED_PAGE_MAX) {
    refuse("INVALID_REQUEST", `A page holds 1 to ${GOVERNED_PAGE_MAX} rows.`);
  }
  if (request.cursor !== undefined && typeof request.cursor !== "string") refuse("INVALID_CURSOR", "That cursor isn't one this list made.");
  return {
    filters, ...(sort ? { sort } : {}), pageSize: pageSize as number,
    ...(request.cursor !== undefined ? { cursor: request.cursor as string } : {}),
  };
}

// What a cursor is bound to: the request's filters and sort, so a cursor made for one request
// can't page another. It is not signed: it carries only an offset into what this same request may
// already read, so an altered one can only skip within that, never reach other rows.
const fingerprint = (request: GovernedListRequest): string => JSON.stringify([request.filters, request.sort ?? null]);

const encodeCursor = (offset: number, request: GovernedListRequest): string =>
  btoa(JSON.stringify({ o: offset, f: fingerprint(request) })).replaceAll("=", "");

function decodeCursor(cursor: string, request: GovernedListRequest): number {
  try {
    const parsed = JSON.parse(atob(cursor)) as { o?: unknown; f?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.f === fingerprint(request)) {
      return parsed.o;
    }
  } catch {
    // falls through to the refusal
  }
  return refuse("INVALID_CURSOR", "That cursor isn't one this list made.");
}

const matches = (row: GovernedRow, filter: GovernedFilter): boolean => {
  const actual = row.values[filter.field];
  if (filter.op === "eq") return actual === filter.value;
  return typeof actual === "string" && typeof filter.value === "string" &&
      actual.toLowerCase().includes(filter.value.toLowerCase());
};

const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

/**
 * One page of `snapshot` for a validated `request`, on the server: the first `GOVERNED_SNAPSHOT_MAX`
 * rows the connector read, filtered (every filter must hold), sorted stably (ties by id), and cut
 * at the request's cursor and page size. A cursor for another request, or one that doesn't decode,
 * is refused; cursors are unsigned offsets (see `fingerprint`).
 */
export function listGoverned(snapshot: readonly GovernedRow[], request: GovernedListRequest): GovernedListResult {
  const truncated = snapshot.length > GOVERNED_SNAPSHOT_MAX;
  let rows = snapshot.slice(0, GOVERNED_SNAPSHOT_MAX).filter(row => request.filters.every(filter => matches(row, filter)));
  const sort = request.sort;
  rows = rows.toSorted((a, b) => {
    const order = sort ? compare(a.values[sort.field], b.values[sort.field]) * (sort.order === "desc" ? -1 : 1) : 0;
    return order || compare(a.id, b.id);
  });
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, request);
  const page = rows.slice(offset, offset + request.pageSize);
  const next = offset + request.pageSize;
  return { rows: page, nextCursor: next < rows.length ? encodeCursor(next, request) : null, total: rows.length, truncated };
}

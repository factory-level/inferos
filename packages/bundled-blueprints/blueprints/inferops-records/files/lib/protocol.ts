// The contract between this gadget's client and its Durable Object, plus the slice of the InferOps
// gatekeeper's agent-facing API (InferOpsTableSession) the Durable Object calls. Imported
// type-only, so nothing of it ships.

export type TableTargetKind = "project/issue" | "project/project" | "object/record";

export interface TableColumn {
  key: string;
  name: string;
  label: string;
  type: "text" | "number" | "integer" | "boolean" | "date" | "timestamp";
  required: boolean;
  enumValues?: string[];
}

export interface TableDescription {
  label: string;
  version: number;
  columns: TableColumn[];
  relations: Array<{ name: string; toKind: TableTargetKind }>;
}

export interface TableRecord {
  id: string;
  tableVersion: number;
  values: Record<string, string | number | boolean | null>;
  links: Array<{ relation: string; toKind: TableTargetKind; ref: string }>;
}

/** The `table` binding: one InferOps custom table, fixed by the connection. */
export interface InferOpsTableSession {
  describeTable(): Promise<TableDescription>;
  listRecords(options?: { relatedTo?: string; limit?: number }):
    Promise<{ table: TableDescription; records: TableRecord[] }>;
  getRecord(id: string): Promise<{ table: TableDescription; record: TableRecord }>;
}

/**
 * One load. Rows always come with the definition read with them. `unavailable` covers a table that
 * is missing, refused, or whose sign-in ended (the binding says which only in its message);
 * `disabled` is the deployment's switch.
 */
export type LoadRowsResult =
  | { ok: true; table: TableDescription; records: TableRecord[] }
  | { ok: false; reason: "not-connected" }
  | { ok: false; reason: "unavailable" | "disabled" | "error"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  loadRows(): Promise<LoadRowsResult>;
}

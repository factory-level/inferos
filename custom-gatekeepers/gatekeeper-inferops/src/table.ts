// Custom tables (MVP-20 slice 10): what a table binding may show, and the deployment switch for it.
//
// - Projection. Every read is projected against the definition InferOps returned with it, never one
//   read earlier. A `personal` column leaves no trace: not its name, label, list of values or value,
//   and no count or marker that one was left out. A row's values are kept only for the columns that
//   remain. Links keep their relation, kind and reference; their labels and hrefs are dropped,
//   because a column's personal flag does not cover the thing a relation points at. This removes
//   what the definition marks personal; it is not a general promise that no personal data remains
//   (a text column the table's owner did not mark personal is returned as it is).
// - Options. `relatedTo` must be an `inferops://` reference and `limit` a whole number from 1 to
//   50; there is no filter on column values in this slice. Adding one needs InferOps to return the
//   definition from the same snapshot the filter ran against, including for an empty result, or a
//   column that turned personal between the two reads could be probed through what it matches.
// - The switch (`INFEROPS_TABLES_ENABLED`) is off unless set to "true", and needs InferOps itself
//   on. Like the other switches it is checked on every call, so a binding or session that exists
//   when it is turned off is refused from its next call and resumes when it is turned back on.

import { InferOpsError, type InferOpsClient, type TableRead } from "./inferops-client";
import { assertInferOpsEnabled, guarded, inferOpsEnabled } from "./enablement";
import type {
  ListRecordsOptions, TableColumn, TableDescription, TableRecord,
} from "./types";

/** The message every call refused by the tables switch carries after its `DISABLED: ` code. */
export const TABLES_DISABLED_MESSAGE = "InferOps custom tables are turned off for this deployment.";

/** The most rows one read returns, and the default. */
export const MAX_TABLE_ROWS = 50;

const INFEROPS_REF = /^inferops:\/\/[^\s]{1,390}$/;

type TablesEnv = Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "INFEROPS_TABLES_ENABLED">;

/** Whether custom tables are on: only `"true"`, and only while InferOps itself is on. */
export function tablesEnabled(env: TablesEnv): boolean {
  return env.INFEROPS_TABLES_ENABLED === "true" && inferOpsEnabled(env);
}

/** Throw `DISABLED` while InferOps or custom tables are off, naming whichever is. */
export function assertTablesEnabled(env: TablesEnv): void {
  assertInferOpsEnabled(env);
  if (!tablesEnabled(env)) throw new InferOpsError("DISABLED", TABLES_DISABLED_MESSAGE);
}

/** A client for a table binding: every call (`forget` aside) is refused while either switch is off. */
export function whileTablesEnabled(env: TablesEnv, open: () => InferOpsClient): InferOpsClient {
  return guarded(() => assertTablesEnabled(env), open);
}

/** The options a read sends, or INVALID_REQUEST. Makes no request. */
export function tableReadOptions(options: ListRecordsOptions | undefined): { relatedTo?: string; limit: number } {
  const limit = options?.limit ?? MAX_TABLE_ROWS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TABLE_ROWS) {
    throw new InferOpsError("INVALID_REQUEST", `limit must be a whole number from 1 to ${MAX_TABLE_ROWS}.`);
  }
  const relatedTo = options?.relatedTo;
  if (relatedTo !== undefined && !INFEROPS_REF.test(relatedTo)) {
    throw new InferOpsError("INVALID_REQUEST", "relatedTo must be an inferops:// reference.");
  }
  return relatedTo === undefined ? { limit } : { relatedTo, limit };
}

/** The definition a caller may see: no personal column, and nothing that says one existed. */
export function describeTable({ table }: Pick<TableRead, "table">): TableDescription {
  return {
    label: table.label,
    version: table.version,
    columns: table.columns.filter(c => !c.personal).map((c): TableColumn => ({
      key: c.key, name: c.name, label: c.label, type: c.type, required: c.required,
      ...(c.enum ? { enumValues: [...c.enum] } : {}),
    })),
    relations: table.relations.map(r => ({ name: r.name, toKind: r.toKind })),
  };
}

/** The rows of one read, projected against the definition returned with them. */
export function projectRows(read: TableRead): { table: TableDescription; records: TableRecord[] } {
  const table = describeTable(read);
  const visible = new Set(table.columns.map(c => c.name));
  const relations = new Set(table.relations.map(r => r.name));
  return {
    table,
    records: read.rows.map(row => ({
      id: row.id,
      tableVersion: row.typeVersion,
      values: Object.fromEntries(Object.entries(row.values).filter(([name]) => visible.has(name))),
      links: row.links
        .filter(link => relations.has(link.relation))
        .map(({ relation, toKind, ref }) => ({ relation, toKind, ref })),
    })),
  };
}

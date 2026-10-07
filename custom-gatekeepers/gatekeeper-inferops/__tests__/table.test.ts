// Custom tables (MVP-20 slice 10): a read-only, private-only resource kind over the mock's demo
// table. Binding, the tables switch, projection of personal columns, the bound-table fence, every
// read an observation, private-only admission, revocation, and no writes of any kind. The HTTP
// side (the exact request, refusals, malformed answers) is in table-http.test.ts; a connected
// person's own sign-in, colliding tenant slugs and reconnects are in account.test.ts.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTableUrl, resourceKind, tableUrl } from "../src/resources";
import type { MockTables } from "../src/mock-inferops";
import type { TableProps } from "./worker";

const TABLE = "70000000-0000-4000-8000-000000000001";
const SECOND = "70000000-0000-4000-8000-000000000002";
const TABLE_URL = `inferops://demo.local/object/table/${TABLE}`;
const TABLE_PATTERN = "inferops://*/object/table/*";
const NEWEST = "71000000-0000-4000-8000-000000000003";
const ISSUE_REF = "inferops://demo.local/project/issue-link/30000000-0000-4000-8000-000000000001";
const PERSONAL_TRACES = ["custodian", "Custodian", "ana@example.test", "li@example.test", "c4"];

type Vars = { INFEROPS_ENABLED?: string; INFEROPS_TABLES_ENABLED?: string };
const vars = env as unknown as Vars;
function set(name: keyof Vars, value: string | undefined) {
  if (value === undefined) delete vars[name];
  else vars[name] = value;
}
beforeEach(() => set("INFEROPS_TABLES_ENABLED", "true"));
afterEach(() => {
  set("INFEROPS_ENABLED", undefined);
  set("INFEROPS_TABLES_ENABLED", undefined);
});

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** A fresh demo account's table binding, its mock data and a session. */
function setup(accountId: string = crypto.randomUUID()) {
  const props: TableProps = { accountId, host: "demo.local", tableId: TABLE };
  const hooks = env.TEST_HOOKS.getByName(accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${accountId}`);
  return { props, hooks, mock, session: hooks.startTableSession(props) };
}

describe("the custom table resource kind", () => {
  it("parses its grammar: a whole tenant.workspace host and a lowercase table id", () => {
    expect(parseTableUrl(`inferops://acme.operations/object/table/${TABLE}`)).toEqual({
      host: "acme.operations", tenant: "acme", workspace: "operations", tableId: TABLE,
    });
    expect(tableUrl({ host: "demo.local", tableId: TABLE })).toBe(TABLE_URL);
    expect(resourceKind(TABLE_URL)).toBe("table");
    for (const url of [
      `inferops://acme/object/table/${TABLE}`, `inferops://acme.ops:1/object/table/${TABLE}`,
      "inferops://acme.ops/object/table/A0000000-0000-4000-8000-000000000001", "inferops://acme.ops/object/table/assets",
      `inferops://acme.ops/object/table/${TABLE}/rows`, `inferops://acme.ops/object/table-view/${TABLE}`,
    ]) {
      expect(() => parseTableUrl(url), url).toThrow(/object\/table\/<tableId>/);
    }
  });

  it("is offered, pickable and bindable only while custom tables are on", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.supportedPatterns(account)).toContain(TABLE_PATTERN);
    expect(await hooks.configuratorFor(account, TABLE_PATTERN)).toBeNull();
    expect(await hooks.listPickerTables(account, "demo.local")).toEqual([
      expect.objectContaining({ value: TABLE, title: "Assets" }),
    ]);
    expect(await hooks.bindAccount("on", account, TABLE_URL)).toBeNull();

    set("INFEROPS_TABLES_ENABLED", undefined);
    expect(await hooks.supportedPatterns(account)).not.toContain(TABLE_PATTERN);
    expect(await hooks.configuratorFor(account, TABLE_PATTERN)).toContain("Unsupported");
    expect(await hooks.bindAccount("off", account, TABLE_URL)).toContain("DISABLED");

    // Off for InferOps as a whole is off for tables too, whatever the tables switch says.
    set("INFEROPS_TABLES_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await hooks.supportedPatterns(account)).not.toContain(TABLE_PATTERN);
  });

  it("refuses a missing table exactly as a host it does not serve", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    const missing = await hooks.bindAccount("missing", account,
      "inferops://demo.local/object/table/70000000-0000-4000-8000-0000000000ff");
    expect(missing).toContain("No such InferOps custom table is available to you on demo.local");
    // A host other than the demo for an account with no InferOps sign-in: never the stopgap.
    const elsewhere = await hooks.bindAccount("elsewhere", account, `inferops://acme.operations/object/table/${TABLE}`);
    expect(elsewhere).toContain("No such InferOps custom table is available to you on acme.operations");
  });
});

describe("the custom table session", () => {
  it("lists rows newest first, with the definition from the same read and no personal column", async () => {
    const { session, hooks } = setup();
    const { table, records } = await session.listRecords();
    expect(table).toMatchObject({ label: "Assets", version: 3 });
    expect(table.columns.map(c => c.name)).toEqual(["serial", "site", "status", "hours", "commissioned"]);
    expect(table.columns.find(c => c.name === "status")?.enumValues).toEqual(["in service", "repair", "retired"]);
    expect(table.relations).toEqual([{ name: "work_items", toKind: "project/issue" }]);
    expect(records.map(r => r.values.serial)).toEqual(["SN-1003", "SN-1002", "SN-1001"]);
    expect(records.every(r => r.tableVersion === table.version)).toBe(true);
    expect(records[0]!.links).toEqual([{ relation: "work_items", toKind: "project/issue", ref: ISSUE_REF }]);
    // Not the column, its label, its list, its values, nor a count that something was left out.
    const shown = JSON.stringify({ table, records });
    for (const trace of PERSONAL_TRACES) expect(shown).not.toContain(trace);
    expect((await hooks.log()).observations).toEqual(["List InferOps custom table rows"]);
  });

  it("describes the table as an observation, without the personal column", async () => {
    const { session, hooks } = setup();
    const table = await session.describeTable();
    expect(table.columns).toHaveLength(5);
    for (const trace of PERSONAL_TRACES) expect(JSON.stringify(table)).not.toContain(trace);
    const log = await hooks.log();
    expect(log.observations).toEqual(["Describe InferOps custom table"]);
    expect(log.observationTexts[0]).toContain("5 columns");
  });

  it("narrows by relatedTo and limit, and keeps the reference out of the log", async () => {
    const { session, hooks } = setup();
    expect((await session.listRecords({ relatedTo: ISSUE_REF })).records.map(r => r.id)).toEqual([NEWEST]);
    expect((await session.listRecords({ limit: 2 })).records).toHaveLength(2);
    expect((await session.listRecords({
      relatedTo: "inferops://demo.local/project/issue-link/30000000-0000-4000-8000-0000000000ff",
    })).records).toEqual([]);
    const log = await hooks.log();
    expect(log.observationTexts.join("\n")).not.toContain("issue-link");
  });

  it("refuses options it cannot use before reading anything", async () => {
    const { session, hooks } = setup();
    for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { relatedTo: "SN-1003" }]) {
      expect(await failure(session.listRecords(options)), JSON.stringify(options)).toMatch(/INVALID_REQUEST/);
    }
    expect((await hooks.log()).observations).toEqual([]);
  });

  it("reads one row of the bound table, and a row of another table as missing", async () => {
    const { session, mock, hooks } = setup();
    const { table, record } = await session.getRecord(NEWEST);
    expect(record.values).toMatchObject({ serial: "SN-1003", site: "north bay" });
    expect(record.tableVersion).toBe(table.version);
    for (const trace of PERSONAL_TRACES) expect(JSON.stringify({ table, record })).not.toContain(trace);

    // A second table of the same workspace, with a row the person can read there.
    const tables = (await mock.getTables()) as MockTables;
    await mock.setTables({
      tables: [...tables.tables, { ...tables.tables[0]!, id: SECOND, label: "Other" }],
      rows: [...tables.rows, { ...tables.rows[0]!, id: "71000000-0000-4000-8000-000000000099", typeId: SECOND }],
    });
    const foreign = await failure(session.getRecord("71000000-0000-4000-8000-000000000099"));
    const unknown = await failure(session.getRecord("71000000-0000-4000-8000-0000000000ff"));
    const garbage = await failure(session.getRecord("../../types"));
    expect(foreign).toMatch(/NOT_FOUND/);
    expect(new Set([foreign, unknown, garbage]).size).toBe(1);
    expect((await hooks.log()).observations).toEqual(["Read InferOps custom table row"]);
  });

  it("renders each read with its own definition: a column made personal since is gone at once", async () => {
    const { session, mock } = setup();
    expect((await session.describeTable()).columns.map(c => c.name)).toContain("site");
    const tables = (await mock.getTables()) as MockTables;
    await mock.setTables({ ...tables, tables: tables.tables.map(t => ({
      ...t, version: t.version + 1,
      columns: t.columns.map(c => (c.name === "site" ? { ...c, personal: true } : c)),
    })) });
    const { table, records } = await session.listRecords();
    expect(table.version).toBe(4);
    expect(table.columns.map(c => c.name)).not.toContain("site");
    expect(JSON.stringify(records)).not.toContain("north bay");
  });

  it("stops with the switch and resumes with it, and ends with the account", async () => {
    const { session, props, hooks } = setup();
    set("INFEROPS_TABLES_ENABLED", "false");
    expect(await failure(session.listRecords())).toMatch(/DISABLED/);
    set("INFEROPS_TABLES_ENABLED", "true");
    expect((await session.listRecords()).records).toHaveLength(3);
    await hooks.revokeAccount({ accountId: props.accountId });
    expect(await failure(session.listRecords())).toMatch(/UNAUTHORIZED/);
  });
});

describe("the custom table binding", () => {
  it("admits no collaborator, even one who could read the table", async () => {
    const { props, hooks } = setup();
    expect(await hooks.addTableObserver(props)).toContain("private to the person who connected it");

    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.bindAccount("shared", account, TABLE_URL)).toBeNull();
    expect(await hooks.addTableObserverFrom("shared", { accountId: account.accountId }))
      .toContain("cannot be shared");
  });

  it("has no actions, and describes itself as one table", async () => {
    const { props, hooks } = setup();
    expect(await hooks.applyTable(props)).toContain("read-only");
    expect(await hooks.describeTable(props)).toMatchObject({
      url: TABLE_URL, suggestedBindingName: "INFEROPS_TABLE", tsType: "InferOpsTableSession",
    });
  });

  it("leaves the demo data unchanged by any read", async () => {
    const { session, mock } = setup();
    await session.listRecords();
    const before = JSON.stringify(await mock.getTables());
    await session.describeTable();
    await session.listRecords({ relatedTo: ISSUE_REF, limit: 1 });
    await session.getRecord(NEWEST);
    expect(JSON.stringify(await mock.getTables())).toBe(before);
  });
});

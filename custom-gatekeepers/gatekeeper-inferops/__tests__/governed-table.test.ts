// FAC-9 PR 2: the custom table session as a governed resource (`@gadgets/workshop-shared/governed-data`):
// describe, list with filters, one sort key and cursor pages, and get by id, all run here over the
// table's own read, so no personal column is described, filtered, sorted on or returned. Every read
// is an observation, and a refused request returns nothing and logs nothing. Over the mock's demo
// table, as table.test.ts.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockTables } from "../src/mock-inferops";
import type { TableProps } from "./worker";

const TABLE = "70000000-0000-4000-8000-000000000001";
const SECOND = "70000000-0000-4000-8000-000000000002";
const SECOND_TABLE_ROW = "71000000-0000-4000-8000-000000000099";
const PERSONAL_TRACES = ["custodian", "Custodian", "ana@example.test", "li@example.test", "c4"];

type Vars = { INFEROPS_TABLES_ENABLED?: string };
const vars = env as unknown as Vars;
beforeEach(() => { vars.INFEROPS_TABLES_ENABLED = "true"; });
afterEach(() => { delete vars.INFEROPS_TABLES_ENABLED; });

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

function setup(accountId: string = crypto.randomUUID()) {
  const props: TableProps = { accountId, host: "demo.local", tableId: TABLE };
  const hooks = env.TEST_HOOKS.getByName(accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${accountId}`);
  return { props, hooks, mock, session: hooks.startTableSession(props) };
}

describe("the custom table as a governed resource (FAC-9)", () => {
  it("describes its fields without the personal column, every field filterable and sortable, and no commands", async () => {
    const { session, hooks } = setup();
    const description = await session.describe();
    expect(description).toEqual({
      resource: "object/table",
      fields: [
        { name: "serial", label: "Serial", type: "text", filterable: true, sortable: true },
        { name: "site", label: "Site", type: "text", filterable: true, sortable: true },
        { name: "status", label: "Status", type: "text", filterable: true, sortable: true },
        { name: "hours", label: "Run hours", type: "number", filterable: true, sortable: true },
        { name: "commissioned", label: "Commissioned", type: "date", filterable: true, sortable: true },
      ],
      commands: [],
    });
    for (const trace of PERSONAL_TRACES) expect(JSON.stringify(description)).not.toContain(trace);
    expect((await hooks.log()).observations).toEqual(["Describe InferOps custom table"]);
  });

  it("lists filtered, sorted and paged on the server, one observation per read, with no value repeated into the log", async () => {
    const { session, hooks } = setup();
    const first = await session.list({ sort: { field: "serial", order: "asc" }, pageSize: 2 });
    expect(first.rows.map(r => r.values.serial)).toEqual(["SN-1001", "SN-1002"]);
    expect(first).toMatchObject({ total: 3, truncated: false });
    const rest = await session.list({ sort: { field: "serial", order: "asc" }, pageSize: 2, cursor: first.nextCursor! });
    expect(rest.rows.map(r => r.values.serial)).toEqual(["SN-1003"]);
    expect(rest.nextCursor).toBeNull();
    const repair = await session.list({ filters: [{ field: "status", op: "eq", value: "repair" }] });
    expect(repair.rows.map(r => r.values.serial)).toEqual(["SN-1003"]);
    for (const trace of PERSONAL_TRACES) expect(JSON.stringify([first, rest, repair])).not.toContain(trace);
    const log = await hooks.log();
    expect(log.observations).toEqual(Array(3).fill("List InferOps custom table rows"));
    expect(log.observationTexts.join("\n")).not.toContain("repair");
  });

  it("refuses a personal or unknown field, a wrong-typed filter and any other key, returning and logging nothing", async () => {
    const { session, hooks } = setup();
    for (const request of [
      { filters: [{ field: "custodian_email", op: "eq", value: "li@example.test" }] },
      { sort: { field: "custodian_email", order: "asc" } },
      { filters: [{ field: "hours", op: "contains", value: "81" }] },
      { filters: [{ field: "hours", op: "eq", value: "8120" }] },
      { meta: { url: "https://example.com/rows" } },
      { pageSize: 51 },
    ]) {
      expect(await failure(session.list(request as never)), JSON.stringify(request)).not.toBe("");
    }
    expect((await hooks.log()).observations).toEqual([]);
  });

  it("gets one row of the bound table, and a row of another table, or none, as nothing", async () => {
    const { session, hooks, mock } = setup();
    expect(await session.get("71000000-0000-4000-8000-000000000003")).toMatchObject({
      id: "71000000-0000-4000-8000-000000000003", values: { serial: "SN-1003" },
    });
    // Another table of the same workspace, with a row of its own.
    const tables = (await mock.getTables()) as MockTables;
    await mock.setTables({
      tables: [...tables.tables, { ...tables.tables[0]!, id: SECOND, label: "Other" }],
      rows: [...tables.rows, { ...tables.rows[0]!, id: SECOND_TABLE_ROW, typeId: SECOND }],
    });
    expect(await session.get(SECOND_TABLE_ROW)).toBeNull();
    expect(await session.get("not-a-row")).toBeNull();
    expect((await hooks.log()).observations).toEqual(["Read InferOps custom table row"]);
  });

  it("says when the table holds more rows than one read returns", async () => {
    const { session, mock } = setup();
    await session.describe(); // the mock's data loads on its first read
    const tables = (await mock.getTables()) as MockTables;
    const template = tables.rows.find(row => row.typeId === TABLE)!;
    await mock.setTables({
      ...tables,
      rows: [...tables.rows, ...Array.from({ length: 60 }, (_, i) => ({
        ...template, id: `71000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, links: [],
        values: { ...template.values, serial: `SN-2${String(i).padStart(3, "0")}` },
      }))],
    });
    const page = await session.list({ pageSize: 50 });
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(50);
  });

  it("stops with the account: after a revoked sign-in it refuses, and logs nothing", async () => {
    const { session, props, hooks } = setup();
    await hooks.revokeAccount({ accountId: props.accountId });
    expect(await failure(session.list({}))).toMatch(/UNAUTHORIZED/);
    expect(await failure(session.describe())).toMatch(/UNAUTHORIZED/);
    expect((await hooks.log()).observations).toEqual([]);
  });
});

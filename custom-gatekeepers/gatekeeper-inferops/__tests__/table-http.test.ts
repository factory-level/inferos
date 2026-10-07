// Custom tables over the HTTP data source, against a fake `fetch` that answers like InferOps'
// `object.embed`: the reference names the whole `<tenant>.<workspace>`, the definition comes back
// with every column (personal ones included), and its error envelope is InferOps'. Covers what the
// mock cannot: the exact request, refusals, retries and malformed answers.

import { describe, expect, it } from "vitest";
import { openHttpInferOpsClient, type InferOpsConnection } from "../src/http-inferops";
import { inferOpsErrorCode, type TableRead } from "../src/inferops-client";
import { projectRows } from "../src/table";

const CONNECTION: InferOpsConnection = {
  baseUrl: "https://ops.example/api", host: "ops.example", token: "iex_test-secret-token",
  workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "operations",
};
const HOST = "acme.operations";
const TABLE = "70000000-0000-4000-8000-000000000001";
const OTHER_TABLE = "70000000-0000-4000-8000-000000000002";
const ROW = "71000000-0000-4000-8000-000000000001";
const ISSUE_REF = "inferops://acme.operations/project/issue-link/30000000-0000-4000-8000-000000000001";

function type(overrides: Record<string, unknown> = {}) {
  return {
    id: TABLE, name: "assets", label: "Assets", version: 4,
    columns: [
      { key: "c1", name: "serial", label: "Serial", type: "text", required: true, indexed: true, personal: false, slot: "t1" },
      { key: "c2", name: "owner_email", label: "Owner email", type: "text", required: false, indexed: false, personal: true, enum: ["a@x.test"] },
    ],
    relations: [{ id: "72000000-0000-4000-8000-000000000001", name: "work_items", toKind: "project/issue", toTypeId: null, cardinality: "many" }],
    starter: null,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW, typeId: TABLE, typeVersion: 4, headSeq: "12",
    values: { serial: "SN-1", owner_email: "a@x.test" },
    relations: [{ relation: "work_items", toKind: "project/issue", toId: "30000000-0000-4000-8000-000000000001",
      ref: ISSUE_REF, label: "Call Ana about the pump", href: "/issues/1" }],
    ...overrides,
  };
}

type Call = { method: string; path: string; ref: string | null; headers: Headers };

/** A fake InferOps answering `object.embed` with `answer(call)`, recording every request. */
function fake(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api/, ""),
      ref: url.searchParams.get("ref"),
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, client: openHttpInferOpsClient(CONNECTION, fetcher) };
}

const ok = (body: unknown) => Response.json(body);
const refused = (status: number, code: string) =>
  Response.json({ success: false, error: { code, message: `server detail for ${code}` } }, { status });

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("custom tables over HTTP", () => {
  it("reads through object.embed with the whole tenant.workspace in the reference, GET only", async () => {
    const { calls, client } = fake(() => ok({ widget: "table-view", type: type(), records: [row()] }));
    await client.readTable(HOST, TABLE, { limit: 50 });
    await client.readTable(HOST, TABLE, { relatedTo: ISSUE_REF, limit: 7 });
    expect(calls.map(c => [c.method, c.path])).toEqual([["GET", "/object/embed"], ["GET", "/object/embed"]]);
    expect(calls[0]!.ref).toBe(`inferops://${HOST}/object/table-view/${TABLE}?limit=50`);
    const second = new URL(calls[1]!.ref!.replace("inferops://", "https://"));
    expect(second.host).toBe(HOST);
    expect(second.searchParams.get("relatedTo")).toBe(ISSUE_REF);
    expect(second.searchParams.get("limit")).toBe("7");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${CONNECTION.token}`);
  });

  it("keeps a link's relation, kind and reference, and drops its label and href", async () => {
    const { client } = fake(() => ok({ widget: "table-view", type: type(), records: [row()] }));
    const read = await client.readTable(HOST, TABLE, { limit: 50 });
    expect(read.rows[0]!.links).toEqual([{ relation: "work_items", toKind: "project/issue", ref: ISSUE_REF }]);
    expect(JSON.stringify(read)).not.toContain("Call Ana");
  });

  it("projects personal columns out of what reaches a caller, leaving no trace", async () => {
    const { client } = fake(() => ok({ widget: "table-view", type: type(), records: [row()] }));
    const shown = projectRows(await client.readTable(HOST, TABLE, { limit: 50 }));
    expect(shown.table.columns.map(c => c.name)).toEqual(["serial"]);
    expect(shown.records[0]!.values).toEqual({ serial: "SN-1" });
    const text = JSON.stringify(shown);
    for (const trace of ["owner_email", "Owner email", "a@x.test", "c2"]) expect(text).not.toContain(trace);
  });

  it("reads one row by record-card, and refuses an answer about another row", async () => {
    const { calls, client } = fake(() => ok({ widget: "record-card", type: type(), record: row() }));
    const read = await client.readTableRow(HOST, ROW);
    expect(calls[0]!.ref).toBe(`inferops://${HOST}/object/record-card/${ROW}`);
    expect(read.rows.map(r => r.id)).toEqual([ROW]);

    const other = fake(() => ok({ widget: "record-card", type: type(), record: row({ id: "71000000-0000-4000-8000-000000000009" }) }));
    expect(inferOpsErrorCode(await other.client.readTableRow(HOST, ROW).catch(e => e))).toBe("UNAVAILABLE");
  });

  it("answers every refusal with one NOT_FOUND, whatever InferOps said", async () => {
    const messages = new Set<string>();
    for (const [status, code] of [[404, "NOT_FOUND"], [403, "FORBIDDEN"]] as const) {
      const { client } = fake(() => refused(status, code));
      const message = await failure(client.readTable(HOST, TABLE, { limit: 50 }));
      expect(message).toMatch(/^InferOpsError: NOT_FOUND: /);
      expect(message).not.toContain("server detail");
      messages.add(message);
    }
    // An id that is not a UUID never reaches InferOps, and reads the same.
    const { calls, client } = fake(() => ok({}));
    messages.add(await failure(client.readTable(HOST, "../types", { limit: 50 })));
    expect(calls).toEqual([]);
    expect(messages.size).toBe(1);
  });

  it("maps a refused option to INVALID_REQUEST without InferOps' text", async () => {
    const { client } = fake(() => refused(400, "VALIDATION_ERROR"));
    const message = await failure(client.readTable(HOST, TABLE, { relatedTo: ISSUE_REF, limit: 50 }));
    expect(message).toMatch(/INVALID_REQUEST/);
    expect(message).not.toContain("server detail");
  });

  it("reads once more when the table changed during the read, then gives up retryably", async () => {
    let answers = 0;
    const once = fake(() => (answers++ === 0 ? refused(409, "STALE_REVISION")
      : ok({ widget: "table-view", type: type(), records: [] })));
    expect((await once.client.readTable(HOST, TABLE, { limit: 50 })).rows).toEqual([]);
    expect(once.calls).toHaveLength(2);

    const always = fake(() => refused(409, "STALE_REVISION"));
    expect(inferOpsErrorCode(await always.client.readTable(HOST, TABLE, { limit: 50 }).catch(e => e)))
      .toBe("UNAVAILABLE");
    expect(always.calls).toHaveLength(2);
  });

  it("refuses malformed answers as UNAVAILABLE rather than trusting them", async () => {
    const answers: Array<[string, unknown]> = [
      ["another widget", { widget: "record-card", type: type(), record: row() }],
      ["another table", { widget: "table-view", type: type({ id: OTHER_TABLE }), records: [] }],
      ["a row of another version", { widget: "table-view", type: type(), records: [row({ typeVersion: 3 })] }],
      ["a row of another table", { widget: "table-view", type: type(), records: [row({ typeId: OTHER_TABLE })] }],
      ["a column without its personal flag", { widget: "table-view",
        type: type({ columns: [{ key: "c1", name: "serial", label: "Serial", type: "text", required: true }] }), records: [] }],
      ["an object value", { widget: "table-view", type: type(), records: [row({ values: { serial: { nested: 1 } } })] }],
      ["an unknown relation kind", { widget: "table-view",
        type: type({ relations: [{ name: "x", toKind: "project/secret" }] }), records: [] }],
      ["no body shape at all", ["not", "an", "object"]],
    ];
    for (const [what, body] of answers) {
      const { client } = fake(() => ok(body));
      expect(inferOpsErrorCode(await client.readTable(HOST, TABLE, { limit: 50 }).catch(e => e)), what)
        .toBe("UNAVAILABLE");
    }
  });

  it("lists the workspace's tables for the picker, ids and labels only", async () => {
    const { client } = fake(() => ok({ types: [type()] }));
    expect(await client.listTables()).toEqual([{ id: TABLE, label: "Assets" }]);
  });

  it("projects each read against its own definition, so a column that turned personal is gone", () => {
    const before: TableRead = {
      table: { id: TABLE, label: "Assets", version: 4, relations: [], columns: [
        { key: "c1", name: "serial", label: "Serial", type: "text", required: true, personal: false },
        { key: "c3", name: "site", label: "Site", type: "text", required: false, personal: false },
      ] },
      rows: [{ id: ROW, typeId: TABLE, typeVersion: 4, values: { serial: "SN-1", site: "north" }, links: [] }],
    };
    const after: TableRead = {
      table: { ...before.table, version: 5,
        columns: before.table.columns.map(c => (c.name === "site" ? { ...c, personal: true } : c)) },
      rows: [{ ...before.rows[0]!, typeVersion: 5 }],
    };
    expect(projectRows(before).records[0]!.values).toEqual({ serial: "SN-1", site: "north" });
    expect(projectRows(after).records[0]!.values).toEqual({ serial: "SN-1" });
    expect(projectRows(after).table.columns.map(c => c.name)).toEqual(["serial"]);
  });
});

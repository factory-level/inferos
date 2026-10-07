// Opt-in live run of custom tables (MVP-20): the real Workshop, the real gatekeeper Worker and the
// bundled `inferops.records` gadget, driven over the Workshop's RPC API against a running InferOps
// (for example the composed shared-api with objects on, stub auth, seeded). Skipped unless
// `INFEROPS_TABLES_LIVE_BASE_URL` is set, so CI never runs it.
//
// What it proves, against the real InferOps object API and its real data: the per-person connect
// path through a table binding (connected accounts only: tables never use the stopgap connection),
// the one `object.embed` read per call with the binding's whole `<tenant>.<workspace>`, projection
// of personal columns and link labels, refusal of a colliding tenant label and of another table's
// row, observations, and the gadget's own `loadRows()` returning only projected rows.
//
// What it does NOT prove: InferLab sign-in. InferOps refuses SSO codes for non-Google sessions
// (inferops ADR 0012), so the InferLab legs (`/authorize`, `/auth/token`, `/auth/refresh`,
// `/auth/logout`) are answered by a fixture in this file, for one synthetic identity, and the access
// token it hands out is the one given below (for example a `dev:token` persona token). Nothing in
// production code is relaxed, and nothing is stored beyond the test's own run. Every InferOps
// request, including the connect's `GET /workspaces`, goes to the real API. It does not drive a
// browser either: the gadget's client is exercised in jsdom by the blueprint's own tests.
//
// Configuration (never printed):
//   INFEROPS_TABLES_LIVE_BASE_URL     the InferOps API origin, e.g. http://localhost:15780
//   INFEROPS_TABLES_LIVE_TOKEN        a bearer token for the person, e.g. `dev:token -- owner`
//   INFEROPS_TABLES_LIVE_WORKSPACE_ID the InferOps workspace the person reads the table in
//   INFEROPS_TABLES_LIVE_TABLE_ID     a custom table there with a column marked personal
//   INFEROPS_TABLES_LIVE_OTHER_ROW_ID a row of another table of the same workspace
//   INFEROPS_TABLES_LIVE_TENANT       the person's tenant slug (default `acme`)
//   INFEROPS_TABLES_LIVE_COLLIDING    a tenant slug that also has the workspace's slug (default `internal`)
//
// Run, after `pnpm --filter @gadgets/integration-tests run test:prebuild`:
//   INFEROPS_TABLES_LIVE_BASE_URL=... INFEROPS_TABLES_LIVE_TOKEN=... ... \
//   pnpm --filter @gadgets/integration-tests exec vitest run __tests__/inferops-tables-live.test.ts

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { InferOpsTableSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import type { LoadRowsResult } from "../../bundled-blueprints/blueprints/inferops-records/files/lib/protocol.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount } from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_TABLES_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  token: process.env.INFEROPS_TABLES_LIVE_TOKEN ?? "",
  workspaceId: process.env.INFEROPS_TABLES_LIVE_WORKSPACE_ID ?? "",
  tableId: process.env.INFEROPS_TABLES_LIVE_TABLE_ID?.toLowerCase() ?? "",
  otherRowId: process.env.INFEROPS_TABLES_LIVE_OTHER_ROW_ID?.toLowerCase() ?? "",
  tenant: process.env.INFEROPS_TABLES_LIVE_TENANT ?? "acme",
  colliding: process.env.INFEROPS_TABLES_LIVE_COLLIDING ?? "internal",
};

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
/** The fixture's InferLab origin: never a real InferLab. */
const FIXTURE_INFERLAB = "https://inferlab.fixture.test";

/** Sixteen random hex digits, for fixture codes and refresh tokens. */
const randomHex = () => Array.from(randomBytes(8), byte => byte.toString(16).padStart(2, "0")).join("");

/** One line per step, printed at the end as the run's evidence. Ids and counts only. */
const evidence: string[] = [];

/** InferOps' own answer for a reference, read with the same token: the authority every step is checked against. */
async function embedDirect(ref: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${LIVE.baseUrl}/object/embed?${new URLSearchParams({ ref })}`, {
    headers: { authorization: `Bearer ${LIVE.token}`, "x-workspace-id": LIVE.workspaceId },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

/**
 * The InferLab legs for one synthetic identity. It accepts only the gatekeeper's PKCE exchange for a
 * code it issued, hands out the configured token, and reports the one configured workspace.
 */
class SignInFixture {
  readonly #codes = new Map<string, { challenge: string; redirectUri: string }>();

  authorize(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== FIXTURE_INFERLAB || url.pathname !== "/authorize") throw new Error("Not the fixture's authorize URL");
    const code = `code-${randomHex()}`;
    this.#codes.set(code, {
      challenge: url.searchParams.get("code_challenge")!, redirectUri: url.searchParams.get("redirect_uri")!,
    });
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    return back.toString();
  }

  readonly handler: Handler = async (url, method, _headers, request) => {
    if (url.origin !== FIXTURE_INFERLAB || method !== "POST") return null;
    const body = await request.json() as Record<string, string>;
    if (url.pathname === "/auth/token") {
      const pending = this.#codes.get(body.code!);
      this.#codes.delete(body.code!);
      const verified = pending && body.redirectUri === pending.redirectUri &&
        createHash("sha256").update(body.codeVerifier ?? "").digest("base64url") === pending.challenge;
      if (!verified) return Response.json({ error: { code: "INVALID_GRANT" } }, { status: 400 });
      return Response.json({
        token: LIVE.token, refreshToken: `fixture-refresh-${randomHex()}`,
        user: {
          id: "fixture-person", email: "tables-live@fixture.test", emailVerified: true, name: "Fixture person",
          tenantId: "fixture-tenant",
          workspaces: [{ workspaceId: LIVE.workspaceId, workspaceName: "Live workspace", product: "inferops", role: "member", deniedPermissions: [] }],
        },
      });
    }
    // No refresh: the configured token is used until it expires. Sign-out is accepted and forgotten.
    if (url.pathname === "/auth/refresh") return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    return null;
  };
}

const fixture = new SignInFixture();
const network = new NetworkInterceptor({ handlers: [fixture.handler] });
let harness: Harness;
let api: RpcStub<AuthenticatedApi>;
let account: ConnectedAccount;
let workspaceSlug: string;

const tableUrl = (tenant = LIVE.tenant, workspace = workspaceSlug, tableId = LIVE.tableId) =>
  `inferops://${tenant}.${workspace}/object/table/${tableId}`;

describe.skipIf(!LIVE.baseUrl)("custom tables against a live InferOps", () => {
  beforeAll(async () => {
    for (const [name, value] of Object.entries(LIVE)) if (!value) throw new Error(`Set INFEROPS_TABLES_LIVE ${name}`);
    const workspaces = await fetch(`${LIVE.baseUrl}/workspaces`, { headers: { authorization: `Bearer ${LIVE.token}` } })
      .then(r => r.json()) as Array<{ id: string; slug: string }>;
    workspaceSlug = workspaces.find(w => w.id === LIVE.workspaceId)!.slug;

    network.install();
    harness = await startHarness({
      // The gadget's own server runs, so the Worker Loader stays.
      enableGadgetExecution: true,
      gatekeepers: [{
        binding: "INFEROPS",
        dir: INFEROPS_GATEKEEPER_DIR,
        patch: config => {
          if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
          config.vars = {
            ...config.vars,
            INFERLAB_AUTH_ORIGIN: FIXTURE_INFERLAB,
            INFEROPS_BASE_URL: LIVE.baseUrl,
            BASE_URL: "http://workshop.test/gatekeeper/inferops",
            INFEROPS_TABLES_ENABLED: "true",
          };
        },
      }],
    });
    const [username] = nextUsernames("tableslive");
    api = await signUp(connect(harness.url), username!);
    const { url, nonce } = await api.connectAccount(VENDOR);
    const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
    const done = await harness.fetchWorker(GATEKEEPER_WORKER, fixture.authorize(start.headers.get("location")!));
    const ticket = JSON.parse(/var ticket = (".*?");\n/.exec(await done.text())![1]!);
    await api.completeConnectHandoff(ticket, nonce);
    account = await waitFor("the connected InferOps account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR) ?? null);
  }, 120_000);

  afterAll(async () => {
    try {
      await harness?.server.close();
    } finally {
      network.uninstall();
      console.log(`\nLive custom-table evidence:\n${evidence.map(line => `  ${line}`).join("\n")}\n`);
    }
  });

  it("reads the table as the person, with InferOps' rows and no personal column or link label", async () => {
    const ws = await api.newGadget();
    const connection = await ws.newGatekeeper(account.id, tableUrl());
    if (!connection) throw new Error("No connection");
    const session = await connection.openSession() as RpcStub<InferOpsTableSession>;
    const { table, records } = await session.listRecords();

    const direct = await embedDirect(`inferops://${LIVE.tenant}.${workspaceSlug}/object/table-view/${LIVE.tableId}?limit=50`);
    expect(direct.status).toBe(200);
    const upstream = direct.body as { type: { columns: Array<{ name: string; label: string; personal: boolean }> }; records: Array<{ id: string; values: Record<string, unknown>; relations: Array<{ label: string | null }> }> };
    const personal = upstream.type.columns.filter(c => c.personal);
    expect(personal.length).toBeGreaterThan(0);
    expect(records.map(r => r.id)).toEqual(upstream.records.map(r => r.id));
    expect(table.columns.map(c => c.name)).toEqual(upstream.type.columns.filter(c => !c.personal).map(c => c.name));
    const shown = JSON.stringify({ table, records });
    for (const column of personal) {
      expect(shown).not.toContain(`"${column.name}"`);
      for (const row of upstream.records) {
        const value = row.values[column.name];
        if (typeof value === "string") expect(shown).not.toContain(value);
      }
    }
    for (const row of upstream.records) {
      for (const link of row.relations) if (link.label) expect(shown).not.toContain(link.label);
    }
    expect(records.every(r => r.tableVersion === table.version)).toBe(true);
    const observed = (await ws.listActions({ filter: "observation" })).entries.map(e => e.description.title);
    expect(observed).toContain("List InferOps custom table rows");
    evidence.push(`bind+listRecords: ${records.length} rows, ${table.columns.length} visible of ${upstream.type.columns.length} columns, ${personal.length} personal withheld`);
  });

  it("attack: a colliding tenant label is refused by InferOps, and another table's row reads as missing", async () => {
    const collidingHost = `${LIVE.colliding}.${workspaceSlug}`;
    expect((await embedDirect(`inferops://${collidingHost}/object/table-view/${LIVE.tableId}`)).status).toBe(404);
    const ws = await api.newGadget();
    await expect(ws.newGatekeeper(account.id, tableUrl(LIVE.colliding)))
      .rejects.toThrow(`No such InferOps custom table is available to you on ${collidingHost}.`);

    const connection = await ws.newGatekeeper(account.id, tableUrl());
    const session = await connection!.openSession() as RpcStub<InferOpsTableSession>;
    expect((await embedDirect(`inferops://${LIVE.tenant}.${workspaceSlug}/object/record-card/${LIVE.otherRowId}`)).status).toBe(200);
    await expect(session.getRecord(LIVE.otherRowId)).rejects.toThrow(/NOT_FOUND/);
    evidence.push(`refused: ${collidingHost} at bind (InferOps 404); another table's row via getRecord (NOT_FOUND)`);
  });

  it("the installed inferops.records gadget loads the same projected rows through its own Durable Object", async () => {
    using installed = await api.newGadgetFromBlueprint("inferops.records", {
      table: { type: "gatekeeper", accountId: account.id, resourceUrl: tableUrl() },
    });
    const { defaultGadgetId } = await installed.getMetadata();
    if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
    using gadget = await installed.getGadget(defaultGadgetId);
    using facet = await gadget.connectToGadget() as RpcStub<{ loadRows(): Promise<LoadRowsResult> }>;
    const result = await facet.loadRows();
    if (!result.ok) throw new Error(`loadRows: ${result.reason}`);
    const direct = await embedDirect(`inferops://${LIVE.tenant}.${workspaceSlug}/object/table-view/${LIVE.tableId}?limit=50`);
    const upstream = direct.body as { type: { columns: Array<{ name: string; personal: boolean }> }; records: Array<{ id: string }> };
    expect(result.records.map(r => r.id)).toEqual(upstream.records.map(r => r.id));
    for (const column of upstream.type.columns.filter(c => c.personal)) {
      expect(JSON.stringify(result)).not.toContain(`"${column.name}"`);
    }
    evidence.push(`gadget loadRows: ${result.records.length} rows of "${result.table.label}" v${result.table.version}`);
  });
});

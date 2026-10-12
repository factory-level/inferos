// Opt-in live run of workspace members (MVP-18): the real Workshop and the real gatekeeper Worker,
// driven over the Workshop's RPC API against a running InferOps in stub auth mode (for example the
// composed shared-api, seeded). Skipped unless `INFEROPS_MEMBERS_LIVE_BASE_URL` is set, so CI never
// runs it.
//
// What it proves, against InferOps' real `member.list` and its real seeded data, with real person
// tokens: a seeded owner and a seeded viewer each connect, bind `inferops://acme.operations/portal/
// members` and read exactly InferOps' own answer for that workspace minus the email (the M1 fields:
// workspace {workspaceId, workspaceName, product}; members {principalId, type, name, role,
// deniedPermissions}), the viewer the same list as the owner; a workspace the person does not hold
// is refused at bind with the one message; a second tenant's person never reads the first tenant's
// list (the tenant label is inert: `member.list` reads the X-Workspace-Id workspace, and a slug only
// ever resolves to the person's own workspace); and InferOps itself refuses (403) each of those
// persons' tokens pinned to a workspace it holds no grant in, the answer the gatekeeper's client
// reads as its one NOT_FOUND (`members-http.test.ts`). Observations name the workspace and a
// count, never a member.
//
// The installed `inferops.members` gadget is read the same way, through its own Durable Object.
//
// What it does NOT prove: InferLab sign-in. As in `inferops-tables-live.test.ts`, the InferLab legs
// (`/authorize`, `/auth/token`, `/auth/refresh`, `/auth/logout`) are answered by a fixture in this
// file. The token and memberships it hands out are the real ones InferOps' stub login
// (`POST /auth/inferlab-login`) returns for each seeded persona, so the persona must exist and the
// API must be in stub mode. Nothing in production code is relaxed. Every InferOps request, including
// the connect's `GET /workspaces`, goes to the real API. Tokens last 900 s, so run it right after
// the prebuild.
//
// Configuration (never printed):
//   INFEROPS_MEMBERS_LIVE_BASE_URL  the InferOps API origin, e.g. http://localhost:8080
//   INFEROPS_MEMBERS_LIVE_ORIGIN    an origin the API's CORS allows (default http://localhost:3000)
//   INFEROPS_MEMBERS_LIVE_OWNER     the owner persona (default `owner`, acme/operations)
//   INFEROPS_MEMBERS_LIVE_VIEWER    the viewer persona (default `viewer`, acme/operations only)
//   INFEROPS_MEMBERS_LIVE_OTHER     a second tenant's persona (default `canary-inspector`)
//
// Run, after `pnpm --filter @gadgets/integration-tests run test:prebuild`:
//   INFEROPS_MEMBERS_LIVE_BASE_URL=... \
//   pnpm --filter @gadgets/integration-tests exec vitest run __tests__/inferops-members-live.test.ts

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type {
  InferOpsMembersSession, WorkspaceMembers,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import type { LoadMembersResult } from "../../bundled-blueprints/blueprints/inferops-members/files/lib/protocol.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount } from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_MEMBERS_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  origin: process.env.INFEROPS_MEMBERS_LIVE_ORIGIN ?? "http://localhost:3000",
  owner: process.env.INFEROPS_MEMBERS_LIVE_OWNER ?? "owner",
  viewer: process.env.INFEROPS_MEMBERS_LIVE_VIEWER ?? "viewer",
  other: process.env.INFEROPS_MEMBERS_LIVE_OTHER ?? "canary-inspector",
};

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
/** The fixture's InferLab origin: never a real InferLab. */
const FIXTURE_INFERLAB = "https://inferlab.fixture.test";
const MEMBERS_URL = "inferops://acme.operations/portal/members";

/** Sixteen random hex digits, for fixture codes and refresh tokens. */
const randomHex = () => Array.from(randomBytes(8), byte => byte.toString(16).padStart(2, "0")).join("");

/** One line per step, printed at the end as the run's evidence. Ids and counts only. */
const evidence: string[] = [];

type Membership = { workspaceId: string; workspaceName: string; product: string; role: string; deniedPermissions: string[] };
type SessionUser = { id: string; email: string; name: string; tenantId: string; workspaces: Membership[] };
/** One seeded persona, signed in through InferOps' stub login: its access token and session user. */
type Person = { token: string; user: SessionUser };

async function signIn(personaId: string): Promise<Person> {
  const response = await fetch(`${LIVE.baseUrl}/auth/inferlab-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: LIVE.origin },
    body: JSON.stringify({ personaId, product: "inferops" }),
  });
  if (!response.ok) throw new Error(`Stub login for ${personaId}: ${response.status}`);
  const token = response.headers.getSetCookie().map(c => c.split(";")[0] ?? "")
    .find(c => c.startsWith("iex_at="))?.slice("iex_at=".length);
  if (!token) throw new Error(`Stub login for ${personaId} set no access token`);
  return { token, user: (await response.json() as { user: SessionUser }).user };
}

type MembersBody = { workspace: Record<string, unknown>; members: Array<Record<string, unknown>> };

/** InferOps' own `member.list` answer, read with the person's token: the authority each read is checked against. */
async function membersDirect(person: Person, workspaceId: string): Promise<{ status: number; body: MembersBody }> {
  const response = await fetch(`${LIVE.baseUrl}/workspace/members`, {
    headers: { authorization: `Bearer ${person.token}`, "x-workspace-id": workspaceId },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as MembersBody };
}

/** The M1 projection of InferOps' answer: every field but the email, nothing added. */
function withoutEmail(body: MembersBody): WorkspaceMembers {
  const { workspaceId, workspaceName, product } = body.workspace;
  return {
    workspace: { workspaceId, workspaceName, product } as WorkspaceMembers["workspace"],
    members: body.members.map(({ principalId, type, name, role, deniedPermissions }) =>
      ({ principalId, type, name, role, deniedPermissions })) as WorkspaceMembers["members"],
  };
}

/**
 * The InferLab legs, answering each connect for the person it was started for. It accepts only the
 * gatekeeper's PKCE exchange for a code it issued, and hands out that person's real token and
 * memberships.
 */
class SignInFixture {
  readonly #codes = new Map<string, { challenge: string; redirectUri: string; person: Person }>();

  authorize(authorizeUrl: string, person: Person): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== FIXTURE_INFERLAB || url.pathname !== "/authorize") throw new Error("Not the fixture's authorize URL");
    const code = `code-${randomHex()}`;
    this.#codes.set(code, {
      challenge: url.searchParams.get("code_challenge")!, redirectUri: url.searchParams.get("redirect_uri")!, person,
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
        token: pending.person.token, refreshToken: `fixture-refresh-${randomHex()}`,
        user: { ...pending.person.user, emailVerified: true },
      });
    }
    // No refresh: the token is used until it expires. Sign-out is accepted and forgotten.
    if (url.pathname === "/auth/refresh") return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    return null;
  };
}

const fixture = new SignInFixture();
const network = new NetworkInterceptor({ handlers: [fixture.handler] });
let harness: Harness;
const people: Record<"owner" | "viewer" | "other", { person: Person; api: RpcStub<AuthenticatedApi>; account: ConnectedAccount }> = {} as never;

/** The person's own InferOps workspace with the slug `operations`. */
const opsOf = (person: Person) => person.user.workspaces.find(w => w.product === "inferops")!.workspaceId;

async function connectPerson(label: string, person: Person) {
  const [username] = nextUsernames(`members${label}`);
  const api = await signUp(connect(harness.url), username!);
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fixture.authorize(start.headers.get("location")!, person));
  const ticket = JSON.parse(/var ticket = (".*?");\n/.exec(await done.text())![1]!);
  await api.completeConnectHandoff(ticket, nonce);
  const account = await waitFor(`the ${label}'s connected InferOps account`, async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR) ?? null);
  return { person, api, account };
}

async function readAs(who: keyof typeof people, resourceUrl = MEMBERS_URL) {
  const { api, account } = people[who];
  const ws = await api.newGadget();
  const connection = await ws.newGatekeeper(account.id, resourceUrl);
  if (!connection) throw new Error("No connection");
  const session = await connection.openSession() as RpcStub<InferOpsMembersSession>;
  return { ws, read: await session.listMembers() };
}

describe.skipIf(!LIVE.baseUrl)("workspace members against a live InferOps", () => {
  beforeAll(async () => {
    const [owner, viewer, other] = await Promise.all([signIn(LIVE.owner), signIn(LIVE.viewer), signIn(LIVE.other)]);

    network.install();
    harness = await startHarness({
      // The installed gadget's server runs in the Workshop's Worker loader.
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
            INFEROPS_MEMBERS_ENABLED: "true",
          };
        },
      }],
    });
    people.owner = await connectPerson("owner", owner!);
    people.viewer = await connectPerson("viewer", viewer!);
    people.other = await connectPerson("other", other!);
  }, 120_000);

  afterAll(async () => {
    try {
      await harness?.server.close();
    } finally {
      network.uninstall();
      console.log(`\nLive workspace-members evidence:\n${evidence.map(line => `  ${line}`).join("\n")}\n`);
    }
  });

  it("an owner and a viewer read their workspace's members: InferOps' answer minus the email", async () => {
    const workspaceId = opsOf(people.owner.person);
    expect(opsOf(people.viewer.person)).toBe(workspaceId);
    const direct = await membersDirect(people.owner.person, workspaceId);
    expect(direct.status).toBe(200);
    expect(direct.body.members.length).toBeGreaterThan(0);
    expect(direct.body.members.every(m => typeof m.email === "string" || m.email === null)).toBe(true);

    const owner = await readAs("owner");
    expect(owner.read).toEqual(withoutEmail(direct.body));
    expect(Object.keys(owner.read.workspace).toSorted()).toEqual(["product", "workspaceId", "workspaceName"]);
    for (const member of owner.read.members) {
      expect(Object.keys(member).toSorted()).toEqual(["deniedPermissions", "name", "principalId", "role", "type"]);
    }
    const shown = JSON.stringify(owner.read);
    for (const member of direct.body.members) {
      if (typeof member.email === "string" && member.email) expect(shown).not.toContain(member.email);
    }

    const viewer = await readAs("viewer");
    const viewerDirect = await membersDirect(people.viewer.person, workspaceId);
    expect(viewerDirect.status).toBe(200);
    expect(viewer.read).toEqual(withoutEmail(viewerDirect.body));
    expect(viewer.read).toEqual(owner.read);

    const observed = (await owner.ws.listActions({ filter: "observation" })).entries.map(e => e.description);
    expect(observed.map(d => d.title)).toContain("List InferOps workspace members");
    const said = JSON.stringify(observed);
    for (const member of owner.read.members) expect(said).not.toContain(member.name);
    evidence.push(`owner+viewer bind+listMembers: ${owner.read.members.length} members of ${workspaceId}, equal to member.list minus email; viewer list equals owner list`);
  });

  it("the installed inferops.members gadget loads the same projection through its own Durable Object", async () => {
    const workspaceId = opsOf(people.owner.person);
    for (const who of ["owner", "viewer"] as const) {
      const { api, account, person } = people[who];
      using installed = await api.newGadgetFromBlueprint("inferops.members", {
        members: { type: "gatekeeper", accountId: account.id, resourceUrl: MEMBERS_URL },
      });
      const { defaultGadgetId } = await installed.getMetadata();
      if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
      using gadget = await installed.getGadget(defaultGadgetId);
      using facet = await gadget.connectToGadget() as RpcStub<{ loadMembers(): Promise<LoadMembersResult> }>;
      const result = await facet.loadMembers();
      if (!result.ok) throw new Error(`loadMembers as ${who}: ${result.reason}`);
      const direct = await membersDirect(person, workspaceId);
      expect(direct.status).toBe(200);
      expect({ workspace: result.workspace, members: result.members }).toEqual(withoutEmail(direct.body));
      const shown = JSON.stringify(result);
      for (const member of direct.body.members) {
        if (typeof member.email === "string" && member.email) expect(shown).not.toContain(member.email);
      }
      evidence.push(`gadget loadMembers as ${who}: ${result.members.length} members of ${result.workspace.workspaceId}, equal to member.list minus email`);
    }
  });

  it("attack: a workspace the person does not hold is refused at bind, with one message", async () => {
    // acme/knowledge is listed to the viewer but is InferMind; synthetics/probe is not theirs at all.
    for (const [who, url, host] of [
      ["viewer", "inferops://acme.knowledge/portal/members", "acme.knowledge"],
      ["owner", "inferops://synthetics.probe/portal/members", "synthetics.probe"],
    ] as const) {
      const ws = await people[who].api.newGadget();
      await expect(ws.newGatekeeper(people[who].account.id, url))
        .rejects.toThrow(`No InferOps member list is available to you on ${host}.`);
    }
    evidence.push("refused at bind: viewer on acme.knowledge (InferMind), owner on synthetics.probe (not held)");
  });

  it("attack: a second tenant's person never reads the first tenant's list; the tenant label is inert", async () => {
    const acmeOps = opsOf(people.owner.person);
    const otherOps = opsOf(people.other.person);
    expect(otherOps).not.toBe(acmeOps);
    const acme = await membersDirect(people.owner.person, acmeOps);
    const theirs = await membersDirect(people.other.person, otherOps);
    expect(theirs.status).toBe(200);

    // The same URL, bound by the other tenant's person, reads their own `operations` workspace.
    const { read } = await readAs("other");
    expect(read).toEqual(withoutEmail(theirs.body));
    expect(read.workspace.workspaceId).toBe(otherOps);
    const acmeOnly = acme.body.members.map(m => m.principalId as string)
      .filter(id => !theirs.body.members.some(m => m.principalId === id));
    expect(acmeOnly.length).toBeGreaterThan(0);
    for (const id of acmeOnly) expect(JSON.stringify(read)).not.toContain(id);
    evidence.push(`other tenant on ${MEMBERS_URL}: its own ${otherOps} (${read.members.length} members), none of acme's ${acmeOnly.length} acme-only principals`);
  });

  it("attack: InferOps refuses each token pinned to a workspace it holds no grant in", async () => {
    const acmeOps = opsOf(people.owner.person);
    const otherOps = opsOf(people.other.person);
    const knowledge = people.owner.person.user.workspaces.find(w => w.product === "infermind")!.workspaceId;
    for (const [who, workspaceId] of [
      ["viewer", knowledge], ["owner", otherOps], ["other", acmeOps],
    ] as const) {
      const direct = await membersDirect(people[who].person, workspaceId);
      expect(direct.status).toBe(403);
      expect(JSON.stringify(direct.body)).not.toContain("principalId");
    }
    evidence.push("InferOps 403, no member in the body: viewer on acme/knowledge, owner on the other tenant, other tenant on acme/operations");
  });
});

// Opt-in local proof of Wiki proposal approval (MVP-40): the real Workshop and the real gatekeeper
// Worker, driven over the Workshop's RPC API against a LOCAL InferOps carrying the proposal routes
// (inferops#2368) with Wiki publishing on: inferops' test-only `wiki-proposal-proof-server.ts`
// (the composed app in-process on 127.0.0.1, a disposable database, no worker), with two proposals
// stored by its test-only `wiki-proposal-proof-seed.ts`. Skipped unless
// `INFEROPS_WIKI_LIVE_BASE_URL` is set, so CI never runs it.
//
// What it proves, with real person tokens over per-person connections (never the stopgap):
// - L1: the owner binds `inferops://acme.knowledge/knowledge/wiki`, and `listProposals` and
//   `readProposal` equal InferOps' own `proposal.get` answer for that person, as observations;
// - L2: `approveProposal` stages one pending action and sends nothing: InferOps still shows
//   `in_review`;
// - L3: approving it applies it as the owner: InferOps shows `approved`, decided by the owner, at
//   the hash, and nothing in InferOS or InferOps says published;
// - L4: approving the applied action again is refused as not pending, and InferOps itself replays a
//   same-principal, same-hash resend without changing the decision;
// - L5: the member, who lacks `knowledge:publish`, is refused FORBIDDEN at apply and the action
//   stays pending; the proposal stays in review;
// - L6: the owner's approval of the proposal the owner requested is refused for good (CONFLICT),
//   and the proposal stays in review, unapproved.
// The publish-job count (exactly one, for P1 only) is read by the seed's `verify` step after this
// file runs, since the job table is in InferOps' database.
//
// Step B (MVP-40 worker proof), opt-in again with `INFEROPS_WIKI_LIVE_PUBLISH`, one phase per run
// of this file. The approval phase above runs with it unset, before any job consumer exists (L3
// asserts nothing was published yet). Then the runner starts inferops' test-only
// `wiki-publish-consumer.ts` (the real `knowledge.wiki.publish` job only, from the real queued
// envelope) and runs this file again:
// - `published`: L-B1, the owner reads P1 published into its target at expectedVersion + 1 (a
//   bounded wait while the consumer runs the queued job); L-B2, the page keeps its id, slug,
//   parent and pillar membership, has P1's title and content, and no Master role; L-B4, P2 and the
//   member's refused approval published nothing;
// - then the runner tells the consumer to redeliver P1's completed job envelope once, and waits for
//   it to settle; `redelivered`: L-B3, P1 is still published at the same version and the page did
//   not change, and a direct same-hash approval by the owner replays without queueing a job.
// The job counts and states, sibling order and provenance are read by the seed's `verify` after
// each phase. Only the describe of the selected phase runs.
//
// What it does NOT prove: InferLab sign-in (the InferLab legs are a fixture, as in
// `inferops-members-live.test.ts`; the tokens are InferOps' real stub-login tokens), publication
// (no worker runs; the proof stops at approved and queued), a deployed InferOps, the shared-gadget
// and stopgap refusals, the uncertain prior dispatch and the no-replay cases (all covered against
// the mock in the gatekeeper's own suite, `wiki.test.ts`, and not repeated here).
//
// Configuration (never printed):
//   INFEROPS_WIKI_LIVE_BASE_URL  the local InferOps API origin, e.g. http://127.0.0.1:8380
//   INFEROPS_WIKI_LIVE_ORIGIN    an origin the API's CORS allows (default http://localhost:3000)
//   INFEROPS_WIKI_LIVE_SEED      the JSON the seed printed (path to a file)
//   INFEROPS_WIKI_LIVE_PUBLISH   unset (approval), `published` or `redelivered` (Step B phases)
//
// Run, after `pnpm --filter @gadgets/integration-tests run test:prebuild`:
//   INFEROPS_WIKI_LIVE_BASE_URL=... INFEROPS_WIKI_LIVE_SEED=... \
//   pnpm --filter @gadgets/integration-tests exec vitest run __tests__/inferops-wiki-proposals-live.test.ts

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { InferOpsWikiSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount } from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_WIKI_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  origin: process.env.INFEROPS_WIKI_LIVE_ORIGIN ?? "http://localhost:3000",
  seed: process.env.INFEROPS_WIKI_LIVE_SEED ?? "",
  publish: process.env.INFEROPS_WIKI_LIVE_PUBLISH ?? "",
};
if (!["", "published", "redelivered"].includes(LIVE.publish)) {
  throw new Error("INFEROPS_WIKI_LIVE_PUBLISH must be unset, published or redelivered.");
}

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
/** The fixture's InferLab origin: never a real InferLab. */
const FIXTURE_INFERLAB = "https://inferlab.fixture.test";
const WIKI_URL = "inferops://acme.knowledge/knowledge/wiki";

type SeededProposal = { id: string; proposalHash: string; requestedBy: string; sources: { sectionId: string; version: number }[] };
type Seed = {
  tag: string; lane: string; p1: SeededProposal & { targetDocumentId: string; expectedVersion: number };
  p2: SeededProposal; p1Parent: { id: string; siblingOrder: number };
};

const randomHex = () => Array.from(randomBytes(8), byte => byte.toString(16).padStart(2, "0")).join("");

/** One line per step, printed at the end as the run's evidence. Ids, states and counts only. */
const evidence: string[] = [];

type Membership = { workspaceId: string; workspaceName: string; product: string; role: string; deniedPermissions: string[] };
type SessionUser = { id: string; email: string; name: string; tenantId: string; workspaces: Membership[] };
type Person = { token: string; user: SessionUser };

async function signIn(personaId: string): Promise<Person> {
  const response = await fetch(`${LIVE.baseUrl}/auth/inferlab-login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: LIVE.origin },
    body: JSON.stringify({ personaId, product: "infermind" }),
  });
  if (!response.ok) throw new Error(`Stub login for ${personaId}: ${response.status}`);
  const token = response.headers.getSetCookie().map(c => c.split(";")[0] ?? "")
    .find(c => c.startsWith("iex_at="))?.slice("iex_at=".length);
  if (!token) throw new Error(`Stub login for ${personaId} set no access token`);
  return { token, user: (await response.json() as { user: SessionUser }).user };
}

/** The person's InferMind workspace `knowledge`. */
const knowledgeOf = (person: Person) => person.user.workspaces.find(w => w.product === "infermind")!.workspaceId;

type ProposalBody = { proposal: Record<string, unknown>; freshness: Record<string, unknown> };

/** InferOps' own `proposal.get`, read with the person's token: the authority each step is checked against. */
async function proposalDirect(person: Person, id: string): Promise<{ status: number; body: ProposalBody }> {
  const response = await fetch(`${LIVE.baseUrl}/knowledge/wiki/proposals/${id}`, {
    headers: { authorization: `Bearer ${person.token}`, "x-workspace-id": knowledgeOf(person) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as ProposalBody };
}

/** InferOps' own `proposal.approve`, sent directly with the person's token. */
async function approveDirect(person: Person, id: string, proposalHash: string, sources: SeededProposal["sources"]) {
  const response = await fetch(`${LIVE.baseUrl}/knowledge/wiki/proposals/${id}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${person.token}`, "x-workspace-id": knowledgeOf(person), "content-type": "application/json",
    },
    body: JSON.stringify({ proposalHash, sources }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as { proposal?: Record<string, unknown> } };
}

/** The InferLab legs, handing out the person's real stub-login token (see the header). */
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
    if (url.pathname === "/auth/refresh") return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    return null;
  };
}

const fixture = new SignInFixture();
const network = new NetworkInterceptor({ handlers: [fixture.handler] });
let harness: Harness;
let seed: Seed;
const people: Record<"owner" | "member", { person: Person; api: RpcStub<AuthenticatedApi>; account: ConnectedAccount }> = {} as never;

async function connectPerson(label: string, person: Person) {
  const [username] = nextUsernames(`wikiproposal${label}`);
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

/** A fresh gadget of the person's with the Wiki bound, and its session. */
async function wikiOf(who: keyof typeof people) {
  const { api, account } = people[who];
  const ws = await api.newGadget();
  const connection = await ws.newGatekeeper(account.id, WIKI_URL);
  if (!connection) throw new Error("No connection");
  const session = await connection.openSession() as RpcStub<InferOpsWikiSession>;
  return { ws, session };
}

type Gadget = Awaited<ReturnType<typeof wikiOf>>["ws"];

/** The one action the next proposal queues. */
async function staged(ws: Gadget, propose: () => Promise<unknown>) {
  const before = new Set((await ws.listActions({ filter: "pending" })).entries.map(a => a.id));
  await propose();
  const added = (await ws.listActions({ filter: "pending" })).entries.filter(a => !before.has(a.id));
  expect(added).toHaveLength(1);
  return added[0]!;
}

const entryOf = async (ws: Gadget, id: number) => (await ws.listActions({ filter: "all" })).entries.find(a => a.id === id);
const failure = (call: Promise<unknown>) =>
  call.then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error));

async function setUp(): Promise<void> {
  if (!LIVE.seed) throw new Error("INFEROPS_WIKI_LIVE_SEED must name the seed's JSON.");
  seed = JSON.parse(readFileSync(LIVE.seed, "utf8")) as Seed;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(LIVE.baseUrl)) {
    throw new Error("INFEROPS_WIKI_LIVE_BASE_URL must be a local InferOps.");
  }
  const [owner, member] = await Promise.all([signIn("owner"), signIn("member")]);

  network.install();
  harness = await startHarness({
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
        };
        // Never the stopgap: no shared InferOps token reaches this gatekeeper.
        delete (config.vars as Record<string, unknown>).INFEROPS_API_TOKEN;
      },
    }],
  });
  people.owner = await connectPerson("owner", owner!);
  people.member = await connectPerson("member", member!);
  expect(knowledgeOf(owner!)).toBe(knowledgeOf(member!));
}

async function tearDown(): Promise<void> {
  try {
    await harness?.server.close();
  } finally {
    const escaped = network.getUnmockedCalls();
    network.uninstall();
    evidence.push(`unmocked non-loopback calls from InferOS: ${escaped.length}`);
    console.log(`\nLocal Wiki proposal evidence:\n${evidence.map(line => `  ${line}`).join("\n")}\n`);
    // Nothing left the machine: every InferOS request was loopback or the InferLab fixture.
    expect(escaped).toEqual([]);
  }
}

describe.skipIf(!LIVE.baseUrl || LIVE.publish !== "")("Wiki proposal approval against a local InferOps", () => {
  beforeAll(setUp, 120_000);
  afterAll(tearDown);

  it("L1: the owner's per-person reads equal InferOps' own answer, as observations", async () => {
    const { ws, session } = await wikiOf("owner");
    const direct = await proposalDirect(people.owner.person, seed.p1.id);
    expect(direct.status).toBe(200);
    expect(direct.body.proposal).toMatchObject({ id: seed.p1.id, state: "in_review", proposalHash: seed.p1.proposalHash });

    const read = await session.readProposal(seed.p1.id);
    const p = direct.body.proposal;
    expect(read.proposal).toMatchObject({
      id: p.id, runId: p.runId, revision: p.revision, state: p.state, proposalHash: p.proposalHash,
      targetDocumentId: p.targetDocumentId, expectedVersion: p.expectedVersion, title: p.title,
      content: p.content, summary: p.summary, sources: p.sources, approvedHash: null,
    });
    expect(read.freshness).toEqual(direct.body.freshness);
    expect(read.freshness).toMatchObject({ stale: false });
    // No principal of InferOps' reaches the caller.
    expect(Object.keys(read.proposal)).not.toContain("requestedBy");

    const listed = (await session.listProposals("in_review")).map(x => x.id);
    expect(listed).toEqual(expect.arrayContaining([seed.p1.id, seed.p2.id]));
    const observed = (await ws.listActions({ filter: "observation" })).entries.map(e => e.description.title);
    expect(observed).toEqual(expect.arrayContaining(["List InferMind Wiki proposals", expect.stringMatching(/^Read Wiki proposal /)]));
    evidence.push(`L1 owner per-person: readProposal(${seed.p1.id}) equals proposal.get (in_review, hash, sources, freshness); listed ${listed.length} in_review`);
  });

  it("L2-L4: the owner's explicit approval applies once as the owner, never published; a resend replays", async () => {
    const { ws, session } = await wikiOf("owner");
    const action = await staged(ws, () => session.approveProposal(seed.p1.id, seed.p1.proposalHash));
    // L2: nothing reached InferOps before the decision.
    expect((await proposalDirect(people.owner.person, seed.p1.id)).body.proposal).toMatchObject({ state: "in_review", approvedHash: null });
    expect((await session.readProposal(seed.p1.id)).proposal.pending).toBe("approve");
    evidence.push(`L2 staged action ${action.id}: InferOps still in_review`);

    // L3: approved by the owner, at the hash; not published.
    await ws.approveAction(action.id);
    const entry = await entryOf(ws, action.id);
    // `ActionState` has no "applied": an approved action is one the gatekeeper applied.
    expect(entry?.state).toBe("approved");
    expect(entry).not.toHaveProperty("lastAttempt");
    const after = (await proposalDirect(people.owner.person, seed.p1.id)).body.proposal;
    expect(after).toMatchObject({
      state: "approved", approvedHash: seed.p1.proposalHash, decidedBy: { id: people.owner.person.user.id, type: "user" },
      publishedDocumentId: null, publishedAt: null,
    });
    const shown = (await session.readProposal(seed.p1.id)).proposal;
    expect(shown).toMatchObject({ state: "approved", publishedDocumentId: null });
    expect(shown.pending).toBeUndefined();
    // Nothing about the approved action claims a publication.
    expect(JSON.stringify(entry)).not.toMatch(/\bpublished\b/i);
    evidence.push(`L3 applied: InferOps approved, decidedBy owner ${people.owner.person.user.id}, approvedHash = seed hash, not published`);

    // L4: approving the applied action again sends nothing; a direct resend replays the decision.
    expect(await failure(ws.approveAction(action.id))).toMatch(/not pending/);
    const replay = await approveDirect(people.owner.person, seed.p1.id, seed.p1.proposalHash, seed.p1.sources);
    expect(replay.status).toBe(200);
    expect(replay.body.proposal).toMatchObject({ id: seed.p1.id, state: "approved", decidedAt: after.decidedAt });
    evidence.push("L4 re-approve of the applied action refused (not pending); direct same-hash resend replayed (200, same decidedAt)");
  });

  it("L5: the member, without knowledge:publish, is refused FORBIDDEN and the action stays pending", async () => {
    const { ws, session } = await wikiOf("member");
    const read = await session.readProposal(seed.p2.id);
    expect(read.freshness.stale).toBe(false);
    const action = await staged(ws, () => session.approveProposal(seed.p2.id, seed.p2.proposalHash));
    const message = await failure(ws.approveAction(action.id));
    expect(message).toContain("Approving for publication needs knowledge:publish (Owner or Admin).");
    const entry = await entryOf(ws, action.id);
    expect(entry).toMatchObject({ state: "pending", lastAttempt: { outcome: "notApplied", code: "FORBIDDEN", retryable: true } });
    expect((await proposalDirect(people.member.person, seed.p2.id)).body.proposal).toMatchObject({ state: "in_review", approvedHash: null });
    await ws.rejectAction(action.id);
    evidence.push(`L5 member apply refused FORBIDDEN (notApplied, retryable, pending); P2 ${seed.p2.id} still in_review; action rejected after`);
  });

  it("L6: the owner's approval of the owner's own request is refused for good, and nothing is approved", async () => {
    expect(seed.p2.requestedBy).toBe(people.owner.person.user.id);
    const { ws, session } = await wikiOf("owner");
    const action = await staged(ws, () => session.approveProposal(seed.p2.id, seed.p2.proposalHash));
    const message = await failure(ws.approveAction(action.id));
    expect(message).toContain("You requested this draft or wrote this revision; another person must approve it.");
    expect(await entryOf(ws, action.id)).toMatchObject({
      state: "failed", lastAttempt: { outcome: "notApplied", code: "CONFLICT", retryable: false },
    });
    expect((await proposalDirect(people.owner.person, seed.p2.id)).body.proposal).toMatchObject({
      state: "in_review", approvedHash: null, decidedBy: null,
    });
    evidence.push(`L6 owner self-approval of P2 refused CONFLICT (failed, not retryable); P2 still in_review, undecided`);
  });
});

describe.skipIf(!LIVE.baseUrl || LIVE.publish !== "published")("Step B: the queued publish job, read back through InferOS", () => {
  beforeAll(setUp, 120_000);
  afterAll(tearDown);

  it("L-B1: the owner reads P1 published into its target at expectedVersion + 1, once the real job ran", async () => {
    // Bounded wait on InferOps' own answer (each InferOS read is an observation), then one InferOS read.
    await waitFor("P1 settled by the queued job", async () => {
      const state = (await proposalDirect(people.owner.person, seed.p1.id)).body.proposal?.state;
      return state === "approved" || state === "publishing" ? null : state;
    }, 60_000);
    const { session } = await wikiOf("owner");
    const published = (await session.readProposal(seed.p1.id)).proposal;
    expect(published).toMatchObject({
      state: "published", publishedDocumentId: seed.p1.targetDocumentId,
      publishedVersion: seed.p1.expectedVersion + 1, blockedReason: null, lastError: null,
    });
    const direct = (await proposalDirect(people.owner.person, seed.p1.id)).body.proposal;
    expect(direct).toMatchObject({
      state: "published", publishedDocumentId: seed.p1.targetDocumentId, publishedVersion: seed.p1.expectedVersion + 1,
      decidedBy: { id: people.owner.person.user.id, type: "user" },
    });
    evidence.push(`L-B1 P1 ${seed.p1.id} published into ${seed.p1.targetDocumentId} at version ${seed.p1.expectedVersion + 1}`);
  }, 90_000);

  it("L-B2: the page keeps its identity, parent and pillar, with P1's title and content", async () => {
    const { session } = await wikiOf("owner");
    const { proposal } = await session.readProposal(seed.p1.id);
    const page = await session.readDocument(seed.p1.targetDocumentId);
    expect(page).toMatchObject({
      id: seed.p1.targetDocumentId, title: proposal.title, body: proposal.content,
      version: seed.p1.expectedVersion + 1, masterRole: null,
    });
    expect(page.slug).toBe(proposal.targetSlug);
    const structure = await session.readStructure();
    const pillar = structure.pillars.find(p => p.key === seed.lane);
    expect(pillar?.members.find(m => m.id === seed.p1.targetDocumentId))
      .toMatchObject({ slug: proposal.targetSlug, parentId: seed.p1Parent.id });
    evidence.push(`L-B2 page ${page.id} (${page.slug}) at v${page.version}: parent ${seed.p1Parent.id}, still in pillar ${seed.lane}, body and title = P1's`);
  });

  it("L-B4: P2 and the member's refused approval published nothing", async () => {
    const { session } = await wikiOf("owner");
    const { proposal } = await session.readProposal(seed.p2.id);
    expect(proposal).toMatchObject({ state: "in_review", publishedDocumentId: null, approvedHash: null });
    evidence.push(`L-B4 P2 ${seed.p2.id} still in_review, unpublished`);
  });
});

describe.skipIf(!LIVE.baseUrl || LIVE.publish !== "redelivered")("Step B: a redelivered publish job publishes nothing more", () => {
  beforeAll(setUp, 120_000);
  afterAll(tearDown);

  it("L-B3: after one redelivery of the exact envelope, P1 and its page are unchanged; a same-hash approval replays", async () => {
    const { session } = await wikiOf("owner");
    const { proposal } = await session.readProposal(seed.p1.id);
    expect(proposal).toMatchObject({
      state: "published", publishedDocumentId: seed.p1.targetDocumentId, publishedVersion: seed.p1.expectedVersion + 1,
    });
    const page = await session.readDocument(seed.p1.targetDocumentId);
    expect(page).toMatchObject({ version: seed.p1.expectedVersion + 1, body: proposal.content, title: proposal.title });
    const replay = await approveDirect(people.owner.person, seed.p1.id, seed.p1.proposalHash, seed.p1.sources);
    expect(replay.status).toBe(200);
    expect(replay.body.proposal).toMatchObject({ id: seed.p1.id, state: "published", publishedVersion: seed.p1.expectedVersion + 1 });
    evidence.push(`L-B3 after redelivery: P1 still published at v${page.version}, page unchanged; same-hash approve replayed (200, published)`);
  });
});

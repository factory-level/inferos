// Opt-in live run of workflow-policy bindings (MVP-18, slice 07): the real Workshop and the real
// gatekeeper Worker, driven over the Workshop's RPC API against a running InferOps in stub auth mode
// (the composed shared-api on a DISPOSABLE migrated and seeded database). Skipped unless
// `INFEROPS_WORKFLOW_LIVE_BASE_URL` is set, so CI never runs it; it also refuses to start unless
// `INFEROPS_WORKFLOW_LIVE_DISPOSABLE=1` acknowledges that the database is a throwaway one, because
// its test setup writes to it.
//
// TEST SETUP, NOT A CONSUMER PATH. Before anything is bound, the seeded owner creates two synthetic
// projects in acme/operations and publishes a v2 policy on one with InferOps' own `workflow.set`
// (`PUT /project/projects/:id/workflow`), directly against the API with the owner's token. That
// write is the fixture, in the disposable database only; the gatekeeper has no write path and never
// calls `workflow.set`. The policy carries a distinct canary in every place the gatekeeper leaves out
// (a top-level, a fragment, a lane-binding and a transition rule's `reason`, an `agents[]` entry with
// a seeded service account's id that the policy names nowhere else) and is published by the owner, whose id is therefore the head's
// `publishedBy`; the owner is named in the policy only by role (R1 N4).
//
// What it proves, against InferOps' real `project.list` and `workflow.get` with real person tokens:
// the owner and the viewer each bind `inferops://acme.operations/project/workflow/<KEY>` and read
// exactly InferOps' own head for that project minus `publishedBy`, `agents` and every rule reason
// (faithful otherwise, in order), the viewer the same as the owner; no canary reaches a read or an
// observation; an unconfigured project reads as InferOps' unconfigured head; a policy republished
// between reads shows its new revision; a workspace the person does not hold, an InferMind workspace,
// a missing key and a key of another tenant's workspace are refused at bind with the one message; a
// second tenant's person binding the same URL is refused (the key is not in their own workspace),
// and a key the test setup created only in that person's workspace is refused for the owner,
// and InferOps itself refuses that person's token pinned to acme/operations.
//
// What it does NOT prove: InferLab sign-in. As in `inferops-members-live.test.ts`, the InferLab legs
// (`/authorize`, `/auth/token`, `/auth/refresh`, `/auth/logout`) are answered by a fixture in this
// file, handing out the real tokens and memberships InferOps' stub login (`POST /auth/inferlab-login`)
// returns for each seeded persona. Nothing in production code is relaxed. Every InferOps request,
// including the connect's `GET /workspaces`, goes to the real API. Tokens last 900 s.
//
// Configuration (never printed):
//   INFEROPS_WORKFLOW_LIVE_BASE_URL    the InferOps API origin, e.g. http://localhost:8080
//   INFEROPS_WORKFLOW_LIVE_DISPOSABLE  must be 1: the database behind it is disposable
//   INFEROPS_WORKFLOW_LIVE_ORIGIN      an origin the API's CORS allows (default http://localhost:3000)
//   INFEROPS_WORKFLOW_LIVE_OWNER       the owner persona (default `owner`, acme/operations)
//   INFEROPS_WORKFLOW_LIVE_VIEWER      the viewer persona (default `viewer`, acme/operations only)
//   INFEROPS_WORKFLOW_LIVE_OTHER       a second tenant's persona (default `canary-inspector`)
//
// Run, after `pnpm --filter @gadgets/integration-tests run test:prebuild`:
//   INFEROPS_WORKFLOW_LIVE_BASE_URL=... INFEROPS_WORKFLOW_LIVE_DISPOSABLE=1 \
//   pnpm --filter @gadgets/integration-tests exec vitest run __tests__/inferops-workflow-policy-live.test.ts

import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type {
  InferOpsWorkflowPolicySession, WorkflowPolicyHead,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount } from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_WORKFLOW_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  disposable: process.env.INFEROPS_WORKFLOW_LIVE_DISPOSABLE === "1",
  origin: process.env.INFEROPS_WORKFLOW_LIVE_ORIGIN ?? "http://localhost:3000",
  owner: process.env.INFEROPS_WORKFLOW_LIVE_OWNER ?? "owner",
  viewer: process.env.INFEROPS_WORKFLOW_LIVE_VIEWER ?? "viewer",
  other: process.env.INFEROPS_WORKFLOW_LIVE_OTHER ?? "canary-inspector",
};

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
/** The fixture's InferLab origin: never a real InferLab. */
const FIXTURE_INFERLAB = "https://inferlab.fixture.test";

/** Sixteen random hex digits, for fixture codes and refresh tokens. */
const randomHex = () => Array.from(randomBytes(8), byte => byte.toString(16).padStart(2, "0")).join("");
const RUN = randomHex().slice(0, 6).toUpperCase().replace(/^[0-9]/, "R");
/** The synthetic projects the test setup creates: configured (policy) and unconfigured. */
const KEYS = { policy: `W${RUN}`.slice(0, 10), unconfigured: `U${RUN}`.slice(0, 10) };
/** A synthetic project the test setup creates in the second tenant's workspace: a key acme does not have. */
const FOREIGN_KEY = `X${RUN}`.slice(0, 10);

/** Distinct canaries, one per field the gatekeeper leaves out; none appears anywhere else. */
const CANARY = {
  topReason: `canary-live-top-reason-${RUN}`,
  fragmentReason: `canary-live-fragment-reason-${RUN}`,
  bindingReason: `canary-live-binding-reason-${RUN}`,
  transitionReason: `canary-live-transition-reason-${RUN}`,
  responsibility: `canary-live-agent-responsibility-${RUN}`,
  // InferOps' workflow.set requires an agent to be a service account of the workspace, so this is a
  // seeded acme/operations agent (`marketing-engagement`) that the policy names nowhere else.
  agentId: "00000000-0000-4000-8000-000000000025",
};

/** One line per step, printed at the end as the run's evidence. Keys, ids, revisions and counts only. */
const evidence: string[] = [];

type Membership = { workspaceId: string; workspaceName: string; product: string; role: string; deniedPermissions: string[] };
type SessionUser = { id: string; email: string; name: string; tenantId: string; workspaces: Membership[] };
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

/** One request to InferOps with the person's own token in `workspaceId`. */
async function api(person: Person, workspaceId: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${LIVE.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${person.token}`, "x-workspace-id": workspaceId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** InferOps' own `workflow.get` head for `projectId`, read with the person's token: the authority each read is checked against. */
async function headDirect(person: Person, workspaceId: string, projectId: string) {
  const answer = await api(person, workspaceId, "GET", `/project/projects/${projectId}/workflow?workflow=content`);
  return { status: answer.status, head: answer.body?.head as Record<string, any> | undefined };
}

/** `rules` without their reasons, in place. */
const dropReasons = (rules?: Array<Record<string, unknown>>) => rules?.forEach(rule => delete rule.reason);

/** The reduced-P2 projection of a source head: exactly publishedBy, agents and every rule reason deleted. */
function projected(head: Record<string, any>): Record<string, unknown> {
  const copy = structuredClone(head);
  delete copy.publishedBy;
  if (copy.policy) {
    delete copy.policy.agents;
    const drop = dropReasons;
    drop(copy.policy.rules);
    for (const fragment of copy.policy.fragments ?? []) drop(fragment.rules);
    for (const binding of copy.policy.laneBindings ?? []) drop(binding.rules);
    for (const transition of copy.policy.transitions ?? []) drop(transition.rules);
  }
  return copy;
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
type Connected = { person: Person; api: RpcStub<AuthenticatedApi>; account: ConnectedAccount };
const people: Record<"owner" | "viewer" | "other", Connected> = {} as never;
/** The synthetic projects of the test setup, by key: their ids. */
const projects: Record<string, string> = {};

/** The person's own InferOps workspace (`operations` for the acme personas). */
const opsOf = (person: Person) => person.user.workspaces.find(w => w.product === "inferops")!.workspaceId;
const workflowUrl = (key: string, host = "acme.operations") => `inferops://${host}/project/workflow/${key}`;

async function connectPerson(label: string, person: Person): Promise<Connected> {
  const [username] = nextUsernames(`workflow${label}`);
  const rpc = await signUp(connect(harness.url), username!);
  const { url, nonce } = await rpc.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fixture.authorize(start.headers.get("location")!, person));
  const ticket = JSON.parse(/var ticket = (".*?");\n/.exec(await done.text())![1]!);
  await rpc.completeConnectHandoff(ticket, nonce);
  const account = await waitFor(`the ${label}'s connected InferOps account`, async () =>
    (await listConnectedAccounts(rpc)).find(a => a.vendorId === VENDOR) ?? null);
  return { person, api: rpc, account };
}

async function readAs(who: keyof typeof people, resourceUrl: string) {
  const { api: rpc, account } = people[who];
  const ws = await rpc.newGadget();
  const connection = await ws.newGatekeeper(account.id, resourceUrl);
  if (!connection) throw new Error("No connection");
  const session = await connection.openSession() as RpcStub<InferOpsWorkflowPolicySession>;
  return { ws, session, read: await session.readWorkflowPolicy() as WorkflowPolicyHead };
}

/** The fixture policy over the project's own content lanes; the owner appears by role only. */
function fixturePolicy(lanes: Array<{ id: string; name: string; group: string }>, viewerId: string) {
  const entry = lanes[0]!;
  const middle = lanes.find(l => l.group === "started") ?? lanes[1]!;
  const done = lanes.find(l => l.group === "completed")!;
  return {
    schemaVersion: 2, workflow: "content", entryLaneId: entry.id, lanes,
    fragments: [{
      id: "reviewers", version: 1,
      rules: [{ id: "viewers-comment", effect: "allow", subjects: [{ role: "viewer" }], actions: ["read", "comment"], reason: CANARY.fragmentReason }],
    }],
    laneBindings: [{
      laneId: middle.id, use: ["reviewers"],
      rules: [{
        id: "named-viewer-reads", effect: "allow", subjects: [{ principalId: viewerId }, { kind: "service_account" }],
        actions: ["read"], reason: CANARY.bindingReason,
      }],
      guards: [{ kind: "required-field", field: "description" }, { kind: "not-blocked" }],
    }],
    rules: [
      {
        id: "owners-all", effect: "allow", subjects: [{ role: "owner" }],
        actions: ["read", "create", "edit", "comment", "assign", "reprioritize", "move-out", "move-in", "approve", "publish"],
        reason: CANARY.topReason,
      },
      { id: "no-agent-publish", effect: "deny", subjects: [{ kind: "service_account" }], actions: ["publish"] },
    ],
    transitions: [
      {
        id: "to-done", from: middle.id, to: done.id, subjects: [{ role: "owner" }, { principalId: viewerId }],
        guards: [{ kind: "actor-kind", actorKind: "user" }],
        rules: [{ id: "done-edge", effect: "allow", subjects: [{ role: "owner" }], actions: ["move-out", "move-in"], reason: CANARY.transitionReason }],
      },
      { id: "owner-any", from: "*", to: "*", subjects: [{ role: "owner" }] },
    ],
    agents: [{ principalId: CANARY.agentId, responsibility: CANARY.responsibility }],
  };
}

describe.skipIf(!LIVE.baseUrl)("workflow policies against a live InferOps", () => {
  beforeAll(async () => {
    if (!LIVE.disposable) {
      throw new Error("Refusing to run: set INFEROPS_WORKFLOW_LIVE_DISPOSABLE=1 to confirm the database is disposable (the test setup writes to it).");
    }
    const [owner, viewer, other] = await Promise.all([signIn(LIVE.owner), signIn(LIVE.viewer), signIn(LIVE.other)]);
    const ops = opsOf(owner!);
    expect(opsOf(viewer!)).toBe(ops);

    // TEST SETUP (labelled; disposable database only): two synthetic projects, one policy published
    // with InferOps' own workflow.set by the owner. Never a consumer path.
    for (const [role, key] of Object.entries(KEYS)) {
      const created = await api(owner!, ops, "POST", "/project/projects", { name: `MVP18 live ${role} ${RUN}`, identifier: key });
      if (created.status !== 200) throw new Error(`setup: create ${role} project: ${created.status}`);
      projects[key] = created.body.project.id;
      if (role !== "policy") continue;
      const lanes = (created.body.states as Array<Record<string, string>>)
        .filter(state => state.workflow === "content")
        .map(({ id, name, group }) => ({ id: id!, name: name!, group: group! }));
      const policy = fixturePolicy(lanes, viewer!.user.id);
      const checked = await api(owner!, ops, "POST", `/project/projects/${projects[key]}/workflow/validate`, { policy });
      if (checked.status !== 200 || !checked.body.valid) {
        throw new Error(`setup: fixture policy does not compile: ${JSON.stringify(checked.body?.errors ?? checked.status)}`);
      }
      const saved = await api(owner!, ops, "PUT", `/project/projects/${projects[key]}/workflow`, { expectedRevision: "0", policy });
      if (saved.status !== 200) throw new Error(`setup: workflow.set: ${saved.status}`);
    }
    // TEST SETUP: the second tenant's person (owner of their own workspace) creates a project whose
    // key exists only there.
    const foreign = await api(other!, opsOf(other!), "POST", "/project/projects", { name: `MVP18 live foreign ${RUN}`, identifier: FOREIGN_KEY });
    if (foreign.status !== 200) throw new Error(`setup: create the second tenant's project: ${foreign.status}`);
    evidence.push(`setup (test only, workflow.set by the owner): projects ${KEYS.policy} (policy) and ${KEYS.unconfigured} (unconfigured) in ${ops}; ` +
      `${FOREIGN_KEY} in the second tenant's ${opsOf(other!)}`);

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
            INFEROPS_WORKFLOW_POLICY_ENABLED: "true",
          };
        },
      }],
    });
    people.owner = await connectPerson("owner", owner!);
    people.viewer = await connectPerson("viewer", viewer!);
    people.other = await connectPerson("other", other!);
  }, 180_000);

  afterAll(async () => {
    try {
      await harness?.server.close();
    } finally {
      network.uninstall();
      console.log(`\nLive workflow-policy evidence:\n${evidence.map(line => `  ${line}`).join("\n")}\n`);
    }
  });

  it("an owner and a viewer read the policy: InferOps' head minus publishedBy, agents and every reason", async () => {
    const ops = opsOf(people.owner.person);
    const projectId = projects[KEYS.policy]!;
    const direct = await headDirect(people.owner.person, ops, projectId);
    expect(direct.status).toBe(200);
    // The source really carries what the gatekeeper must leave out.
    expect(direct.head!.publishedBy).toBe(people.owner.person.user.id);
    expect(direct.head!.policy.agents).toHaveLength(1);
    expect(JSON.stringify(direct.head)).toContain(CANARY.topReason);

    const owner = await readAs("owner", workflowUrl(KEYS.policy));
    expect(owner.read).toEqual(projected(direct.head!));
    expect(JSON.stringify(owner.read)).toBe(JSON.stringify(projected(direct.head!)));
    expect(owner.read.compiledHash).toBe(direct.head!.compiledHash);

    const viewerDirect = await headDirect(people.viewer.person, ops, projectId);
    expect(viewerDirect.status).toBe(200);
    const viewer = await readAs("viewer", workflowUrl(KEYS.policy));
    expect(viewer.read).toEqual(projected(viewerDirect.head!));
    expect(viewer.read).toEqual(owner.read);

    const shown = JSON.stringify([owner.read, viewer.read]);
    for (const canary of Object.values(CANARY)) expect(shown).not.toContain(canary);
    // publishedBy is the owner's id, which the policy never names: it appears nowhere in the read.
    expect(shown).not.toContain(people.owner.person.user.id);
    for (const key of ['"reason"', '"agents"', '"publishedBy"', '"responsibility"']) expect(shown).not.toContain(key);
    // Every principal subject the source names is kept.
    expect(shown).toContain(`{"principalId":"${people.viewer.person.user.id}"}`);

    for (const { ws } of [owner, viewer]) {
      const observed = (await ws.listActions({ filter: "observation" })).entries.map(e => e.description);
      expect(observed.map(d => d.title)).toContain("Read InferOps workflow policy");
      const said = JSON.stringify(observed);
      for (const canary of Object.values(CANARY)) expect(said).not.toContain(canary);
      for (const hidden of [people.viewer.person.user.id, "owners-all", "viewers-comment", owner.read.policy!.lanes[0]!.name]) {
        expect(said).not.toContain(hidden);
      }
    }
    evidence.push(`owner+viewer bind+read ${KEYS.policy}: revision ${owner.read.revision}, ${owner.read.policy!.rules!.length} top-level rules, ` +
      `${owner.read.policy!.transitions!.length} transitions; equal to workflow.get minus publishedBy/agents/reasons; viewer equals owner; no canary in reads or observations`);
  });

  it("an unconfigured project reads as InferOps' unconfigured head", async () => {
    const ops = opsOf(people.owner.person);
    const direct = await headDirect(people.viewer.person, ops, projects[KEYS.unconfigured]!);
    expect(direct.status).toBe(200);
    expect(direct.head).toMatchObject({ configured: false, revision: "0", policy: null });
    const { read } = await readAs("viewer", workflowUrl(KEYS.unconfigured));
    expect(read).toEqual(projected(direct.head!));
    evidence.push(`viewer read ${KEYS.unconfigured}: configured false, revision 0, equal to workflow.get`);
  });

  it("a policy republished between reads shows its new revision (each read is fresh)", async () => {
    const ops = opsOf(people.owner.person);
    const projectId = projects[KEYS.policy]!;
    const { session, read: first } = await readAs("viewer", workflowUrl(KEYS.policy));
    const current = await headDirect(people.owner.person, ops, projectId);
    // TEST SETUP: the owner republishes the same document once more with InferOps' own workflow.set.
    const policy = structuredClone(current.head!.policy);
    policy.rules[1].effect = "allow";
    const saved = await api(people.owner.person, ops, "PUT", `/project/projects/${projectId}/workflow`,
      { expectedRevision: current.head!.revision, policy });
    expect(saved.status).toBe(200);
    const second = await session.readWorkflowPolicy() as WorkflowPolicyHead;
    expect(BigInt(second.revision)).toBeGreaterThan(BigInt(first.revision));
    expect(second.policy!.rules![1]!.effect).toBe("allow");
    expect(second).toEqual(projected((await headDirect(people.viewer.person, ops, projectId)).head!));
    evidence.push(`republished (test setup) between two reads of one session: revision ${first.revision} then ${second.revision}`);
  });

  it("attack: a workspace not held, an InferMind workspace, a missing key and another tenant's key are refused at bind, with one message", async () => {
    // The foreign key really exists, but only in the second tenant's workspace.
    const theirs = await api(people.other.person, opsOf(people.other.person), "GET", "/project/projects");
    expect(theirs.body.projects.map((p: { identifier: string }) => p.identifier)).toContain(FOREIGN_KEY);
    const acme = await api(people.owner.person, opsOf(people.owner.person), "GET", "/project/projects");
    expect(acme.body.projects.map((p: { identifier: string }) => p.identifier)).not.toContain(FOREIGN_KEY);
    const cases: Array<[keyof typeof people, string, string]> = [
      ["viewer", workflowUrl(KEYS.policy, "acme.knowledge"), "acme.knowledge"],
      ["owner", workflowUrl(KEYS.policy, "synthetics.probe"), "synthetics.probe"],
      ["owner", workflowUrl(`N${RUN}`.slice(0, 10)), "acme.operations"],
      ["owner", workflowUrl(FOREIGN_KEY), "acme.operations"],
    ];
    for (const [who, url, host] of cases) {
      const ws = await people[who].api.newGadget();
      await expect(ws.newGatekeeper(people[who].account.id, url))
        .rejects.toThrow(`No InferOps workflow policy is available to you on ${host}.`);
    }
    evidence.push(`refused at bind: viewer on acme.knowledge (InferMind), owner on synthetics.probe (not held), owner on a missing key, ` +
      `owner on ${FOREIGN_KEY} (a key only in the second tenant's workspace)`);
  });

  it("attack: a second tenant's person never reads acme's policy; the tenant label is inert", async () => {
    const ops = opsOf(people.owner.person);
    const otherOps = opsOf(people.other.person);
    expect(otherOps).not.toBe(ops);
    // InferOps itself refuses that person's token pinned to acme/operations.
    const pinned = await headDirect(people.other.person, ops, projects[KEYS.policy]!);
    expect(pinned.status).toBe(403);
    expect(JSON.stringify(pinned)).not.toContain(CANARY.topReason);
    // The same acme URL, bound by them, resolves only among their own workspaces, where the key is not.
    const ws = await people.other.api.newGadget();
    await expect(ws.newGatekeeper(people.other.account.id, workflowUrl(KEYS.policy)))
      .rejects.toThrow("No InferOps workflow policy is available to you on acme.operations.");
    evidence.push(`second tenant: workflow.get with their token pinned to ${ops} is ${pinned.status}; binding ${workflowUrl(KEYS.policy)} refused with the one message`);
  });
});

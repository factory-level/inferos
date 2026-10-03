// Opt-in live run of the InferOps gatekeeper against a real InferOps API: the real Workshop and the
// real gatekeeper Worker, driven over the Workshop's RPC API, calling a running InferOps (for
// example `bun run dev up` from inferops `develop`, stub auth, seeded). Skipped unless
// `INFEROPS_LIVE_BASE_URL` is set, so CI never runs it.
//
// What it proves: the HTTP client, the approval path and the revision and idempotency rules work
// against the real InferOps project API and its real data -- every step is checked by also reading
// InferOps directly with the same token.
//
// What it does NOT prove: per-person identity. It uses the local-development stopgap connection
// (`INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID`, `INFEROPS_WORKSPACE_SLUG` gatekeeper vars, no
// `INFERLAB_AUTH_ORIGIN`), so every request carries one shared persona token. InferOps refuses SSO
// codes for non-Google sessions (inferops ADR 0012), so the per-person InferLab connect cannot
// complete against a stub-auth InferOps; the live sign-in (#66) stays a manual Google step.
//
// Configuration (never printed):
//   INFEROPS_LIVE_BASE_URL       the InferOps API origin, e.g. http://localhost:8280
//   INFEROPS_LIVE_TOKEN          a bearer token, e.g. from `POST /auth/inferlab-login` with
//                                `{"personaId":"owner","transport":"bearer"}`
//   INFEROPS_LIVE_WORKSPACE_ID   the workspace the token acts in
//   INFEROPS_LIVE_WORKSPACE_SLUG that workspace's slug (`operations` in the seed)
//   INFEROPS_LIVE_TENANT         the URL's tenant label (default `acme`; syntax only, ADR 0005)
//   INFEROPS_LIVE_PROJECT        the project key (default `ENG`)
//   INFEROPS_LIVE_POLICY_PROJECT the content-policy project key (default `CPOL`); see step h
//
// It writes to InferOps: one new issue per run, titled `InferOS live <timestamp>`, which it then
// updates and moves. InferOps has no issue delete, so the issue is left in place. Step h also
// creates the content-policy project on first use (the token must hold `project:manage`, as the
// seed's `owner` does), publishes its workflow policy (a no-op once it is the head), and adds one
// content issue per run.
//
// Run, after `pnpm --filter @gadgets/integration-tests run test:prebuild`:
//   INFEROPS_LIVE_BASE_URL=... INFEROPS_LIVE_TOKEN=... INFEROPS_LIVE_WORKSPACE_ID=... \
//   INFEROPS_LIVE_WORKSPACE_SLUG=operations \
//   pnpm --filter @gadgets/integration-tests exec vitest run __tests__/inferops-live.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import type {
  Board, InferOpsProjectSession, Issue, State,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  token: process.env.INFEROPS_LIVE_TOKEN ?? "",
  workspaceId: process.env.INFEROPS_LIVE_WORKSPACE_ID ?? "",
  workspaceSlug: process.env.INFEROPS_LIVE_WORKSPACE_SLUG ?? "",
  tenant: process.env.INFEROPS_LIVE_TENANT ?? "acme",
  project: process.env.INFEROPS_LIVE_PROJECT ?? "ENG",
  policyProject: process.env.INFEROPS_LIVE_POLICY_PROJECT ?? "CPOL",
};

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";

const boardUrl = (key: string) =>
  `inferops://${LIVE.tenant}.${LIVE.workspaceSlug}/project/board/${key}`;

/** One line per step, printed at the end as the run's evidence. Ids and revisions only. */
const evidence: string[] = [];
const note = (line: string) => evidence.push(line);

// ---------------------------------------------------------------------------
// Direct InferOps reads, the authority every step is checked against.

type LiveIssue = Issue & { projectId: string };

async function inferOps(path: string, init?: { method: string; body: unknown }): Promise<unknown> {
  const response = await fetch(`${LIVE.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${LIVE.token}`,
      "x-workspace-id": LIVE.workspaceId,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) throw new Error(`InferOps ${init?.method ?? "GET"} ${path} answered ${response.status}`);
  return response.json();
}

async function liveProjectId(key: string): Promise<string | null> {
  const { projects } = await inferOps("/project/projects") as {
    projects: Array<{ id: string; identifier: string }>;
  };
  return projects.find(p => p.identifier === key)?.id ?? null;
}

type LiveBoard = { columns: Array<{ state: State; issues: LiveIssue[] }> };

async function liveBoard(key = LIVE.project): Promise<LiveBoard> {
  const id = await liveProjectId(key);
  if (!id) throw new Error(`InferOps has no project ${key} in the workspace`);
  return await inferOps(`/project/board?projectId=${id}`) as LiveBoard;
}

const liveIssuesTitled = async (title: string, key = LIVE.project) =>
  (await liveBoard(key)).columns.flatMap(c => c.issues).filter(i => i.title === title);

const liveIssue = async (id: string) =>
  ((await inferOps(`/project/issues/${id}`)) as { issue: LiveIssue }).issue;

const boardIssue = (board: Board, id: string) =>
  board.columns.flatMap(c => c.issues).find(i => i.id === id);

// ---------------------------------------------------------------------------
// The content-policy project step h runs against. InferOps enforces a published workflow policy
// on `content` issues only, and the seed has none, so the run sets one up itself: the project is
// created once and reused, and the publish is a no-op when the policy is already the head.

const WORKFLOW_ACTIONS = [
  "read", "create", "edit", "comment", "assign", "reprioritize", "move-out", "move-in", "claim",
  "delegate", "execute", "approve", "publish",
] as const;

type PolicyProject = { projectId: string; revision: string; lanes: Record<string, State> };

/**
 * Create (or reuse) `key` and publish a content policy on it: every user may do everything and
 * take any edge, except that the Draft -> Published edge denies `move-in` to every user. Proves the
 * policy is live with `workflow/explain` before returning.
 */
async function ensureContentPolicyProject(key: string): Promise<PolicyProject> {
  const projectId = await liveProjectId(key) ??
    ((await inferOps("/project/projects", {
      method: "POST", body: { name: "InferOS content policy", identifier: key },
    })) as { project: { id: string } }).project.id;
  const states = (await liveBoard(key)).columns.map(c => c.state).filter(s => s.workflow === "content");
  const lane = (name: string) => {
    const state = states.find(s => s.name === name);
    if (!state) throw new Error(`${key} has no content state ${name}`);
    return state;
  };
  const lanes = Object.fromEntries(
    ["Idea", "Draft", "Review", "Published"].map(name => [name, lane(name)]));
  const policy = {
    schemaVersion: 2,
    workflow: "content",
    entryLaneId: states[0]!.id,
    lanes: states.map(s => ({ id: s.id, name: s.name, group: s.group })),
    rules: [{ id: "people-work", effect: "allow", subjects: [{ kind: "user" }], actions: WORKFLOW_ACTIONS }],
    transitions: [
      { id: "any-move", from: "*", to: "*", subjects: [] },
      {
        id: "draft-to-published", from: lanes.Draft!.id, to: lanes.Published!.id, subjects: [],
        rules: [{
          id: "review-before-publish", effect: "deny", subjects: [{ kind: "user" }],
          actions: ["move-in"], reason: "A draft is reviewed before it is published",
        }],
      },
    ],
  };
  const base = `/project/projects/${projectId}/workflow`;
  const validated = await inferOps(`${base}/validate`, { method: "POST", body: { policy } }) as {
    valid: boolean; errors: unknown[]; baseRevision: string;
  };
  expect(validated.errors).toEqual([]);
  expect(validated.valid).toBe(true);
  const { head } = await inferOps(base, {
    method: "PUT", body: { expectedRevision: validated.baseRevision, policy },
  }) as { head: { configured: boolean; revision: string } };
  expect(head.configured).toBe(true);

  const explain = async (from: State, to: State) => (await inferOps(`${base}/explain?action=move-in` +
    `&fromLaneId=${from.id}&toLaneId=${to.id}`) as {
    decision: { allowed: boolean; reasonCodes: string[] }; legacy: boolean;
  });
  const denied = await explain(lanes.Draft!, lanes.Published!);
  expect(denied).toMatchObject({ legacy: false, decision: { allowed: false, reasonCodes: ["EXPLICIT_DENY"] } });
  expect((await explain(lanes.Draft!, lanes.Review!)).decision.allowed).toBe(true);
  return { projectId, revision: head.revision, lanes };
}

// ---------------------------------------------------------------------------

describe.skipIf(!LIVE.baseUrl)("InferOps gatekeeper against a live InferOps", () => {
  const network = new NetworkInterceptor();
  let harness: Harness;
  let username: string;
  let api: RpcStub<AuthenticatedApi>;
  let accountId: number;
  let ws: RpcStub<Overseer>;
  let connectionId: number;
  let session: RpcStub<InferOpsProjectSession>;

  // Shared across the ordered steps below.
  const title = `InferOS live ${new Date().toISOString()}`;
  let states: State[];
  let created: LiveIssue;
  let staleRevision: string;

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      INFEROPS_LIVE_TOKEN: LIVE.token, INFEROPS_LIVE_WORKSPACE_ID: LIVE.workspaceId,
      INFEROPS_LIVE_WORKSPACE_SLUG: LIVE.workspaceSlug,
    })) {
      if (!value) throw new Error(`${name} must be set with INFEROPS_LIVE_BASE_URL`);
    }
    // InferOps is reached over loopback, which the interceptor lets through; anything else throws.
    network.install();
    harness = await startHarness({
      gatekeepers: [{
        binding: "INFEROPS",
        dir: INFEROPS_GATEKEEPER_DIR,
        patch: config => {
          if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
          config.vars = {
            ...config.vars,
            INFEROPS_BASE_URL: LIVE.baseUrl,
            INFEROPS_API_TOKEN: LIVE.token,
            INFEROPS_WORKSPACE_ID: LIVE.workspaceId,
            INFEROPS_WORKSPACE_SLUG: LIVE.workspaceSlug,
          };
        },
      }],
    });

    [username] = nextUsernames("inferopslive");
    api = await signUp(connect(harness.url), username!);
    await api.provisionAmbientAccount(VENDOR);
    const account = await waitFor("the provisioned InferOps account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR) ?? null);
    accountId = account.id;
  });

  afterAll(async () => {
    try {
      await harness?.server.close();
      expect(network.getUnmockedCalls()).toEqual([]);
    } finally {
      network.uninstall();
      console.log(["InferOps live run evidence:", ...evidence].join("\n  "));
    }
  });

  const pending = async () => (await ws.listActions({ filter: "pending" })).entries;

  /** The one action the next proposal queues. */
  async function proposed(propose: () => Promise<unknown>) {
    const before = new Set((await pending()).map(a => a.id));
    await propose();
    const added = (await pending()).filter(a => !before.has(a.id));
    expect(added).toHaveLength(1);
    return added[0]!;
  }

  it("a. binds the live board and reads InferOps' real states, recorded as an observation", async () => {
    ws = await api.newGadget();
    const connection = await ws.newGatekeeper(accountId, boardUrl(LIVE.project));
    if (!connection) throw new Error("No connection for the live board");
    connectionId = await connection.getId();
    session = await connection.openSession() as RpcStub<InferOpsProjectSession>;

    const board = await session.readBoard();
    const live = await liveBoard();
    expect(board.project.identifier).toBe(LIVE.project);
    expect(board.project.id).toBe(await liveProjectId(LIVE.project));
    states = board.columns.map(c => c.state);
    expect(states.map(s => s.id)).toEqual(live.columns.map(c => c.state.id));
    expect(states.map(s => s.name)).toEqual(live.columns.map(c => c.state.name));
    // Every card InferOps has, at InferOps' revision.
    const liveCards = live.columns.flatMap(c => c.issues).map(i => `${i.id}@${i.revision}`);
    expect(board.columns.flatMap(c => c.issues).map(i => `${i.id}@${i.revision}`).toSorted())
      .toEqual(liveCards.toSorted());

    const observations = (await ws.listActions({ filter: "observation" })).entries;
    expect(observations).toEqual([expect.objectContaining({
      type: "observation", state: "approved", resourceUrl: boardUrl(LIVE.project),
      description: expect.objectContaining({ title: `Read InferOps board ${LIVE.project}` }),
    })]);
    note(`a. bound ${boardUrl(LIVE.project)}: ${states.length} states ` +
      `(${states.map(s => s.name).join(", ")}), ${liveCards.length} issues; read recorded as an observation`);
  });

  it("b. a proposed create waits for approval, then exists in InferOps exactly once", async () => {
    const target = states.find(s => s.workflow === "software" && s.group === "unstarted") ?? states[0]!;
    const action = await proposed(() => session.createIssue({ title, priority: "low", stateId: target.id }));
    expect(action.type).toBe("action");
    // Pending: the board simulates it, InferOps does not have it.
    const simulated = (await session.readBoard()).columns.flatMap(c => c.issues)
      .filter(i => i.title === title);
    expect(simulated).toEqual([expect.objectContaining({ pending: "create", revision: "0" })]);
    expect(await liveIssuesTitled(title)).toEqual([]);

    await ws.approveAction(action.id);
    const live = await liveIssuesTitled(title);
    expect(live).toHaveLength(1);
    created = await liveIssue(live[0]!.id);
    expect(created).toMatchObject({ stateId: target.id, priority: "low", workflow: target.workflow });

    const card = boardIssue(await session.readBoard(), created.id);
    expect(card).toMatchObject({ identifier: created.identifier, revision: created.revision });
    expect(card?.pending).toBeUndefined();
    note(`b. created ${created.identifier} (${created.id}) in ${target.name} at revision ${created.revision}; ` +
      "absent from InferOps while pending, exactly one after approval");
  });

  it("c. a proposed update (title + priority) applies at a new revision", async () => {
    const before = created.revision;
    const issue = await session.openIssue(created.id);
    const action = await proposed(() =>
      issue.update({ title: `${title} (edited)`, priority: "high" }, before));
    expect((await liveIssue(created.id)).revision).toBe(before);

    await ws.approveAction(action.id);
    const after = await liveIssue(created.id);
    expect(after).toMatchObject({ title: `${title} (edited)`, priority: "high" });
    expect(after.revision).not.toBe(before);
    expect((await issue.read()).revision).toBe(after.revision);
    staleRevision = before;
    created = after;
    note(`c. updated ${created.identifier} title + priority: revision ${before} -> ${after.revision}`);
  });

  it("d. a proposed transition applies and InferOps shows the new state", async () => {
    const before = created;
    const target = states.find(s => s.id !== before.stateId && s.workflow === before.workflow &&
      s.group === "started") ?? states.find(s => s.id !== before.stateId && s.workflow === before.workflow)!;
    const action = await proposed(async () =>
      (await session.openIssue(before.id)).transition(target.id, before.revision));
    expect((await liveIssue(before.id)).stateId).toBe(before.stateId);

    await ws.approveAction(action.id);
    const after = await liveIssue(before.id);
    expect(after.stateId).toBe(target.id);
    expect(after.revision).not.toBe(before.revision);
    created = after;
    note(`d. moved ${after.identifier} to ${target.name}: revision ${before.revision} -> ${after.revision}`);
  });

  it("e. an update at a stale revision is refused with STALE_REVISION and writes nothing", async () => {
    const before = await liveIssue(created.id);
    const issue = await session.openIssue(created.id);
    let message = "";
    let refusedAt = "proposal";
    try {
      const action = await proposed(() => issue.update({ title: "Stale edit" }, staleRevision));
      refusedAt = "apply";
      await ws.approveAction(action.id).then(() => {}, async error => {
        message = error instanceof Error ? error.message : String(error);
        await ws.rejectAction(action.id);
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/STALE_REVISION|changed in InferOps after this update was proposed/);
    const after = await liveIssue(created.id);
    expect(after.revision).toBe(before.revision);
    expect(after.title).toBe(before.title);
    note(`e. update at stale revision ${staleRevision} refused at ${refusedAt} (STALE_REVISION); ` +
      `revision stayed ${after.revision}`);
  });

  it("f. approving an applied action again writes nothing", async () => {
    const before = await liveIssue(created.id);
    const applied = (await ws.listActions({ filter: "action" })).entries
      .filter(a => a.state === "approved");
    expect(applied.length).toBeGreaterThanOrEqual(3);
    for (const action of applied) {
      await expect(ws.approveAction(action.id)).rejects.toThrow(/not pending/);
    }
    const after = await liveIssue(created.id);
    expect(after.revision).toBe(before.revision);
    expect(await liveIssuesTitled(after.title)).toHaveLength(1);
    note(`f. re-approving ${applied.length} applied actions refused ("not pending"); ` +
      `revision stayed ${after.revision}, still one issue`);
  });

  it("g. after a reload, the binding reads the same issue identity and revision", async () => {
    const { id: gadgetId } = await ws.getMetadata();
    const before = boardIssue(await session.readBoard(), created.id)!;

    // A configuration update restarts every Worker on the same storage. The changed var keeps the
    // integration on (its default), so only the restart is observable.
    await harness.server.update(options => ({
      ...options,
      workers: options.workers.map(worker => {
        if (!("config" in worker)) throw new Error("Expected inline harness config");
        if (worker.config.name !== GATEKEEPER_WORKER) return worker;
        return { ...worker, config: { ...worker.config,
          vars: { ...worker.config.vars, INFEROPS_ENABLED: "true" } } };
      }),
    }));
    harness.url = (await harness.server.listen()).url;
    const reloadedApi = await logIn(connect(harness.url), username);
    const reloaded = await reloadedApi.openGadget(gadgetId);
    const binding = await reloaded.getGatekeeperById(connectionId);
    const reopened = await binding.openSession() as RpcStub<InferOpsProjectSession>;
    const after = boardIssue(await reopened.readBoard(), created.id);
    expect(after).toMatchObject({
      id: before.id, identifier: before.identifier, revision: before.revision, stateId: before.stateId,
    });
    expect(after!.revision).toBe((await liveIssue(created.id)).revision);
    ws = reloaded;
    session = reopened;
    note(`g. after a Worker reload, binding ${connectionId} reads ${after!.identifier} ` +
      `at revision ${after!.revision}`);
  });

  it("h. on a content issue, a move the published policy denies surfaces FORBIDDEN; an allowed one applies", async () => {
    const policy = await ensureContentPolicyProject(LIVE.policyProject);
    const { Idea: idea, Draft: draft, Review: review, Published: published } = policy.lanes;
    const connection = await ws.newGatekeeper(accountId, boardUrl(LIVE.policyProject));
    if (!connection) throw new Error(`No connection for ${LIVE.policyProject}`);
    const policySession = await connection.openSession() as RpcStub<InferOpsProjectSession>;
    expect((await policySession.readBoard()).project.id).toBe(policy.projectId);

    // A content issue, created in the entry lane through the approval path.
    const contentTitle = `${title} (content)`;
    const create = await proposed(() =>
      policySession.createIssue({ title: contentTitle, priority: "medium", stateId: idea!.id }));
    await ws.approveAction(create.id);
    const [made] = await liveIssuesTitled(contentTitle, LIVE.policyProject);
    expect(made).toBeDefined();
    let issue = await liveIssue(made!.id);
    expect(issue).toMatchObject({ workflow: "content", stateId: idea!.id });

    /** Propose moving the issue, approve it, and answer the apply error ("" when it applied). */
    const move = async (to: State) => {
      const action = await proposed(async () =>
        (await policySession.openIssue(issue.id)).transition(to.id, issue.revision));
      // Proposing only simulates: InferOps is not asked until approval.
      expect((await liveIssue(issue.id)).stateId).toBe(issue.stateId);
      const message = await ws.approveAction(action.id).then(() => "", (error: unknown) =>
        error instanceof Error ? error.message : String(error));
      if (message) await ws.rejectAction(action.id);
      return message;
    };

    // Idea -> Draft is allowed by the open wildcard edge.
    expect(await move(draft!)).toBe("");
    const inDraft = await liveIssue(issue.id);
    expect(inDraft.stateId).toBe(draft!.id);
    const createdAt = issue.revision;
    issue = inDraft;

    // Draft -> Published is denied by the edge rule: approved in InferOS, refused by InferOps.
    const refused = await move(published!);
    expect(refused).toMatch(/does not permit it for this connection .*workflow policy/);
    const afterRefusal = await liveIssue(issue.id);
    expect(afterRefusal).toMatchObject({ stateId: draft!.id, revision: inDraft.revision });
    // The same move made directly is InferOps' policy refusal: 403 FORBIDDEN naming the edge rule.
    const direct = await fetch(`${LIVE.baseUrl}/project/issues/${issue.id}/transition`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${LIVE.token}`, "x-workspace-id": LIVE.workspaceId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ toStateId: published!.id, expectedRevision: inDraft.revision }),
    });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ error: {
      code: "FORBIDDEN",
      details: { decision: { allowed: false, reasonCodes: expect.arrayContaining(["EXPLICIT_DENY"]) } },
    } });
    expect((await liveIssue(issue.id)).revision).toBe(inDraft.revision);

    // Draft -> Review is allowed and applies.
    expect(await move(review!)).toBe("");
    const inReview = await liveIssue(issue.id);
    expect(inReview.stateId).toBe(review!.id);
    expect(inReview.revision).not.toBe(inDraft.revision);
    note(`h. ${LIVE.policyProject} (${policy.projectId}) content policy revision ${policy.revision} ` +
      "(Draft -> Published denies move-in to every user; explain: EXPLICIT_DENY). " +
      `Created ${inReview.identifier} (${inReview.id}) in Idea at revision ${createdAt}; ` +
      `Idea -> Draft applied (revision ${inDraft.revision}); Draft -> Published approved but refused ` +
      `by InferOps ("${refused}"; direct: 403 FORBIDDEN, EXPLICIT_DENY), still Draft at revision ${afterRefusal.revision}; ` +
      `Draft -> Review applied (revision ${inReview.revision})`);
  });
});

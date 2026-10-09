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
//   INFEROPS_LIVE_DISPATCH_PROJECT the coding project key (default `CODE`); see step i
//   INFEROPS_LIVE_REPO_ID        optional: a repository enrolled in that workspace
//                                (`POST /project/repos`, `project:manage`) for step i, which the
//                                gatekeeper then runs with `CODING_WORKBENCH_ENABLED=true` and that
//                                id alone on `CODING_WORKBENCH_REPOS`. Step i skips without it.
//   INFEROPS_LIVE_WIKI_WORKSPACE_ID   optional: an InferMind workspace the token's person belongs
//   INFEROPS_LIVE_WIKI_WORKSPACE_SLUG to (`knowledge` in the seed) for steps j and k. Both skip
//                                     without both. Step k needs a company structure: apply an
//                                     intake's pillars first (InferOps `pillar.apply`).
//
// It writes to InferOps: one new issue per run, titled `InferOS live <timestamp>`, which it then
// updates and moves. InferOps has no issue delete, so the issue is left in place. Step h also
// creates the content-policy project on first use (the token must hold `project:manage`, as the
// seed's `owner` does), publishes its workflow policy (a no-op once it is the head), and adds one
// content issue per run. Step i dispatches that run's issue to the enrolled repository: the run is
// queued (no runner is needed, none picks it up), then cancelled; the run record and the issue's
// move to `Queued` stay. Step j appends one marker line per run to one Wiki section, and
// overwrites the same section once directly to prove an apply-time version check. Step k
// appends one marker line per run to the body of one page filed under a pillar, and overwrites it
// once directly to prove InferOps' compare-and-swap refuses the overtaken approval.
// Step l proposes two edits of that page and rejects both, and admits one new Workshop user as a
// collaborator on a new gadget holding only the Wiki; nothing it does reaches InferOps.
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
  Board, InferOpsDispatchSession, InferOpsProjectSession, InferOpsWikiSession, Issue, State,
  WikiDocument,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

const LIVE = {
  baseUrl: process.env.INFEROPS_LIVE_BASE_URL?.replace(/\/+$/, "") ?? "",
  token: process.env.INFEROPS_LIVE_TOKEN ?? "",
  workspaceId: process.env.INFEROPS_LIVE_WORKSPACE_ID ?? "",
  workspaceSlug: process.env.INFEROPS_LIVE_WORKSPACE_SLUG ?? "",
  tenant: process.env.INFEROPS_LIVE_TENANT ?? "acme",
  project: process.env.INFEROPS_LIVE_PROJECT ?? "ENG",
  policyProject: process.env.INFEROPS_LIVE_POLICY_PROJECT ?? "CPOL",
  dispatchProject: process.env.INFEROPS_LIVE_DISPATCH_PROJECT ?? "CODE",
  repoId: process.env.INFEROPS_LIVE_REPO_ID?.toLowerCase() ?? "",
  wikiWorkspaceId: process.env.INFEROPS_LIVE_WIKI_WORKSPACE_ID ?? "",
  wikiWorkspaceSlug: process.env.INFEROPS_LIVE_WIKI_WORKSPACE_SLUG ?? "",
};
const WIKI_LIVE = Boolean(LIVE.wikiWorkspaceId && LIVE.wikiWorkspaceSlug);

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";

const boardUrl = (key: string) =>
  `inferops://${LIVE.tenant}.${LIVE.workspaceSlug}/project/board/${key}`;
const dispatchUrl = (key: string) =>
  `inferops://${LIVE.tenant}.${LIVE.workspaceSlug}/project/dispatch/${key}`;
const wikiUrl = (workspaceSlug: string) =>
  `inferops://${LIVE.tenant}.${workspaceSlug}/knowledge/wiki`;

/** One line per step, printed at the end as the run's evidence. Ids and revisions only. */
const evidence: string[] = [];
const note = (line: string) => evidence.push(line);

// ---------------------------------------------------------------------------
// Direct InferOps reads, the authority every step is checked against.

type LiveIssue = Issue & { projectId: string };

/** One InferOps request with the live token, in `workspaceId` (the board workspace by default). */
async function inferOpsResponse(path: string, init?: { method: string; body: unknown },
                                workspaceId = LIVE.workspaceId): Promise<Response> {
  return fetch(`${LIVE.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${LIVE.token}`,
      "x-workspace-id": workspaceId,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function inferOps(path: string, init?: { method: string; body: unknown },
                        workspaceId?: string): Promise<unknown> {
  const response = await inferOpsResponse(path, init, workspaceId);
  if (!response.ok) throw new Error(`InferOps ${init?.method ?? "GET"} ${path} answered ${response.status}`);
  return response.json();
}

/** A refused direct request's status and InferOps error code. */
async function inferOpsRefusal(path: string, init?: { method: string; body: unknown },
                               workspaceId?: string): Promise<{ status: number; code: string }> {
  const response = await inferOpsResponse(path, init, workspaceId);
  const body = await response.json() as { error?: { code?: string } };
  return { status: response.status, code: body.error?.code ?? "" };
}

type LiveRun = { id: string; issueId: string; repoId: string; status: string; baseRef: string | null };

const liveRun = async (id: string) =>
  ((await inferOps(`/project/runs/${id}`)) as { run: LiveRun }).run;

const liveRunsOf = async (issueId: string) =>
  ((await inferOps(`/project/runs?issueId=${issueId}`)) as { runs: LiveRun[] }).runs;

type LiveSection = { id: string; documentId: string; tag: string; body: string; version: number };

/** A live page's text as InferOps itself answers it (`document.text`, the string `read_document` returns). */
async function livePageText(id: string): Promise<string> {
  const { text } = await inferOps(`/knowledge/documents/${id}/text`, undefined, LIVE.wikiWorkspaceId) as
    { text: string | null };
  if (text === null) throw new Error(`InferOps shows no text for page ${id}`);
  return text;
}

const liveSection = async (id: string) =>
  await inferOps(`/knowledge/sections/${id}`, undefined, LIVE.wikiWorkspaceId) as LiveSection;

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

/** The message `call` failed with, or "" when it did not. */
const failure = (call: PromiseLike<unknown>) => Promise.resolve(call).then(() => "", (error: unknown) =>
  error instanceof Error ? error.message : String(error));

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

/** The id of project `key`, created with `name` when the workspace has none. */
async function ensureProject(key: string, name: string): Promise<string> {
  return await liveProjectId(key) ??
    ((await inferOps("/project/projects", {
      method: "POST", body: { name, identifier: key },
    })) as { project: { id: string } }).project.id;
}

/**
 * Create (or reuse) `key` for coding dispatch. InferOps moves a dispatched issue to its project's
 * software `Queued` state and answers 404 when the project has none, which is the case for a
 * project whose states predate the workflow templates (the seed's ENG: Backlog, Todo, In Progress,
 * Done, Cancelled). A project InferOps creates now gets both template ladders.
 */
async function ensureTemplateProject(key: string, name: string): Promise<{ projectId: string; states: State[] }> {
  const projectId = await ensureProject(key, name);
  const states = (await liveBoard(key)).columns.map(c => c.state);
  const software = states.filter(s => s.workflow === "software").map(s => s.name);
  if (!software.includes("Queued") || !software.includes("Ready")) {
    throw new Error(`${key} has no software Ready and Queued states (it has ${software.join(", ")}); ` +
      "InferOps cannot dispatch its issues. Use a project created from the workflow templates.");
  }
  return { projectId, states };
}

type PolicyProject = { projectId: string; revision: string; lanes: Record<string, State> };

/**
 * Create (or reuse) `key` and publish a content policy on it: every user may do everything and
 * take any edge, except that the Draft -> Published edge denies `move-in` to every user. Proves the
 * policy is live with `workflow/explain` before returning.
 */
async function ensureContentPolicyProject(key: string): Promise<PolicyProject> {
  const projectId = await ensureProject(key, "InferOS content policy");
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
            // Step i: coding dispatch on, with the enrolled repository the only one allowed.
            ...(LIVE.repoId
              ? { CODING_WORKBENCH_ENABLED: "true", CODING_WORKBENCH_REPOS: LIVE.repoId }
              : {}),
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

  /**
   * Restart every Worker on the same storage with `vars` merged into the gatekeeper's, then log in
   * again and reopen the shared workspace. A configuration update is the harness' only restart.
   */
  async function restartGatekeeper(vars: Record<string, string>) {
    const { id: gadgetId } = await ws.getMetadata();
    await harness.server.update(options => ({
      ...options,
      workers: options.workers.map(worker => {
        if (!("config" in worker)) throw new Error("Expected inline harness config");
        if (worker.config.name !== GATEKEEPER_WORKER) return worker;
        return { ...worker, config: { ...worker.config, vars: { ...worker.config.vars, ...vars } } };
      }),
    }));
    harness.url = (await harness.server.listen()).url;
    api = await logIn(connect(harness.url), username);
    ws = await api.openGadget(gadgetId);
  }

  const pending = async () => (await ws.listActions({ filter: "pending" })).entries;

  /** Approve `id` and answer the apply error, or "" when it applied. A refused action is rejected. */
  async function approveOrRefusal(id: number): Promise<string> {
    const message = await ws.approveAction(id).then(() => "", (error: unknown) =>
      error instanceof Error ? error.message : String(error));
    // A refusal InferOps answered is decided (failed); anything else is still pending.
    if (message && (await actionEntry(id))?.state === "pending") await ws.rejectAction(id);
    return message;
  }


  /** The action log entry of `id`, whatever its state. */
  async function actionEntry(id: number) {
    return (await ws.listActions({ filter: "all" })).entries.find(a => a.id === id);
  }

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
        // A refusal InferOps answered is decided (failed); anything else is still pending.
        if ((await actionEntry(action.id))?.state === "pending") await ws.rejectAction(action.id);
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

  it("e2. an update made stale after it was proposed ends failed, known not applied, and is never resent", async () => {
    const before = await liveIssue(created.id);
    const action = await proposed(async () =>
      (await session.openIssue(created.id)).update({ title: "Overtaken edit" }, before.revision));
    // Someone changes the issue in InferOps itself before the approval.
    await inferOps(`/project/issues/${created.id}`, {
      method: "PATCH", body: { priority: before.priority === "low" ? "medium" : "low", expectedRevision: before.revision },
    });
    const moved = await liveIssue(created.id);
    expect(moved.revision).not.toBe(before.revision);

    const message = await failure(ws.approveAction(action.id));
    expect(message).toContain("changed in InferOps after this update was proposed");
    const entry = await actionEntry(action.id);
    expect(entry).toMatchObject({
      state: "failed", lastAttempt: { outcome: "notApplied", code: "STALE_REVISION", retryable: false },
    });
    expect(await failure(ws.approveAction(action.id))).toMatch(/not pending/);
    const after = await liveIssue(created.id);
    expect(after.revision).toBe(moved.revision);
    expect(after.title).toBe(before.title);
    note(`e2. update proposed at revision ${before.revision}, overtaken in InferOps (now ${moved.revision}), ` +
      `approved: InferOps answered 409 STALE_REVISION; the action ended failed (notApplied, not retryable), ` +
      `a second approval was refused, and the issue stayed at ${after.revision} with its title`);
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
    const before = boardIssue(await session.readBoard(), created.id)!;

    // The changed var keeps the integration on (its default), so only the restart is observable.
    await restartGatekeeper({ INFEROPS_ENABLED: "true" });
    const binding = await ws.getGatekeeperById(connectionId);
    const reopened = await binding.openSession() as RpcStub<InferOpsProjectSession>;
    const after = boardIssue(await reopened.readBoard(), created.id);
    expect(after).toMatchObject({
      id: before.id, identifier: before.identifier, revision: before.revision, stateId: before.stateId,
    });
    expect(after!.revision).toBe((await liveIssue(created.id)).revision);
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

    let lastMove = 0;
    /** Propose moving the issue, approve it, and answer the apply error ("" when it applied). */
    const move = async (to: State) => {
      const action = await proposed(async () =>
        (await policySession.openIssue(issue.id)).transition(to.id, issue.revision));
      // Proposing only simulates: InferOps is not asked until approval.
      expect((await liveIssue(issue.id)).stateId).toBe(issue.stateId);
      const message = await ws.approveAction(action.id).then(() => "", (error: unknown) =>
        error instanceof Error ? error.message : String(error));
      lastMove = action.id;
      if (message && (await actionEntry(action.id))?.state === "pending") await ws.rejectAction(action.id);
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
    // The policy's refusal is known not applied and stands: the action ends failed.
    expect(await actionEntry(lastMove)).toMatchObject({
      state: "failed", lastAttempt: { outcome: "notApplied", code: "FORBIDDEN", retryable: false },
    });
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

  it.skipIf(!LIVE.repoId)("i. coding dispatch: an approved dispatch queues a real run, duplicates and stale revisions are refused, an approved cancel stops it (needs INFEROPS_LIVE_REPO_ID)", async () => {
    const repoId = LIVE.repoId;
    const key = LIVE.dispatchProject;
    // A dispatch moves the issue to its project's software `Queued` state, so the project needs
    // InferOps' software template ladder (see ensureTemplateProject).
    const { projectId, states: ladder } = await ensureTemplateProject(key, "InferOS coding dispatch");
    const board = await ws.newGatekeeper(accountId, boardUrl(key));
    if (!board) throw new Error(`No connection for ${boardUrl(key)}`);
    const boardSession = await board.openSession() as RpcStub<InferOpsProjectSession>;
    const ready = ladder.find(s => s.workflow === "software" && s.name === "Ready")!;
    const codingTitle = `${title} (coding)`;
    const create = await proposed(() =>
      boardSession.createIssue({ title: codingTitle, priority: "low", stateId: ready.id }));
    await ws.approveAction(create.id);
    const [made] = await liveIssuesTitled(codingTitle, key);
    if (!made) throw new Error(`The ${key} issue was not created`);
    const issueId = made.id;
    const fresh = await liveIssue(issueId);
    expect(fresh).toMatchObject({ workflow: "software", stateId: ready.id });
    expect(await liveRunsOf(issueId)).toEqual([]);

    // A board binding has no dispatch: the call fails and InferOps gets no run.
    const asDispatch = boardSession as unknown as RpcStub<InferOpsDispatchSession>;
    const boardRefusal = await failure(asDispatch.dispatch(fresh.identifier, { repoId }, fresh.revision));
    expect(boardRefusal).not.toBe("");
    expect(await liveRunsOf(issueId)).toEqual([]);

    const connection = await ws.newGatekeeper(accountId, dispatchUrl(key));
    if (!connection) throw new Error(`No connection for ${dispatchUrl(key)}`);
    const coding = await connection.openSession() as RpcStub<InferOpsDispatchSession>;
    // listRepos marks the allowlisted repository, and only it, as allowed.
    const repos = await coding.listRepos();
    const repo = repos.find(r => r.id === repoId);
    expect(repo).toMatchObject({ enabled: true, allowed: true });
    expect(repos.filter(r => r.allowed).map(r => r.id)).toEqual([repoId]);
    // A repository off the allowlist is refused before anything is proposed.
    const offList = crypto.randomUUID();
    expect(await failure(coding.dispatch(fresh.identifier, { repoId: offList }, fresh.revision)))
      .toMatch(/FORBIDDEN: .*not on this deployment's coding allowlist/);

    // Propose: listRuns shows a provisional run; InferOps has none until approval.
    const before = await liveIssue(issueId);
    const dispatch = await proposed(() => coding.dispatch(before.identifier, { repoId }, before.revision));
    expect(dispatch.type).toBe("action");
    expect((await coding.listRuns())[0]).toMatchObject({ issueId, pending: "dispatch", status: "queued" });
    expect(await liveRunsOf(issueId)).toEqual([]);
    expect((await liveIssue(issueId)).revision).toBe(before.revision);

    await ws.approveAction(dispatch.id);
    const runs = await liveRunsOf(issueId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({ issueId, repoId, status: "queued" });
    expect(await liveRun(run.id)).toMatchObject({ id: run.id, status: "queued" });
    expect(await coding.getRun(run.id)).toMatchObject({
      id: run.id, issueId, issueIdentifier: before.identifier, repoId, status: "queued",
    });
    const queued = await liveIssue(issueId);
    const queuedState = ladder.find(s => s.id === queued.stateId);
    expect(queuedState).toMatchObject({ workflow: "software", name: "Queued" });
    expect(queued.revision).not.toBe(before.revision);

    // A second dispatch of the issue is refused while its run is queued, by the gatekeeper and by
    // InferOps itself; a dispatch at the pre-dispatch revision is refused as stale.
    expect(await failure(coding.dispatch(before.identifier, { repoId }, queued.revision)))
      .toMatch(/^RUN_ACTIVE: /);
    const directDuplicate = await inferOpsRefusal(`/project/issues/${issueId}/dispatch`, {
      method: "POST", body: { action: "code", repoId, expectedRevision: queued.revision },
    });
    expect(directDuplicate).toMatchObject({ status: 409, code: "RUN_ACTIVE" });
    expect(await failure(coding.dispatch(before.identifier, { repoId }, before.revision)))
      .toMatch(/^STALE_REVISION: /);
    expect((await liveRunsOf(issueId)).map(r => r.id)).toEqual([run.id]);

    // Cancel through approval: still queued until approved, then cancelled in InferOps.
    const cancel = await proposed(() => coding.cancel(run.id));
    expect(await coding.getRun(run.id)).toMatchObject({ status: "queued", pending: "cancel" });
    expect((await liveRun(run.id)).status).toBe("queued");
    await ws.approveAction(cancel.id);
    expect((await liveRun(run.id)).status).toBe("cancelled");
    expect((await coding.getRun(run.id)).status).toBe("cancelled");

    // A dispatch whose issue changes in InferOps between proposal and approval is refused at apply
    // by InferOps' own revision check, and no run is made.
    const afterCancel = await liveIssue(issueId);
    const again = await proposed(() => coding.dispatch(afterCancel.identifier, { repoId }, afterCancel.revision));
    const { issue: changed } = await inferOps(`/project/issues/${issueId}`, {
      method: "PATCH", body: { priority: "medium", expectedRevision: afterCancel.revision },
    }) as { issue: LiveIssue };
    const staleApply = await approveOrRefusal(again.id);
    expect(staleApply).toMatch(/changed in InferOps after this dispatch was proposed/);
    expect((await liveRunsOf(issueId)).map(r => r.id)).toEqual([run.id]);
    expect((await liveIssue(issueId)).revision).toBe(changed.revision);

    note(`i. ${key} (${projectId}, template ladder) issue ${fresh.identifier} created in Ready via approval. ` +
      `Bound ${dispatchUrl(key)} (CODING_WORKBENCH_ENABLED=true, allowlist = repo ` +
      `${repo!.slug} ${repoId}); listRepos: ${repos.length} repo(s), only it allowed; a board binding's ` +
      `dispatch failed ("${boardRefusal.slice(0, 80)}"), no run; an off-allowlist repo refused FORBIDDEN. ` +
      `Dispatched ${before.identifier} (${issueId}) at revision ${before.revision}: absent from InferOps ` +
      `while pending; after approval run ${run.id} queued in InferOps (GET /project/runs/:id and getRun ` +
      `agree), issue -> ${queuedState?.name ?? queued.stateId} at revision ${queued.revision}. Duplicate ` +
      `refused RUN_ACTIVE (gatekeeper) and 409 RUN_ACTIVE (direct); revision ${before.revision} refused ` +
      `STALE_REVISION. Cancel approved: run ${run.id} cancelled in InferOps; issue at revision ` +
      `${afterCancel.revision}. A dispatch proposed at ${afterCancel.revision}, then the issue edited ` +
      `directly (revision ${changed.revision}), was refused at apply ("${staleApply.slice(0, 120)}"); ` +
      "no second run");
  });

  it.skipIf(!WIKI_LIVE)("j. the InferMind Wiki: reads, an approved section edit bumps its version, stale versions are refused, an InferOps workspace has no Wiki (needs INFEROPS_LIVE_WIKI_WORKSPACE_ID and _SLUG)", async () => {
    // While the stopgap connection is the InferOps workspace, its Wiki is refused by InferOps'
    // product gate (403), passed on as the gatekeeper's FORBIDDEN.
    const opsRefusal = await failure(ws.newGatekeeper(accountId, wikiUrl(LIVE.workspaceSlug)).then(c => {
      if (!c) throw new Error("newGatekeeper returned null");
    }));
    expect(opsRefusal).toMatch(/not an InferMind workspace/);
    expect(await inferOpsRefusal("/knowledge/documents")).toEqual({ status: 403, code: "FORBIDDEN" });

    // The stopgap connection names one workspace, so point it at the InferMind one.
    await restartGatekeeper({
      INFEROPS_WORKSPACE_ID: LIVE.wikiWorkspaceId, INFEROPS_WORKSPACE_SLUG: LIVE.wikiWorkspaceSlug,
    });
    const connection = await ws.newGatekeeper(accountId, wikiUrl(LIVE.wikiWorkspaceSlug));
    if (!connection) throw new Error(`No connection for ${wikiUrl(LIVE.wikiWorkspaceSlug)}`);
    const wiki = await connection.openSession() as RpcStub<InferOpsWikiSession>;

    // listDocuments is InferOps' page list.
    const pages = await wiki.listDocuments();
    const livePages = await inferOps("/knowledge/documents", undefined, LIVE.wikiWorkspaceId) as
      Array<{ id: string; slug: string }>;
    expect(pages.map(p => p.id).toSorted()).toEqual(livePages.map(p => p.id).toSorted());

    // The first page with a section; readDocument is InferOps' sections, in order.
    let page: WikiDocument | undefined;
    for (const node of pages) {
      const read = await wiki.readDocument(node.slug);
      if (read.sections.length > 0) { page = read; break; }
    }
    if (!page) throw new Error("No Wiki page with a section");
    const liveSections = await inferOps(`/knowledge/sections?documentId=${page.id}`, undefined,
      LIVE.wikiWorkspaceId) as LiveSection[];
    expect(page.sections.map(s => ({ id: s.id, body: s.body, version: s.version })))
      .toEqual(liveSections.map(s => ({ id: s.id, body: s.body, version: s.version })));
    // Page text follows InferOps' page contract: the body when the page has one, else its sections.
    expect(await wiki.readDocumentText(page.slug)).toBe(await livePageText(page.id));

    // An edit waits for approval: reads show it pending, InferOps still has the old body.
    const section = page.sections[0]!;
    const before = await liveSection(section.id);
    const body = `${before.body}\n\nInferOS live edit ${new Date().toISOString()}`;
    const edit = await proposed(() => wiki.updateSection(section.id, body, before.version));
    expect((await wiki.readDocument(page.id)).sections[0]).toMatchObject({
      id: section.id, body, version: before.version, pending: "update",
    });
    expect(await liveSection(section.id)).toMatchObject({ body: before.body, version: before.version });
    await ws.approveAction(edit.id);
    const edited = await liveSection(section.id);
    expect(edited.body).toBe(body);
    expect(edited.version).toBeGreaterThan(before.version);
    const shown = (await wiki.readDocument(page.id)).sections[0]!;
    expect(shown).toMatchObject({ body, version: edited.version });
    expect(shown.pending).toBeUndefined();

    // A proposal at the old version is refused as stale, before anything is queued.
    expect(await failure(wiki.updateSection(section.id, `${body} (stale)`, before.version)))
      .toMatch(/^STALE_REVISION: /);

    // An edit proposed at the current version, overtaken by a direct edit before approval, is
    // refused at apply: InferOps' PATCH has no expected version, so the gatekeeper checks it.
    const overtaken = await proposed(() => wiki.updateSection(section.id, `${body} (overtaken)`, edited.version));
    const direct = await inferOps(`/knowledge/sections/${section.id}`, {
      method: "PATCH", body: { body: `${body} (direct)` },
    }, LIVE.wikiWorkspaceId) as LiveSection;
    const staleApply = await approveOrRefusal(overtaken.id);
    expect(staleApply).toMatch(/changed in InferOps after this edit/);
    const final = await liveSection(section.id);
    expect(final).toMatchObject({ body: `${body} (direct)`, version: direct.version });

    note(`j. ${wikiUrl(LIVE.workspaceSlug)} refused ("${opsRefusal.slice(0, 100)}"; direct GET ` +
      `/knowledge/documents in ${LIVE.workspaceSlug}: 403 FORBIDDEN). Bound ` +
      `${wikiUrl(LIVE.wikiWorkspaceSlug)} (${LIVE.wikiWorkspaceId}): ${pages.length} pages; read ` +
      `${page.slug} (${page.id}, ${page.sections.length} sections, ${page.references.length} references); ` +
      "readDocumentText equals InferOps' document.text. Edited section " +
      `${section.tag} (${section.id}): pending at version ${before.version}, unchanged in InferOps; ` +
      `after approval version ${before.version} -> ${edited.version}. Version ${before.version} refused ` +
      `STALE_REVISION at proposal; an edit at ${edited.version} overtaken by a direct PATCH (version ` +
      `${direct.version}) refused at apply ("${staleApply.slice(0, 120)}"); section left at version ` +
      `${final.version}`);
  });

  it.skipIf(!WIKI_LIVE)("k. the Wiki's company structure and page bodies: the structure matches InferOps, page text follows the shared contract, an approved body edit is a strict version-checked write (needs INFEROPS_LIVE_WIKI_WORKSPACE_ID and _SLUG)", async () => {
    const connection = await ws.newGatekeeper(accountId, wikiUrl(LIVE.wikiWorkspaceSlug));
    if (!connection) throw new Error(`No connection for ${wikiUrl(LIVE.wikiWorkspaceSlug)}`);
    const wiki = await connection.openSession() as RpcStub<InferOpsWikiSession>;

    // readStructure is InferOps' structure: the root, the pillars in order, Masters and filed pages.
    const structure = await wiki.readStructure();
    const live = await inferOps("/knowledge/wiki/structure", undefined, LIVE.wikiWorkspaceId) as {
      root: { documentId: string } | null;
      pillars: { key: string; master: { documentId: string } | null; members: { documentId: string; slug: string }[] }[];
    };
    expect(structure.root?.id ?? null).toBe(live.root?.documentId ?? null);
    expect(structure.pillars.map(p => [p.key, p.master?.id ?? null, p.members.map(m => m.id)]))
      .toEqual(live.pillars.map(p => [p.key, p.master?.documentId ?? null, p.members.map(m => m.documentId)]));
    if (!structure.root || structure.pillars.length === 0) throw new Error("Apply an intake's pillars first (pillar.apply)");

    // A Master reads as its title, its body if any, then the generated block of its filed pages,
    // each linked as one encoded /wiki/ segment.
    const pillar = structure.pillars.find(p => p.master && p.members.length > 0) ?? structure.pillars[0]!;
    const masterText = await wiki.readDocumentText(pillar.master!.id);
    // InferOps' own text, coverage block included when the Wiki has a coverage source.
    expect(masterText).toBe(await livePageText(pillar.master!.id));
    const masterCoverage = masterText?.includes("## Documentation coverage") ?? false;
    expect(masterText).toContain(`## Pages in ${pillar.title}`);
    for (const member of pillar.members) {
      expect(masterText).toContain(`- [${member.title}](/wiki/${encodeURIComponent(member.slug)})`);
    }

    // A filed page reads as InferOps' own text for it.
    const member = pillar.members[0];
    if (!member) throw new Error(`Pillar ${pillar.key} files no page`);
    const page = await wiki.readDocument(member.id);
    const liveDoc = await inferOps(`/knowledge/documents/${member.id}`, undefined, LIVE.wikiWorkspaceId) as
      { body: string; version: number };
    expect({ body: page.body, version: page.version }).toEqual({ body: liveDoc.body, version: liveDoc.version });
    expect(await wiki.readDocumentText(member.id)).toBe(await livePageText(member.id));

    // A body edit waits for approval, shows as pendingBody, and leaves InferOps unchanged until then.
    const body = `# ${page.title}\n\n${liveDoc.body.replace(/^\s*#\s+.*(?:\r?\n)+/, "").trim()}\n\nInferOS live body edit ${new Date().toISOString()}`;
    const edit = await proposed(() => wiki.updateDocumentBody(member.id, body, page.version));
    expect(await wiki.readDocument(member.id)).toMatchObject({ body, version: page.version, pendingBody: true });
    expect((await inferOps(`/knowledge/documents/${member.id}`, undefined, LIVE.wikiWorkspaceId) as { version: number }).version)
      .toBe(page.version);
    await ws.approveAction(edit.id);
    const edited = await inferOps(`/knowledge/documents/${member.id}`, undefined, LIVE.wikiWorkspaceId) as
      { body: string; version: number };
    expect(edited).toMatchObject({ body, version: page.version + 1 });
    const shown = await wiki.readDocument(member.id);
    expect(shown).toMatchObject({ body, version: page.version + 1 });
    expect(shown.pendingBody).toBeUndefined();

    // A proposal at the old version is refused as stale before anything is queued.
    expect(await failure(wiki.updateDocumentBody(member.id, `${body} (stale)`, page.version)))
      .toMatch(/^STALE_REVISION: /);

    // An edit proposed at the current version and overtaken by a direct page edit -- even one that
    // writes the very same text -- is refused at apply by InferOps' strict compare-and-swap.
    const overtaken = await proposed(() => wiki.updateDocumentBody(member.id, `${body} (overtaken)`, edited.version));
    const direct = await inferOps(`/knowledge/wiki/pages/${member.id}`, {
      method: "PATCH", body: { body: `${body} (overtaken)`, expectedVersion: edited.version },
    }, LIVE.wikiWorkspaceId) as { document: { version: number } };
    const staleApply = await approveOrRefusal(overtaken.id);
    expect(staleApply).not.toBe("");
    const final = await inferOps(`/knowledge/documents/${member.id}`, undefined, LIVE.wikiWorkspaceId) as
      { body: string; version: number };
    expect(final).toMatchObject({ body: `${body} (overtaken)`, version: direct.document.version });

    note(`k. ${wikiUrl(LIVE.wikiWorkspaceSlug)}: readStructure equals InferOps' (root ${structure.root.id}, ` +
      `${structure.pillars.length} pillars: ${structure.pillars.map(p => `${p.key}=${p.members.length}`).join(", ")}). ` +
      `Master ${pillar.master!.slug} text equals InferOps' document.text (coverage block: ${masterCoverage ? "yes" : "no"}) ` +
      `and lists its filed pages as /wiki/<encoded slug>. Page ${member.slug} ` +
      `(${member.id}) text equals InferOps' document.text. Body edit pending at version ${page.version}, ` +
      `unchanged in InferOps; after approval version ${page.version} -> ${edited.version}. Version ` +
      `${page.version} refused STALE_REVISION at proposal; an edit at ${edited.version} overtaken by a ` +
      `direct same-text PATCH (version ${direct.document.version}) refused at apply ` +
      `("${staleApply.slice(0, 120)}"); page left at version ${final.version}`);
  });

  it.skipIf(!WIKI_LIVE)("l. page text: an edit waiting reads back composed here, and InferOps' text is withheld once a collaborator is admitted, the page itself is not (needs INFEROPS_LIVE_WIKI_WORKSPACE_ID and _SLUG; runs after k)", async () => {
    // A gadget of its own holding only the Wiki, so a collaborator is verified against nothing else.
    ws = await api.newGadget();
    const connection = await ws.newGatekeeper(accountId, wikiUrl(LIVE.wikiWorkspaceSlug));
    if (!connection) throw new Error(`No connection for ${wikiUrl(LIVE.wikiWorkspaceSlug)}`);
    const wiki = await connection.openSession() as RpcStub<InferOpsWikiSession>;
    const structure = await wiki.readStructure();
    const pillar = structure.pillars.find(p => p.master && p.members.length > 0);
    if (!pillar) throw new Error("Apply an intake's pillars first (pillar.apply)");
    const master = pillar.master!;
    const member = pillar.members[0]!;

    /** Propose a body edit of the member page that stays pending. */
    const proposeEdit = async (marker: string) => {
      const page = await wiki.readDocument(member.id);
      const body = `# ${page.title}\n\n${page.body.replace(/^\s*#\s+.*(?:\r?\n)+/, "").trim()}\n\n${marker}`;
      return await proposed(() => wiki.updateDocumentBody(member.id, body, page.version));
    };

    // An edit of its own waiting: the page reads back with it, composed in InferOS (InferOps has
    // not got it), while a page with nothing waiting still reads InferOps' own text.
    const marker = `InferOS live pending ${new Date().toISOString()}`;
    const edit = await proposeEdit(marker);
    const pendingText = await wiki.readDocumentText(member.id);
    expect(pendingText).toContain(marker);
    expect(await livePageText(member.id)).not.toContain(marker);
    expect(await wiki.readDocumentText(master.id)).toBe(await livePageText(master.id));
    await ws.rejectAction(edit.id);
    expect(await wiki.readDocumentText(member.id)).toBe(await livePageText(member.id));

    // A collaborator admitted to this gadget, verified against the Wiki with their own account.
    const [collaboratorName] = nextUsernames("inferopslivec");
    const collaborator = await signUp(connect(harness.url), collaboratorName!);
    await collaborator.provisionAmbientAccount(VENDOR);
    const collaboratorAccount = await waitFor("the collaborator's InferOps account", async () =>
      (await listConnectedAccounts(collaborator)).find(a => a.vendorId === VENDOR) ?? null);
    const { id: gadgetId } = await ws.getMetadata();
    expect(await ws.addCollaborator(collaboratorName!, "build")).toBeTruthy();
    const asked = new ObserverConfigRecorder().alwaysChoose(collaboratorAccount.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(asked);
    using _collaboratorWs = await collaborator.openGadget(gadgetId, undefined, callback);

    // InferOps' text carries coverage and live widget state the Wiki admission does not cover: withheld.
    const blocked = await failure(wiki.readDocumentText(master.id));
    expect(blocked).toMatch(/blocked because it contains data that a current collaborator/);
    // The page itself is Wiki data the admission covers.
    expect((await wiki.readDocument(master.id)).id).toBe(master.id);
    // A page with an edit of its own waiting is composed here from Wiki data only: still readable.
    const edit2 = await proposeEdit(`${marker} (with a collaborator)`);
    expect(await wiki.readDocumentText(member.id)).toContain(`${marker} (with a collaborator)`);
    await ws.rejectAction(edit2.id);

    note(`l. ${wikiUrl(LIVE.wikiWorkspaceSlug)}: page ${member.slug} with a pending body edit read back ` +
      "composed in InferOS (edit shown, absent from InferOps' document.text); Master " +
      `${master.slug} still equal to InferOps' text; after rejecting, ${member.slug} equal to InferOps' ` +
      `text again. Collaborator ${collaboratorName} admitted: Master text withheld ("${blocked.slice(0, 110)}"), ` +
      "readDocument still answered, a pending-edit read still composed here");
  });
});

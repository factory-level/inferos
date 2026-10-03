// MOCK InferOps data source: the only module that holds project data. It is the default data source
// (the demo host, and every test), beside the HTTP client in http-inferops.ts, and enforces the
// rules the gatekeeper relies on: project scope, state membership, workflow compatibility,
// expected-revision checks and idempotent replay, for moves, creates and updates. It advances a
// revision by one per write and starts a created issue at "1"; InferOps does not, and nothing may
// depend on it.
//
// One `MockInferOps` Durable Object per (host, account) holds a private copy of the seed fixture,
// so each auto-provisioned account starts from the same demo board and its moves stay its own.
//
// Coding dispatch: two seeded repositories (one enabled, one disabled) and a run ledger with
// InferOps' dispatch guards (software workflow, an open state, no active run, an enabled repository,
// the expected revision) and per-key replay. A dispatch advances the issue's revision, as InferOps'
// move to Queued does, but leaves its state: the demo board has no Queued state. Nothing runs the
// queued runs; `setRunStatus` stands in for the runner.

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import SEED from "./fixtures/demo-board.json";
import {
  InferOpsError, type DispatchRequest, type InferOpsClient, type IssueChanges, type NewIssueRequest,
  type ProjectSnapshot, type ProjectSummary, type RepoRecord, type RunRecord,
} from "./inferops-client";
import type { Issue, Revision, RunResult, RunStatus } from "./types";

/** The only InferOps host the mock serves; resource URLs naming another host are refused. */
export const MOCK_HOST = "demo.local";

const DATA_KEY = "data:v1";
const RUNS_KEY = "runs:v1";
const IDEMPOTENCY_PREFIX = "idem:";

/** The demo workspace's repositories. Only ids reach a dispatch; there is nothing to clone. */
export const MOCK_REPOS: readonly RepoRecord[] = [
  { id: "40000000-0000-4000-8000-000000000001", slug: "demo-app", defaultBaseRef: "main", enabled: true },
  { id: "40000000-0000-4000-8000-000000000002", slug: "legacy-app", defaultBaseRef: "main", enabled: false },
];

const logger = createLogger<{ vendorId: string; projectKey: string; replayed: boolean }>({
  component: "gatekeeper.inferops", vendorId: "inferops",
});

/** The projects, and each issue's description by id (not part of `Issue`, so kept apart). */
type MockData = { projects: ProjectSnapshot[]; descriptions?: Record<string, string | null> };

/**
 * What one idempotency key was used for, and what it produced (an issue, or a run). The operation is
 * its JSON text, built in a fixed member order, so two uses compare as strings.
 */
type IdempotencyRecord<T = Issue> = { operation: string; result: T };

function notFound(): InferOpsError {
  // One message for "no such issue" and "issue of another project", so a caller cannot probe.
  return new InferOpsError("NOT_FOUND", "No such issue in this project.");
}

/** The seed fixture. JSON imports widen literal unions to string, so the shape is asserted here. */
function seedData(): MockData {
  return structuredClone(SEED) as unknown as MockData;
}

/** Per-account mock InferOps store. Reached only through `openInferOpsClient`. */
@validateRpc()
export class MockInferOps extends DurableObject<Cloudflare.Env> {
  #data(): MockData {
    let data = this.ctx.storage.kv.get<MockData>(DATA_KEY);
    if (!data) {
      data = seedData();
      this.ctx.storage.kv.put(DATA_KEY, data);
    }
    return data;
  }

  #project(data: MockData, projectKey: string): ProjectSnapshot {
    const project = data.projects.find(p => p.project.identifier === projectKey);
    if (!project) throw new InferOpsError("NOT_FOUND", `No such project: ${projectKey}.`);
    return project;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.#data().projects.map(({ project }) =>
      ({ identifier: project.identifier, name: project.name }));
  }

  async hasProject(projectKey: string): Promise<boolean> {
    return this.#data().projects.some(p => p.project.identifier === projectKey);
  }

  async readProject(projectKey: string): Promise<ProjectSnapshot> {
    return this.#project(this.#data(), projectKey);
  }

  async readIssue(projectKey: string, issueId: string): Promise<Issue> {
    const issue = this.#project(this.#data(), projectKey).issues.find(i => i.id === issueId);
    if (!issue) throw notFound();
    return issue;
  }

  async transition(
    projectKey: string, issueId: string, toStateId: string, expectedRevision: Revision,
    idempotencyKey: string,
  ): Promise<Issue> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    if (!/^\d+$/.test(expectedRevision)) {
      throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
    }
    const operation = JSON.stringify(["transition", projectKey, issueId, toStateId, expectedRevision]);

    // Replay first: a retried apply must succeed even though its own first attempt already moved
    // the revision on.
    const previous = this.#replayed<Issue>(idempotencyKey, operation);
    if (previous) return previous;

    const data = this.#data();
    const project = this.#project(data, projectKey);
    const issue = project.issues.find(i => i.id === issueId);
    if (!issue) throw notFound();
    const state = project.states.find(s => s.id === toStateId);
    if (!state) {
      throw new InferOpsError("INVALID_STATE", `The target state is not part of project ${projectKey}.`);
    }
    if (state.workflow !== issue.workflow) {
      throw new InferOpsError("WORKFLOW_MISMATCH",
        `${issue.identifier} is a ${issue.workflow} issue and cannot enter the ${state.workflow} ` +
        `state "${state.name}".`);
    }
    if (issue.revision !== expectedRevision) {
      throw new InferOpsError("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${expectedRevision}.`);
    }

    issue.stateId = toStateId;
    return this.#commit(data, issue, idempotencyKey, operation, projectKey);
  }

  async createIssue(projectKey: string, request: NewIssueRequest, idempotencyKey: string):
      Promise<Issue> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    const operation = JSON.stringify(["create", projectKey, request.title,
      request.description ?? null, request.priority ?? null, request.stateId, request.workflow ?? null]);
    const previous = this.#replayed<Issue>(idempotencyKey, operation);
    if (previous) return previous;

    const data = this.#data();
    const project = this.#project(data, projectKey);
    const title = request.title.trim();
    if (!title || title.length > 500) {
      throw new InferOpsError("INVALID_REQUEST", "A title of 1 to 500 characters is required.");
    }
    const state = project.states.find(s => s.id === request.stateId);
    if (!state) {
      throw new InferOpsError("NOT_FOUND", `The target state is not part of project ${projectKey}.`);
    }
    const workflow = request.workflow ?? "software";
    if (state.workflow !== workflow) {
      throw new InferOpsError("WORKFLOW_MISMATCH",
        `A ${workflow} issue cannot be created in the ${state.workflow} state "${state.name}".`);
    }
    const seq = project.issues.reduce((max, i) =>
      Math.max(max, Number(/-(\d+)$/.exec(i.identifier)?.[1] ?? 0)), 0) + 1;
    const issue: Issue = {
      id: crypto.randomUUID(), identifier: `${projectKey}-${seq}`, title,
      priority: request.priority ?? "none", stateId: state.id, targetDate: null, workflow,
      revision: "0", assigneeId: null, blockedReason: null,
    };
    project.issues.push(issue);
    (data.descriptions ??= {})[issue.id] = request.description ?? null;
    return this.#commit(data, issue, idempotencyKey, operation, projectKey);
  }

  async updateIssue(
    projectKey: string, issueId: string, changes: IssueChanges, expectedRevision: Revision,
    idempotencyKey: string,
  ): Promise<Issue> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    if (!/^\d+$/.test(expectedRevision)) {
      throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
    }
    const { title, description, priority } = changes;
    if (title === undefined && description === undefined && priority === undefined) {
      throw new InferOpsError("INVALID_REQUEST", "An update must change at least one field.");
    }
    const operation = JSON.stringify(["update", projectKey, issueId, title ?? null,
      description === undefined ? "(unchanged)" : description, priority ?? null, expectedRevision]);
    const previous = this.#replayed<Issue>(idempotencyKey, operation);
    if (previous) return previous;

    const data = this.#data();
    const issue = this.#project(data, projectKey).issues.find(i => i.id === issueId);
    if (!issue) throw notFound();
    if (issue.revision !== expectedRevision) {
      throw new InferOpsError("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${expectedRevision}.`);
    }
    if (title !== undefined) issue.title = title;
    if (priority !== undefined) issue.priority = priority;
    if (description !== undefined) (data.descriptions ??= {})[issue.id] = description;
    return this.#commit(data, issue, idempotencyKey, operation, projectKey);
  }

  #runs(): RunRecord[] {
    return this.ctx.storage.kv.get<RunRecord[]>(RUNS_KEY) ?? [];
  }

  #run(projectKey: string, runId: string): RunRecord {
    const project = this.#project(this.#data(), projectKey);
    const run = this.#runs().find(r => r.id === runId);
    if (!run || !project.issues.some(i => i.id === run.issueId)) {
      throw new InferOpsError("NOT_FOUND", "No such run in this project.");
    }
    return run;
  }

  #saveRun(run: RunRecord): void {
    this.ctx.storage.kv.put(RUNS_KEY, [run, ...this.#runs().filter(r => r.id !== run.id)]);
  }

  async listRepos(): Promise<RepoRecord[]> {
    return MOCK_REPOS.map(repo => ({ ...repo }));
  }

  async listRuns(projectKey: string, issueId?: string): Promise<RunRecord[]> {
    const issues = this.#project(this.#data(), projectKey).issues;
    if (issueId !== undefined && !issues.some(i => i.id === issueId)) throw notFound();
    return this.#runs().filter(run => issueId === undefined
      ? issues.some(i => i.id === run.issueId) : run.issueId === issueId);
  }

  async readRun(projectKey: string, runId: string): Promise<RunRecord> {
    return this.#run(projectKey, runId);
  }

  async dispatchIssue(
    projectKey: string, issueId: string, request: DispatchRequest, idempotencyKey: string,
  ): Promise<RunRecord> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    if (!/^\d+$/.test(request.expectedRevision)) {
      throw new InferOpsError("INVALID_REQUEST", "The expected revision must be a decimal string.");
    }
    const operation = JSON.stringify(["dispatch", projectKey, issueId, request.repoId,
      request.baseRef ?? null, request.expectedRevision]);
    // Replay before every guard, as InferOps does: a retry gets the run it already queued, not
    // RUN_ACTIVE for it.
    const previous = this.#replayed<RunRecord>(idempotencyKey, operation);
    if (previous) return previous;

    const data = this.#data();
    const project = this.#project(data, projectKey);
    const issue = project.issues.find(i => i.id === issueId);
    if (!issue) throw notFound();
    if (issue.workflow !== "software") {
      throw new InferOpsError("WORKFLOW_MISMATCH", `${issue.identifier} is content work; only software issues can be coded.`);
    }
    const group = project.states.find(s => s.id === issue.stateId)?.group;
    if (group === "completed" || group === "cancelled") {
      throw new InferOpsError("CONFLICT", `${issue.identifier} is already ${group}.`);
    }
    if (this.#runs().some(r => r.issueId === issueId && (r.status === "queued" || r.status === "running"))) {
      throw new InferOpsError("RUN_ACTIVE", `${issue.identifier} already has an active run.`);
    }
    const repo = MOCK_REPOS.find(r => r.id === request.repoId);
    if (!repo?.enabled) {
      throw new InferOpsError("INVALID_REQUEST", "The repository is not enrolled in this workspace, or is disabled.");
    }
    if (issue.revision !== request.expectedRevision) {
      throw new InferOpsError("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${request.expectedRevision}.`);
    }
    const run: RunRecord = {
      id: crypto.randomUUID(), issueId, issueIdentifier: issue.identifier, repoId: repo.id,
      status: "queued", baseRef: request.baseRef ?? null, externalRunId: null, result: null,
      error: null, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
    issue.revision = (BigInt(issue.revision) + 1n).toString();
    this.ctx.storage.kv.put(DATA_KEY, data);
    this.#saveRun(run);
    this.#remember(idempotencyKey, operation, run);
    return run;
  }

  async cancelRun(projectKey: string, runId: string, idempotencyKey: string): Promise<RunRecord> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    const operation = JSON.stringify(["cancel", projectKey, runId]);
    const previous = this.#replayed<RunRecord>(idempotencyKey, operation);
    if (previous) return previous;
    const run = this.#run(projectKey, runId);
    if (run.status !== "queued" && run.status !== "running") {
      throw new InferOpsError("CONFLICT", `The run is already ${run.status}.`);
    }
    const cancelled: RunRecord = {
      ...run, status: run.status === "queued" ? "cancelled" : "unknown",
      error: `Cancelled while ${run.status}`, finishedAt: new Date().toISOString(),
    };
    this.#saveRun(cancelled);
    this.#remember(idempotencyKey, operation, cancelled);
    return cancelled;
  }

  /**
   * Stand in for the runner: move a run of this account's demo data to `status`, with a result
   * when it succeeded. There is no runner for demo data; tests and demos drive runs with this.
   */
  async setRunStatus(runId: string, status: RunStatus, result?: RunResult): Promise<void> {
    const run = this.#runs().find(r => r.id === runId);
    if (!run) throw new InferOpsError("NOT_FOUND", "No such run.");
    this.#saveRun({ ...run, status, result: result ?? run.result });
  }

  /** The result a key already produced for this operation; throws if it produced another's. */
  #replayed<T>(idempotencyKey: string, operation: string): T | undefined {
    const previous = this.ctx.storage.kv.get<IdempotencyRecord<T>>(IDEMPOTENCY_PREFIX + idempotencyKey);
    if (!previous) return undefined;
    if (previous.operation !== operation) {
      throw new InferOpsError(
        "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different change.");
    }
    logger.info("write replayed", { event: "mock.write.replayed", replayed: true });
    return previous.result;
  }

  #remember<T>(idempotencyKey: string, operation: string, result: T): void {
    this.ctx.storage.kv.put<IdempotencyRecord<T>>(IDEMPOTENCY_PREFIX + idempotencyKey, { operation, result });
  }

  /** Advance the issue's revision, store the data and the key's result, and return the issue. */
  #commit(data: MockData, issue: Issue, idempotencyKey: string, operation: string,
          projectKey: string): Issue {
    issue.revision = (BigInt(issue.revision) + 1n).toString();
    this.ctx.storage.kv.put(DATA_KEY, data);
    this.#remember(idempotencyKey, operation, issue);
    logger.info("write applied", { event: "mock.write.applied", projectKey, replayed: false });
    return issue;
  }

  async forget(): Promise<void> {
    this.ctx.storage.deleteAll();
  }
}

/** Identifies whose InferOps data a client reads: the account, on one InferOps host. */
export type InferOpsAccountRef = { accountId: string; host: string };

/**
 * The data source for one account. The mock serves only `MOCK_HOST`; any other host is refused
 * rather than silently answered from demo data.
 */
export function openInferOpsClient(
  namespace: DurableObjectNamespace<MockInferOps>, account: InferOpsAccountRef,
): InferOpsClient {
  if (account.host !== MOCK_HOST) {
    throw new InferOpsError("NOT_FOUND", `Unknown InferOps host: ${account.host}.`);
  }
  const stub = namespace.getByName(`${account.host}/${account.accountId}`);
  return {
    listProjects: () => stub.listProjects(),
    readProject: projectKey => stub.readProject(projectKey),
    readIssue: (projectKey, issueId) => stub.readIssue(projectKey, issueId),
    transition: (projectKey, issueId, toStateId, expectedRevision, idempotencyKey) =>
      stub.transition(projectKey, issueId, toStateId, expectedRevision, idempotencyKey),
    createIssue: (projectKey, issue, idempotencyKey) =>
      stub.createIssue(projectKey, issue, idempotencyKey),
    updateIssue: (projectKey, issueId, changes, expectedRevision, idempotencyKey) =>
      stub.updateIssue(projectKey, issueId, changes, expectedRevision, idempotencyKey),
    hasProject: projectKey => stub.hasProject(projectKey),
    listRepos: () => stub.listRepos(),
    listRuns: (projectKey, issueId) => stub.listRuns(projectKey, issueId),
    readRun: (projectKey, runId) => stub.readRun(projectKey, runId),
    dispatchIssue: (projectKey, issueId, request, idempotencyKey) =>
      stub.dispatchIssue(projectKey, issueId, request, idempotencyKey),
    cancelRun: (projectKey, runId, idempotencyKey) => stub.cancelRun(projectKey, runId, idempotencyKey),
    forget: () => stub.forget(),
  };
}

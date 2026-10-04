// MOCK InferOps data source: the only module that holds project data. It is the default data source
// (the demo host, and every test), beside the HTTP client in http-inferops.ts, and enforces the
// rules the gatekeeper relies on: project scope, state membership, workflow compatibility,
// expected-revision checks and idempotent replay, for moves, creates and updates. It advances a
// revision by one per write and starts a created issue at "1"; InferOps does not, and nothing may
// depend on it.
//
// One `MockInferOps` Durable Object per (host, account) holds a private copy of the seed fixture,
// so each auto-provisioned account starts from the same demo board and its moves stay its own.
// Revoking the account (`forget`) deletes that copy and leaves a tombstone: every later call is
// refused UNAUTHORIZED, as a real InferOps refuses a signed-out session, rather than re-seeding
// fresh demo data under a binding the Workshop no longer honours.
//
// Coding dispatch: two seeded repositories (one enabled, one disabled) and a run ledger with
// InferOps' dispatch guards (software workflow, an open state, no active run, an enabled repository,
// the expected revision) and per-key replay. A dispatch advances the issue's revision, as InferOps'
// move to Queued does, but leaves its state: the demo board has no Queued state. Nothing runs the
// queued runs; `setRunStatus` stands in for the runner.
//
// Wiki: a small synthetic InferMind Wiki (`src/fixtures/demo-wiki.json`), with InferOps' section
// semantics: a body write advances the section's version by one, takes no expected version and
// does not replay an idempotency key (the gatekeeper's own re-read is what guards it). Pages are
// listed by sibling order, then title, and sections in page order. `setInferMindEnabled(false)`
// turns the demo workspace into one without InferMind, so every Wiki call fails FORBIDDEN as
// InferOps' product gate does.
//
// Large boards (#28, development only): `MOCK_INFEROPS_SYNTHETIC_ISSUES=<n>` (the dev server passes
// it through from the shell or `.dev.vars`) adds a synthetic project `PERF` with n issues over six
// states when an account's data is first seeded, for measuring the Kanban against a board of a
// realistic size. Unset, or not a whole number from 1 to MAX_SYNTHETIC_ISSUES, it adds nothing; an
// account seeded before it was set keeps its data (`pnpm local reset --yes` starts over).

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import SEED from "./fixtures/demo-board.json";
import WIKI_SEED from "./fixtures/demo-wiki.json";
import {
  InferOpsError, type DispatchRequest, type InferOpsClient, type IssueChanges, type NewIssueRequest,
  type ProjectSnapshot, type ProjectSummary, type RepoRecord, type RunRecord, type WikiDocumentHead,
  type WikiDocumentRecord, type WikiSectionRecord,
} from "./inferops-client";
import type { Issue, Revision, RunResult, RunStatus } from "./types";

/** The only InferOps host the mock serves; resource URLs naming another host are refused. */
export const MOCK_HOST = "demo.local";

const DATA_KEY = "data:v1";
const RUNS_KEY = "runs:v1";
const IDEMPOTENCY_PREFIX = "idem:";
const WIKI_KEY = "wiki:v1";
const NO_INFERMIND_KEY = "wiki:no-infermind";
const REVOKED_KEY = "revoked";

/** The demo Wiki: its pages and their sections. */
type MockWiki = { documents: WikiDocumentRecord[]; sections: WikiSectionRecord[] };

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

/** The most issues `MOCK_INFEROPS_SYNTHETIC_ISSUES` may ask for: about 0.7 MB, well inside one stored value. */
export const MAX_SYNTHETIC_ISSUES = 2000;

/** The synthetic project's key; its board is `inferops://demo.local/project/board/PERF`. */
export const SYNTHETIC_PROJECT_KEY = "PERF";

const SYNTHETIC_STATES = [
  ["Backlog", "backlog"], ["Ready", "unstarted"], ["Working", "started"], ["Review", "started"],
  ["Done", "completed"], ["Cancelled", "cancelled"],
] as const;
const SYNTHETIC_PRIORITIES: Issue["priority"][] = ["urgent", "high", "medium", "low", "none"];
const SYNTHETIC_WORDS = ["Verify", "the", "shift", "handover", "checklist", "for", "line", "three", "and", "record",
  "sensor", "drift"];

const syntheticId = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;

/**
 * A deterministic project of `count` issues spread round-robin over six software states, with the
 * same mix of titles, assignees, target dates and blockers as the frontend's synthetic boards
 * (`syntheticBoard.ts`). Its ids differ from the fixture's in the fourth group, so they never collide.
 */
export function syntheticProject(count: number): ProjectSnapshot {
  const states = SYNTHETIC_STATES.map(([name, group], i): ProjectSnapshot["states"][number] =>
    ({ id: syntheticId(0x20000000, i + 1), name, group, position: i, workflow: "software" }));
  const issues = Array.from({ length: count }, (_, i): Issue => {
    const n = i + 1;
    return {
      id: syntheticId(0x30000000, n),
      identifier: `${SYNTHETIC_PROJECT_KEY}-${n}`,
      title: Array.from({ length: 4 + (n % 8) }, (_word, w) => SYNTHETIC_WORDS[(n + w) % SYNTHETIC_WORDS.length]).join(" "),
      priority: SYNTHETIC_PRIORITIES[n % SYNTHETIC_PRIORITIES.length]!,
      stateId: states[i % states.length]!.id,
      targetDate: n % 3 === 0 ? `2026-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}` : null,
      workflow: "software",
      revision: String(1 + (n % 40)),
      assigneeId: n % 2 === 0 ? syntheticId(0x40000000, n % 25) : null,
      blockedReason: n % 11 === 0 ? "Waiting for the vendor to confirm the replacement part." : null,
    };
  });
  return {
    project: { id: syntheticId(0x10000000, 1), identifier: SYNTHETIC_PROJECT_KEY, name: "Synthetic large board" },
    states, issues,
  };
}

/** The issue count `MOCK_INFEROPS_SYNTHETIC_ISSUES` asks for, or null when it asks for none. */
export function syntheticIssueCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const count = Number(value);
  return count >= 1 && count <= MAX_SYNTHETIC_ISSUES ? count : null;
}

/**
 * The seed fixture, plus the synthetic project when `MOCK_INFEROPS_SYNTHETIC_ISSUES` asks for one.
 * JSON imports widen literal unions to string, so the fixture's shape is asserted here.
 */
function seedData(env: Pick<Cloudflare.Env, "MOCK_INFEROPS_SYNTHETIC_ISSUES">): MockData {
  const data = structuredClone(SEED) as unknown as MockData;
  const count = syntheticIssueCount(env.MOCK_INFEROPS_SYNTHETIC_ISSUES);
  if (count !== null) data.projects.push(syntheticProject(count));
  else if (env.MOCK_INFEROPS_SYNTHETIC_ISSUES !== undefined) {
    logger.warn("synthetic project not seeded", { event: "mock.synthetic.invalid" });
  }
  return data;
}

/** Per-account mock InferOps store. Reached only through `openInferOpsClient`. */
@validateRpc()
export class MockInferOps extends DurableObject<Cloudflare.Env> {
  /** Refuses every call once the account was revoked; its data is gone and must not re-seed. */
  #assertLive(): void {
    if (this.ctx.storage.kv.get<boolean>(REVOKED_KEY)) {
      throw new InferOpsError("UNAUTHORIZED", "This InferOps account was disconnected.");
    }
  }

  #data(): MockData {
    this.#assertLive();
    let data = this.ctx.storage.kv.get<MockData>(DATA_KEY);
    if (!data) {
      data = seedData(this.env);
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
    this.#assertLive();
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
    this.#assertLive();
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

  #wiki(): MockWiki {
    this.#assertLive();
    if (this.ctx.storage.kv.get<boolean>(NO_INFERMIND_KEY)) {
      throw new InferOpsError("FORBIDDEN",
        "This demo workspace has no InferMind Wiki (InferMind is turned off for it).");
    }
    let wiki = this.ctx.storage.kv.get<MockWiki>(WIKI_KEY);
    if (!wiki) {
      const { documents, sections } = structuredClone(WIKI_SEED) as unknown as MockWiki;
      wiki = { documents, sections };
      this.ctx.storage.kv.put(WIKI_KEY, wiki);
    }
    return wiki;
  }

  async listDocuments(): Promise<WikiDocumentRecord[]> {
    return this.#wiki().documents.toSorted((a, b) =>
      a.siblingOrder - b.siblingOrder || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  }

  async readDocument(documentId: string): Promise<WikiDocumentHead> {
    const found = this.#wiki().documents.find(d => d.id === documentId);
    if (!found) throw new InferOpsError("NOT_FOUND", "No such page in this Wiki.");
    return { id: found.id, slug: found.slug, title: found.title };
  }

  async listSections(documentId: string): Promise<WikiSectionRecord[]> {
    await this.readDocument(documentId);
    return this.#wiki().sections.filter(s => s.documentId === documentId);
  }

  async readSection(sectionId: string): Promise<WikiSectionRecord> {
    const found = this.#wiki().sections.find(s => s.id === sectionId);
    if (!found) throw new InferOpsError("NOT_FOUND", "No such section in this Wiki.");
    return found;
  }

  async updateSection(sectionId: string, body: string, idempotencyKey: string):
      Promise<WikiSectionRecord> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    const wiki = this.#wiki();
    const section = wiki.sections.find(s => s.id === sectionId);
    if (!section) throw new InferOpsError("NOT_FOUND", "No such section in this Wiki.");
    section.body = body;
    section.version += 1;
    this.ctx.storage.kv.put(WIKI_KEY, wiki);
    return section;
  }

  /** Make the demo workspace one with InferMind (the default) or without it. */
  async setInferMindEnabled(enabled: boolean): Promise<void> {
    if (enabled) this.ctx.storage.kv.delete(NO_INFERMIND_KEY);
    else this.ctx.storage.kv.put(NO_INFERMIND_KEY, true);
  }

  /** The result a key already produced for this operation; throws if it produced another's. */
  #replayed<T>(idempotencyKey: string, operation: string): T | undefined {
    this.#assertLive();
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

  /** Deletes the account's data and refuses every later call (see the header). */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(REVOKED_KEY, true);
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
    listDocuments: () => stub.listDocuments(),
    readDocument: documentId => stub.readDocument(documentId),
    listSections: documentId => stub.listSections(documentId),
    readSection: sectionId => stub.readSection(sectionId),
    updateSection: (sectionId, body, idempotencyKey) => stub.updateSection(sectionId, body, idempotencyKey),
    forget: () => stub.forget(),
  };
}

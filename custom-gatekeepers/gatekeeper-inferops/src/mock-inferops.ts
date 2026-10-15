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
// does not replay an idempotency key (the gatekeeper's own re-read is what guards it). Pages carry
// InferOps' page semantics: a body, a version and a Master role; a page body write is a strict
// compare-and-swap on the version that replays only a retry of the page's last write: the same key,
// expected version and payload (InferOps' receipt over key, principal, expected version, operation
// and payload; one account is one principal here) while the page is exactly one version later (`lockForPageWrite`). A key
// reused with another payload is refused as stale, like any other stale write. The structure read
// mirrors InferOps' `getWikiStructure`: live pillars by position, members by title, the root, and
// the unfiled pages (no Master, in no pillar). Pages are listed by sibling order, then title, and
// sections in page order. `setInferMindEnabled(false)`
// turns the demo workspace into one without InferMind, so every Wiki call fails FORBIDDEN as
// InferOps' product gate does.
//
// Wiki proposals (MVP-40): the fixture's drafted proposals, hashed here as InferOps hashes them
// (one canonical document of everything an approval binds), with InferOps' `approveProposal` rules
// exactly: the account's role (`setProposalRole`; Viewer and Member lack `knowledge:publish`),
// a replay for the same principal and hash on a decided proposal, CONFLICT for any other decided
// state or a failed integrity re-hash, STALE for a superseded revision, another hash or other
// sources, the self-decision refusal for the requester or reviser, and a new page's parent. The
// demo account is one principal (`MOCK_PRINCIPAL`). An approval queues one publish job; nothing
// runs it but the test-only `runPublishJobs`, which claims each approved proposal once and
// publishes it as InferOps' job does (an edit keeps the page's id, parent, order, Master role and
// pillars; a new page goes under its parent, filed in its pillar), or ends it stale when the target
// or a cited section moved. `reviseProposal` stands in for a reviewer's revision.
//
// Custom tables: one synthetic table (`src/fixtures/demo-table.json`) with a personal column and a
// relation, read as InferOps' `object.embed` answers: the definition with every column, personal
// ones included, and the rows newest first, each at the table's version. Projection is the
// gatekeeper's job (table.ts), exactly as for the HTTP client. There are no table writes.
//
// Workflow policies: `src/fixtures/demo-workflow.json` holds `workflow.get` answers by project key
// (DEMO's carries a canary in every field the gatekeeper leaves out); any other project reads as
// unconfigured, as InferOps answers. The client parses and the gatekeeper projects them exactly as
// InferOps' own answers (workflow-policy.ts). There are no policy writes.
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
import TABLE_SEED from "./fixtures/demo-table.json";
import MEMBERS_SEED from "./fixtures/demo-members.json";
import WORKFLOW_SEED from "./fixtures/demo-workflow.json";
import {
  InferOpsError, atStage, inferOpsErrorCode, type DispatchRequest, type InferOpsClient,
  type IssueChanges, type NewIssueRequest,
  type ProjectSnapshot, type ProjectSummary, type RepoRecord, type RunRecord, type TableRead,
  type TableReadOptions, type TableRecordSchema, type TableRowRecord, type TableSummary,
  type WikiDocumentHead,
  type WikiDocumentRecord, type WikiPageChanges, type WikiPageWrite, type WikiProposalApproval,
  type WikiProposalRead, type WikiProposalRecord, type WikiProposalState, type WikiSectionRecord,
  type WikiStructureRecord, type WorkspaceMembersRead, PROPOSAL_APPROVE_REFUSED,
} from "./inferops-client";
import type { Issue, Revision, RunResult, RunStatus, WikiProposalSource } from "./types";
import { composeDocumentText, masterStructureText } from "./wiki";
import { readWorkflowPolicyAnswer, workflowPolicyNotFound } from "./workflow-policy";

/** The only InferOps host the mock serves; resource URLs naming another host are refused. */
export const MOCK_HOST = "demo.local";

const DATA_KEY = "data:v1";
const RUNS_KEY = "runs:v1";
const IDEMPOTENCY_PREFIX = "idem:";
// v2 added page bodies, versions, Master roles and pillars; a v1 copy is left unread.
const WIKI_KEY = "wiki:v2";
const NO_INFERMIND_KEY = "wiki:no-infermind";
const PROPOSALS_KEY = "wiki:proposals:v1";
const PROPOSAL_ROLE_KEY = "wiki:proposal-role";
const TABLES_KEY = "tables:v1";
const MEMBERS_KEY = "members:v1";
const WORKFLOW_KEY = "workflow:v1";
const REVOKED_KEY = "revoked";

/** A demo page: its listed fields, its body, version and Master role, and its last write's receipt. */
type MockDocument = WikiDocumentRecord & Omit<WikiDocumentHead, "id" | "slug" | "title"> & {
  lastWriteReceipt?: string;
};

/** A demo pillar: its Master page and the pages filed in it. */
type MockPillar = {
  key: string; title: string; position: number; masterId: string | null;
  members: { documentId: string; source: "intake" | "human" }[];
};

/** The demo Wiki: its pages, their sections and its pillars. */
type MockWiki = { documents: MockDocument[]; sections: WikiSectionRecord[]; pillars: MockPillar[] };

/** The demo account's own InferOps principal (Dana Demo, the owner in demo-members.json). */
export const MOCK_PRINCIPAL = "00000000-0000-4000-8000-0000000000d1";

/** Another person of the demo workspace (Vic Viewer), for revisions made by someone else. */
const MOCK_OTHER_PRINCIPAL = "00000000-0000-4000-8000-0000000000d2";

/** A role of the demo account in its workspace, for InferOps' `knowledge:publish` check. */
export type MockProposalRole = "owner" | "admin" | "member" | "viewer";

/** A demo proposal: InferOps' record plus the principals and grounding it keeps to itself. */
type MockProposal = WikiProposalRecord & {
  requestedBy: string; revisedBy: string | null; decidedBy: string | null;
  sectionRefs: { heading: string; sectionIds: string[] }[];
};

/** The demo proposals, the publish jobs queued (proposal ids, never removed) and what each saw. */
type MockProposals = {
  proposals: MockProposal[]; jobs: string[];
  approvals: Record<string, number>; enqueues: Record<string, number>; publications: Record<string, number>;
};

/** How often one proposal was approved, had its publication queued, and was published. */
export type MockProposalCounts = { approvals: number; enqueues: number; publications: number };

/** InferOps' decided states: an approval of one replays for its approver, else conflicts. */
const DECIDED: readonly WikiProposalState[] = ["approved", "publishing", "published", "stale", "blocked"];

/** JSON with object keys sorted, as InferOps' `stableStringify` orders a canonical document. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${stable(member)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The hash of everything an approval binds (InferOps' `canonicalWikiProposal`, schema 1). */
async function proposalHashOf(p: MockProposal): Promise<string> {
  const canonical = stable({
    schemaVersion: 1, targetDocumentId: p.targetDocumentId, expectedVersion: p.expectedVersion,
    targetSlug: p.targetSlug, parentId: p.parentId, pathwayType: p.pathwayType, title: p.title,
    content: p.content, sources: p.sources.map(s => ({ sectionId: s.sectionId, version: s.version })),
    sectionRefs: p.sectionRefs.map(r => ({ heading: r.heading, sectionIds: r.sectionIds })),
    contradictions: p.contradictions, summary: p.summary,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** A source list as one order-free key. */
function sourcesKey(list: readonly WikiProposalSource[]): string {
  return list.map(s => `${s.sectionId}@${s.version}`).toSorted().join(",");
}

/** Whether two source lists cite the same sections at the same versions, in any order. */
function sameSources(a: readonly WikiProposalSource[], b: readonly WikiProposalSource[]): boolean {
  return a.length === b.length && sourcesKey(a) === sourcesKey(b);
}

/** A proposal as InferOps returns it: its record, without the principals or grounding. */
function proposalView(p: MockProposal): WikiProposalRecord {
  const { requestedBy: _r, revisedBy: _v, decidedBy: _d, sectionRefs: _s, ...record } = p;
  return structuredClone(record);
}

/** The demo tables: definitions with every column, and rows stored without their version. */
export type MockTables = { tables: TableRecordSchema[]; rows: Omit<TableRowRecord, "typeVersion">[] };

/** The one answer for a table or row the demo account cannot read. */
function tableNotFound(): InferOpsError {
  return new InferOpsError("NOT_FOUND", "No such table or row is available to you.");
}

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

/** A demo page as a structure read names it. */
function structurePage({ id, slug, title, parentId }: MockDocument) {
  return { id, slug, title, parentId };
}

/** Orders by title, as InferOps orders siblings and pillar members after their position. */
function byTitle(a: { title: string }, b: { title: string }): number {
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}

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
      const { documents, sections, pillars } = structuredClone(WIKI_SEED) as unknown as MockWiki;
      wiki = { documents, sections, pillars };
      this.ctx.storage.kv.put(WIKI_KEY, wiki);
    }
    return wiki;
  }

  async listDocuments(): Promise<WikiDocumentRecord[]> {
    return this.#wiki().documents
      .toSorted((a, b) => a.siblingOrder - b.siblingOrder || byTitle(a, b))
      .map(({ id, slug, title, parentId, siblingOrder }) => ({ id, slug, title, parentId, siblingOrder }));
  }

  async readDocument(documentId: string): Promise<WikiDocumentHead> {
    const found = this.#wiki().documents.find(d => d.id === documentId);
    if (!found) throw new InferOpsError("NOT_FOUND", "No such page in this Wiki.");
    return {
      id: found.id, slug: found.slug, title: found.title, body: found.body, version: found.version,
      masterRole: found.masterRole,
    };
  }

  async readStructure(): Promise<WikiStructureRecord> {
    const { documents, pillars } = this.#wiki();
    const byId = new Map(documents.map(d => [d.id, d]));
    const filed = new Set<string>();
    const shown = pillars.toSorted((a, b) => a.position - b.position || (a.key < b.key ? -1 : 1)).map(p => {
      const master = p.masterId ? byId.get(p.masterId) : undefined;
      const members = p.members.flatMap(m => {
        const document = byId.get(m.documentId);
        if (!document) return [];
        filed.add(document.id);
        return [{ ...structurePage(document), source: m.source }];
      });
      return {
        key: p.key, title: p.title, position: p.position, master: master ? structurePage(master) : null,
        members: members.toSorted(byTitle),
      };
    });
    const root = documents.find(d => d.masterRole === "root");
    return {
      root: root ? structurePage(root) : null,
      pillars: shown,
      unfiled: documents.filter(d => d.masterRole === null && !filed.has(d.id)).map(structurePage),
    };
  }

  /**
   * InferOps' `document.text` over the demo Wiki: the shared page contract. The demo workspace has
   * no operational inventory and no live widgets, so no coverage block or widget text is added.
   */
  async readDocumentText(documentId: string): Promise<string | null> {
    const head = this.#wiki().documents.find(d => d.id === documentId);
    if (!head) return null;
    const sections = await this.listSections(documentId);
    const structure = head.masterRole ? await this.readStructure() : null;
    return composeDocumentText(head.title, {
      body: head.body, visibleSections: sections.map(s => s.body),
      generated: structure ? masterStructureText(head, structure) : null,
    });
  }

  async updateDocument(documentId: string, changes: WikiPageChanges, expectedVersion: number,
                       idempotencyKey: string): Promise<WikiPageWrite> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    const wiki = this.#wiki();
    const document = wiki.documents.find(d => d.id === documentId);
    if (!document) throw new InferOpsError("NOT_FOUND", "No such page in this Wiki.");
    const receipt = JSON.stringify([idempotencyKey, expectedVersion, "page.edit", changes.body]);
    if (document.version !== expectedVersion) {
      // Only this exact write's own retry, one version on, is replayed; matching text proves nothing.
      if (document.lastWriteReceipt === receipt && document.version === expectedVersion + 1) {
        logger.info("write replayed", { event: "mock.write.replayed", replayed: true });
        return { id: document.id, version: document.version };
      }
      throw new InferOpsError("STALE_REVISION", `The page changed (it is now version ${document.version}).`);
    }
    document.body = changes.body;
    document.version += 1;
    document.lastWriteReceipt = receipt;
    this.ctx.storage.kv.put(WIKI_KEY, wiki);
    return { id: document.id, version: document.version };
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

  /** The demo proposals, seeded and hashed on first use, behind the same gates as the Wiki. */
  async #proposals(): Promise<MockProposals> {
    this.#wiki();
    let store = this.ctx.storage.kv.get<MockProposals>(PROPOSALS_KEY);
    if (!store) {
      const seeded = structuredClone((WIKI_SEED as unknown as { proposals: MockProposal[] }).proposals);
      const proposals: MockProposal[] = [];
      for (const raw of seeded) {
        const p: MockProposal = {
          ...raw, proposalHash: "", approvedHash: null, decidedAt: null, decidedBy: null,
          blockedReason: null, lastError: null, publishedDocumentId: null, publishedVersion: null,
          publishedAt: null,
        };
        proposals.push({ ...p, proposalHash: await proposalHashOf(p) });
      }
      store = { proposals, jobs: [], approvals: {}, enqueues: {}, publications: {} };
      this.ctx.storage.kv.put(PROPOSALS_KEY, store);
    }
    return store;
  }

  async listProposals(state?: WikiProposalState): Promise<WikiProposalRecord[]> {
    return (await this.#proposals()).proposals
      .filter(p => state === undefined || p.state === state)
      .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.revision - a.revision))
      .slice(0, 200)
      .map(proposalView);
  }

  /** One proposal with its freshness now, as InferOps' `getProposalDetail` computes it. */
  async readProposal(proposalId: string): Promise<WikiProposalRead> {
    const found = (await this.#proposals()).proposals.find(p => p.id === proposalId);
    if (!found) throw new InferOpsError("NOT_FOUND", PROPOSAL_APPROVE_REFUSED.notFound);
    const wiki = this.#wiki();
    const sources = found.sources.map(s => ({
      sectionId: s.sectionId, proposedVersion: s.version,
      currentVersion: wiki.sections.find(section => section.id === s.sectionId)?.version ?? null,
    }));
    const targetVersion = found.targetDocumentId === null ? null
      : wiki.documents.find(d => d.id === found.targetDocumentId)?.version ?? null;
    const stale = sources.some(s => s.currentVersion !== s.proposedVersion) ||
      (found.targetDocumentId !== null && targetVersion !== found.expectedVersion);
    return { proposal: proposalView(found), freshness: { targetVersion, sources, stale } };
  }

  /** InferOps' `approveProposal` for the demo account's principal; see the header. */
  async approveProposal(proposalId: string, approval: WikiProposalApproval, idempotencyKey: string):
      Promise<WikiProposalRecord> {
    if (!idempotencyKey) throw new InferOpsError("INVALID_REQUEST", "An idempotency key is required.");
    const store = await this.#proposals();
    const row = store.proposals.find(p => p.id === proposalId);
    if (!row) throw new InferOpsError("NOT_FOUND", PROPOSAL_APPROVE_REFUSED.notFound);
    const role = this.ctx.storage.kv.get<MockProposalRole>(PROPOSAL_ROLE_KEY) ?? "owner";
    // The capability's own permission check runs before the handler, as `knowledge:publish` does.
    if (role !== "owner" && role !== "admin") {
      throw new InferOpsError("FORBIDDEN", PROPOSAL_APPROVE_REFUSED.forbidden);
    }
    if (DECIDED.includes(row.state)) {
      if (row.decidedBy === MOCK_PRINCIPAL && row.approvedHash === approval.proposalHash) {
        logger.info("approval replayed", { event: "mock.write.replayed", replayed: true });
        return proposalView(row);
      }
      throw new InferOpsError("CONFLICT", PROPOSAL_APPROVE_REFUSED.conflict);
    }
    if (row.state === "superseded") throw new InferOpsError("STALE_REVISION", PROPOSAL_APPROVE_REFUSED.stale);
    if (row.state !== "in_review") throw new InferOpsError("CONFLICT", PROPOSAL_APPROVE_REFUSED.conflict);
    if (row.requestedBy === MOCK_PRINCIPAL || row.revisedBy === MOCK_PRINCIPAL) {
      throw new InferOpsError("CONFLICT", PROPOSAL_APPROVE_REFUSED.self);
    }
    if (await proposalHashOf(row) !== row.proposalHash) {
      throw new InferOpsError("CONFLICT", PROPOSAL_APPROVE_REFUSED.conflict);
    }
    if (row.proposalHash !== approval.proposalHash || !sameSources(row.sources, approval.sources)) {
      throw new InferOpsError("STALE_REVISION", PROPOSAL_APPROVE_REFUSED.stale);
    }
    if (row.targetDocumentId === null && row.parentId === null) {
      throw new InferOpsError("INVALID_REQUEST", PROPOSAL_APPROVE_REFUSED.placement);
    }
    // Approve and queue the publication in one step, as InferOps does in one transaction.
    const now = new Date().toISOString();
    Object.assign(row, {
      state: "approved", decidedBy: MOCK_PRINCIPAL, decidedAt: now, approvedHash: row.proposalHash, updatedAt: now,
    });
    store.jobs.push(row.id);
    store.approvals[row.id] = (store.approvals[row.id] ?? 0) + 1;
    store.enqueues[row.id] = (store.enqueues[row.id] ?? 0) + 1;
    this.ctx.storage.kv.put(PROPOSALS_KEY, store);
    return proposalView(row);
  }

  /** Test only: the demo account's role for `knowledge:publish` (owner, the default, and admin hold it). */
  async setProposalRole(role: MockProposalRole): Promise<void> {
    this.ctx.storage.kv.put(PROPOSAL_ROLE_KEY, role);
  }

  /**
   * Test only: a reviewer's revision, as InferOps' `reviseProposal` makes it (of an in_review or
   * approved proposal): the proposal is superseded, and a new revision with new content and a new
   * hash is in review, written by another person or, with `self`, by the demo account.
   */
  async reviseProposal(proposalId: string, by: "other" | "self" = "other"): Promise<WikiProposalRecord> {
    const store = await this.#proposals();
    const row = store.proposals.find(p => p.id === proposalId);
    if (!row) throw new InferOpsError("NOT_FOUND", PROPOSAL_APPROVE_REFUSED.notFound);
    if (row.state !== "in_review" && row.state !== "approved") {
      throw new InferOpsError("CONFLICT", `A ${row.state} proposal cannot be revised.`);
    }
    const now = new Date().toISOString();
    row.state = "superseded";
    row.updatedAt = now;
    const next: MockProposal = {
      ...structuredClone(row), id: crypto.randomUUID(), revision: row.revision + 1, state: "in_review",
      content: `${row.content}\n\n(Revised.)`, revisedBy: by === "self" ? MOCK_PRINCIPAL : MOCK_OTHER_PRINCIPAL,
      decidedBy: null, decidedAt: null, approvedHash: null, createdAt: now, updatedAt: now,
    };
    next.proposalHash = await proposalHashOf(next);
    store.proposals.push(next);
    this.ctx.storage.kv.put(PROPOSALS_KEY, store);
    return proposalView(next);
  }

  /**
   * Test only: run every queued publish job, as InferOps' `knowledge.wiki.publish` job runs (and
   * as a queue that delivers a job at least once may run it again). Each job first claims its
   * proposal, which only an approved proposal passes, so a job runs once. Returns how many it
   * published.
   */
  async runPublishJobs(): Promise<number> {
    const store = await this.#proposals();
    const wiki = this.#wiki();
    let published = 0;
    for (const proposalId of store.jobs) {
      const row = store.proposals.find(p => p.id === proposalId);
      if (!row) continue;
      // The claim: approved -> publishing, once.
      if (row.state !== "approved") continue;
      row.state = "publishing";
      const now = new Date().toISOString();
      const moved = row.sources.some(s => wiki.sections.find(section => section.id === s.sectionId)?.version !== s.version);
      const target = row.targetDocumentId === null ? undefined : wiki.documents.find(d => d.id === row.targetDocumentId);
      if (moved || (row.targetDocumentId !== null && target?.version !== row.expectedVersion)) {
        Object.assign(row, {
          state: "stale", updatedAt: now,
          lastError: moved ? "A cited section changed since the proposal was drafted."
            : "The page changed since the proposal was drafted.",
        });
        continue;
      }
      let document: MockDocument;
      if (target) {
        // The page edit: its id, parent, order, Master role and pillar membership stay.
        target.body = row.content;
        target.version += 1;
        target.lastWriteReceipt = undefined;
        document = target;
      } else {
        document = {
          id: crypto.randomUUID(), slug: row.targetSlug, title: row.title, parentId: row.parentId,
          siblingOrder: wiki.documents.filter(d => d.parentId === row.parentId).length,
          body: row.content, version: 1, masterRole: null,
        };
        wiki.documents.push(document);
        const pillar = row.pathwayType === null ? undefined : wiki.pillars.find(p => p.key === row.pathwayType);
        pillar?.members.push({ documentId: document.id, source: "human" });
      }
      Object.assign(row, {
        state: "published", publishedDocumentId: document.id, publishedVersion: document.version,
        publishedAt: now, updatedAt: now,
      });
      store.publications[row.id] = (store.publications[row.id] ?? 0) + 1;
      published += 1;
    }
    this.ctx.storage.kv.put(WIKI_KEY, wiki);
    this.ctx.storage.kv.put(PROPOSALS_KEY, store);
    return published;
  }

  /**
   * Test only: another in-review proposal shaped like the first fixture proposal (an edit of
   * release-process requested by another person), with `overrides`, hashed as any other.
   */
  async seedProposal(overrides: { title?: string; content?: string; summary?: string }): Promise<WikiProposalRecord> {
    const store = await this.#proposals();
    const now = new Date().toISOString();
    const p: MockProposal = {
      ...structuredClone(store.proposals[0]!), ...overrides, id: crypto.randomUUID(), runId: crypto.randomUUID(),
      revision: 1, state: "in_review", decidedBy: null, decidedAt: null, approvedHash: null, revisedBy: null,
      lastError: null, publishedDocumentId: null, publishedVersion: null, publishedAt: null,
      createdAt: now, updatedAt: now,
    };
    p.proposalHash = await proposalHashOf(p);
    store.proposals.push(p);
    this.ctx.storage.kv.put(PROPOSALS_KEY, store);
    return proposalView(p);
  }

  /** Test only: how often one proposal was approved, queued and published. */
  async proposalCounts(proposalId: string): Promise<MockProposalCounts> {
    const store = await this.#proposals();
    return {
      approvals: store.approvals[proposalId] ?? 0, enqueues: store.enqueues[proposalId] ?? 0,
      publications: store.publications[proposalId] ?? 0,
    };
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

  /** The demo tables, seeded on first use; `tables:v1` is what tests rewrite to change one. */
  #tables(): MockTables {
    this.#assertLive();
    let tables = this.ctx.storage.kv.get<MockTables>(TABLES_KEY);
    if (!tables) {
      tables = structuredClone(TABLE_SEED) as unknown as MockTables;
      this.ctx.storage.kv.put(TABLES_KEY, tables);
    }
    return tables;
  }

  #tableRead(table: TableRecordSchema, rows: MockTables["rows"]): TableRead {
    return { table, rows: rows.map(row => ({ ...row, typeVersion: table.version })) };
  }

  async listTables(): Promise<TableSummary[]> {
    return this.#tables().tables.map(({ id, label }) => ({ id, label }));
  }

  async readTable(tableId: string, options: TableReadOptions): Promise<TableRead> {
    const { tables, rows } = this.#tables();
    const table = tables.find(t => t.id === tableId);
    if (!table) throw tableNotFound();
    const own = rows.filter(r => r.typeId === table.id && (options.relatedTo === undefined ||
      r.links.some(link => link.ref === options.relatedTo)));
    return this.#tableRead(table, own.slice(0, options.limit));
  }

  async readTableRow(recordId: string): Promise<TableRead> {
    const { tables, rows } = this.#tables();
    const row = rows.find(r => r.id === recordId);
    const table = row && tables.find(t => t.id === row.typeId);
    if (!row || !table) throw tableNotFound();
    return this.#tableRead(table, [row]);
  }

  /** The demo workspace's members, seeded on first use; `members:v1` is what tests rewrite. */
  async listWorkspaceMembers(): Promise<WorkspaceMembersRead> {
    this.#assertLive();
    let members = this.ctx.storage.kv.get<WorkspaceMembersRead>(MEMBERS_KEY);
    if (!members) {
      members = structuredClone(MEMBERS_SEED) as WorkspaceMembersRead;
      this.ctx.storage.kv.put(MEMBERS_KEY, members);
    }
    return members;
  }

  /**
   * The demo `workflow.get` answer (`{ head }`) for `projectKey`, as InferOps would send it, and the
   * id of the project the key names: a key without a stored answer reads as unconfigured, as
   * InferOps answers. `workflow:v1` (answers by project key, seeded on first use) is what tests
   * rewrite; the client parses the answer exactly as it parses InferOps' own.
   */
  async readWorkflowPolicy(projectKey: string): Promise<{ projectId: string; body: unknown }> {
    const project = this.#data().projects.find(p => p.project.identifier === projectKey)?.project;
    if (!project) throw workflowPolicyNotFound();
    let answers = this.ctx.storage.kv.get<Record<string, unknown>>(WORKFLOW_KEY);
    if (!answers) {
      answers = structuredClone(WORKFLOW_SEED.projects) as Record<string, unknown>;
      this.ctx.storage.kv.put(WORKFLOW_KEY, answers);
    }
    const body = Object.hasOwn(answers, projectKey) ? answers[projectKey] : {
      head: {
        projectId: project.id, workflow: "content", configured: false, revision: "0", policy: null,
        compiledHash: null, legacyUpgraded: false,
      },
    };
    return { projectId: project.id, body };
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
  // The mock checks and commits a write in one call, so a refusal of one was made before anything
  // changed. The stage is restored here because RPC carries only the message. UNAVAILABLE, which
  // the mock itself never raises, proves nothing, and neither does an error without a code.
  const refused = <T>(write: Promise<T>): Promise<T> =>
    write.catch(error => {
      throw inferOpsErrorCode(error) === "UNAVAILABLE" ? error : atStage(error, "refused");
    });
  return {
    listProjects: () => stub.listProjects(),
    readProject: projectKey => stub.readProject(projectKey),
    readIssue: (projectKey, issueId) => stub.readIssue(projectKey, issueId),
    transition: (projectKey, issueId, toStateId, expectedRevision, idempotencyKey) =>
      refused(stub.transition(projectKey, issueId, toStateId, expectedRevision, idempotencyKey)),
    createIssue: (projectKey, issue, idempotencyKey) =>
      refused(stub.createIssue(projectKey, issue, idempotencyKey)),
    updateIssue: (projectKey, issueId, changes, expectedRevision, idempotencyKey) =>
      refused(stub.updateIssue(projectKey, issueId, changes, expectedRevision, idempotencyKey)),
    hasProject: projectKey => stub.hasProject(projectKey),
    listRepos: () => stub.listRepos(),
    listRuns: (projectKey, issueId) => stub.listRuns(projectKey, issueId),
    readRun: (projectKey, runId) => stub.readRun(projectKey, runId),
    dispatchIssue: (projectKey, issueId, request, idempotencyKey) =>
      refused(stub.dispatchIssue(projectKey, issueId, request, idempotencyKey)),
    cancelRun: (projectKey, runId, idempotencyKey) =>
      refused(stub.cancelRun(projectKey, runId, idempotencyKey)),
    listDocuments: () => stub.listDocuments(),
    readDocument: documentId => stub.readDocument(documentId),
    readStructure: () => stub.readStructure(),
    readDocumentText: documentId => stub.readDocumentText(documentId),
    updateDocument: (documentId, changes, expectedVersion, idempotencyKey) =>
      refused(stub.updateDocument(documentId, changes, expectedVersion, idempotencyKey)),
    listSections: documentId => stub.listSections(documentId),
    readSection: sectionId => stub.readSection(sectionId),
    updateSection: (sectionId, body, idempotencyKey) =>
      refused(stub.updateSection(sectionId, body, idempotencyKey)),
    listProposals: state => stub.listProposals(state),
    readProposal: proposalId => stub.readProposal(proposalId),
    approveProposal: (proposalId, approval, idempotencyKey) =>
      refused(stub.approveProposal(proposalId, approval, idempotencyKey)),
    listTables: () => stub.listTables(),
    readTable: (host, tableId, options) => host === account.host
      ? stub.readTable(tableId, options) : Promise.reject(tableNotFound()),
    readTableRow: (host, recordId) => host === account.host
      ? stub.readTableRow(recordId) : Promise.reject(tableNotFound()),
    listWorkspaceMembers: () => stub.listWorkspaceMembers(),
    readWorkflowPolicy: async projectKey => {
      const { projectId, body } = await stub.readWorkflowPolicy(projectKey);
      return readWorkflowPolicyAnswer(body, projectId);
    },
    forget: () => stub.forget(),
  };
}

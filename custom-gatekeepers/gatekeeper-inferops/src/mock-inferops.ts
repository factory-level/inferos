// MOCK InferOps data source: the only module that holds project data. It is the default data source
// (the demo host, and every test), beside the HTTP client in http-inferops.ts, and enforces the
// rules the gatekeeper relies on: project scope, state membership, workflow compatibility,
// expected-revision checks and idempotent replay. It advances a revision by one per move; InferOps
// does not, and nothing may depend on it.
//
// One `MockInferOps` Durable Object per (host, account) holds a private copy of the seed fixture,
// so each auto-provisioned account starts from the same demo board and its moves stay its own.

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/observability/logger";
import SEED from "./fixtures/demo-board.json";
import {
  InferOpsError, type InferOpsClient, type ProjectSnapshot, type ProjectSummary,
} from "./inferops-client";
import type { Issue, Revision } from "./types";

/** The only InferOps host the mock serves; resource URLs naming another host are refused. */
export const MOCK_HOST = "demo.local";

const DATA_KEY = "data:v1";
const IDEMPOTENCY_PREFIX = "idem:";

const logger = createLogger<{ vendorId: string; projectKey: string; replayed: boolean }>({
  component: "gatekeeper.inferops", vendorId: "inferops",
});

type MockData = { projects: ProjectSnapshot[] };

/** What one idempotency key was used for, and the issue it produced. */
type IdempotencyRecord = {
  operation: { projectKey: string; issueId: string; toStateId: string; expectedRevision: Revision };
  result: Issue;
};

function sameOperation(a: IdempotencyRecord["operation"], b: IdempotencyRecord["operation"]) {
  return a.projectKey === b.projectKey && a.issueId === b.issueId &&
    a.toStateId === b.toStateId && a.expectedRevision === b.expectedRevision;
}

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
    const operation = { projectKey, issueId, toStateId, expectedRevision };

    // Replay first: a retried apply must succeed even though its own first attempt already moved
    // the revision on.
    const previous = this.ctx.storage.kv.get<IdempotencyRecord>(IDEMPOTENCY_PREFIX + idempotencyKey);
    if (previous) {
      if (!sameOperation(previous.operation, operation)) {
        throw new InferOpsError(
          "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different change.");
      }
      logger.info("transition replayed", { event: "mock.transition.replayed", projectKey, replayed: true });
      return previous.result;
    }

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
    issue.revision = (BigInt(issue.revision) + 1n).toString();
    this.ctx.storage.kv.put(DATA_KEY, data);
    this.ctx.storage.kv.put<IdempotencyRecord>(
      IDEMPOTENCY_PREFIX + idempotencyKey, { operation, result: issue });
    logger.info("transition applied", { event: "mock.transition.applied", projectKey, replayed: false });
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
    hasProject: projectKey => stub.hasProject(projectKey),
    forget: () => stub.forget(),
  };
}

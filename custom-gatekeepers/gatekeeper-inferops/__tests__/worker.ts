// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object that plays the overseer: it instantiates the
// gatekeeper as a facet with props, hands it an approval queue that records what it is told, and
// applies or rejects the actions it collected.

import type { TemporaryCanvasInput } from "@gadgets/workshop-shared/temporary-canvas";
import type { ActionResult } from "@gadgets/workshop-shared/action-outcome";
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionApplied, ActionApplyFailure, ActionFailureKind, ActionDescription, ApprovedRunOutcome, ApprovedPersonalWorkflow, ApprovedTemporaryCanvas, ApprovedWorkflowRun, ApprovedDelegate, ConnectHandoff, GatekeeperUser, GatekeeperUserVerifier, GitCache,
  GitObjectType, GitOid, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { dotBindingOver } from "../src/inferops.js";
import { openHttpInferOpsClient } from "../src/http-inferops.js";
import { OTHER_COMPANY } from "../src/deployment-company.js";
import {
  InferOpsAccountGatekeeper, InferOpsCredentials as BaseInferOpsCredentials, InferOpsDispatchGatekeeper, InferOpsDotGatekeeper, InferOpsMembersGatekeeper,
  InferOpsProjectGatekeeper, InferOpsTableGatekeeper, InferOpsWikiGatekeeper, InferOpsWorkflowPolicyGatekeeper,
  MockInferOps as BaseMockInferOps,
} from "../src/inferops.js";
import type { RejectionVerdict } from "@gadgets/gatekeeper-kit/credentials";
import {
  InferOpsError, type IssueChanges, type NewIssueRequest, type WikiProposalApproval, type WikiProposalRecord,
  type TableRead, type TableReadOptions, type WorkspaceMembersRead,
} from "../src/inferops-client.js";
import type { MockTables } from "../src/mock-inferops.js";
import type { Issue, Revision } from "../src/types.js";
import type {
  InferOpsDotSession, WriteStatus,
  InferOpsAccountSession, InferOpsDispatchSession, InferOpsMembersSession, InferOpsProjectSession, InferOpsTableSession,
  InferOpsWikiSession, InferOpsWorkflowPolicySession,
} from "../src/types.js";

export { default } from "../src/inferops.js";
export * from "../src/inferops.js";
// Vitest's ctx.exports analyzer does not follow `export *`, so the classes reached through
// ctx.exports are named explicitly.
export {
  GatekeeperVendor, InferLabLogin, InferOpsAccount, InferOpsSystemCredentials, InferOpsAccountGatekeeper, InferOpsDispatchGatekeeper, InferOpsDotGatekeeper, InferOpsMembersGatekeeper,
  InferOpsProjectGatekeeper, InferOpsTableGatekeeper, InferOpsVerifier, InferOpsWikiGatekeeper,
  InferOpsWorkflowPolicyGatekeeper,
} from "../src/inferops.js";

/**
 * A fault the next issue write or proposal approval meets: refused before commit, or committed with
 * its reply lost.
 */
export type WriteFault = "unavailable" | "lost";

const FAULT_KEY = "test:fault";

/**
 * The production mock plus one-shot provider faults on issue writes. Exported under the production
 * name, so `ctx.exports.MockInferOps` -- what every binding's client opens -- is this class.
 */
export class MockInferOps extends BaseMockInferOps {
  /** Replaces this account's demo tables, to change one behind the gatekeeper's back. */
  async setTables(tables: MockTables): Promise<void> {
    this.ctx.storage.kv.put("tables:v1", tables);
  }

  /** Replaces this account's demo member list, to change it behind the gatekeeper's back. */
  async setMembers(members: WorkspaceMembersRead): Promise<void> {
    this.ctx.storage.kv.put("members:v1", members);
  }

  /**
   * Replaces this account's demo `workflow.get` answers, by project key, to change one behind the
   * gatekeeper's back (a key without one reads as unconfigured).
   */
  async setWorkflowAnswers(answers: Record<string, unknown>): Promise<void> {
    this.ctx.storage.kv.put("workflow:v1", answers);
  }

  /** Counts every read of a table's rows, for asserting a refusal read none. */
  override async readTable(tableId: string, options: TableReadOptions): Promise<TableRead> {
    this.ctx.storage.kv.put("test:table-reads", (this.ctx.storage.kv.get<number>("test:table-reads") ?? 0) + 1);
    return super.readTable(tableId, options);
  }

  /** How many times a table's rows were read. */
  async tableReads(): Promise<number> {
    return this.ctx.storage.kv.get<number>("test:table-reads") ?? 0;
  }

  /** This account's demo tables as stored (seeded by the first table read). */
  async getTables(): Promise<MockTables | undefined> {
    return this.ctx.storage.kv.get<MockTables>("tables:v1");
  }

  /** Arms `fault` for the next transition, create or update. */
  async failNextWrite(fault: WriteFault): Promise<void> {
    this.ctx.storage.kv.put(FAULT_KEY, fault);
  }

  async #faulted<T>(write: () => Promise<T>): Promise<T> {
    const fault = this.ctx.storage.kv.get<WriteFault>(FAULT_KEY);
    this.ctx.storage.kv.delete(FAULT_KEY);
    if (fault === "unavailable") throw new InferOpsError("UNAVAILABLE", "InferOps answered 503.");
    const result = await write();
    if (fault === "lost") throw new InferOpsError("UNAVAILABLE", "The InferOps response was lost.");
    return result;
  }

  override transition(projectKey: string, issueId: string, toStateId: string,
                      expectedRevision: Revision, idempotencyKey: string): Promise<Issue> {
    return this.#faulted(() =>
      super.transition(projectKey, issueId, toStateId, expectedRevision, idempotencyKey));
  }

  override createIssue(projectKey: string, request: NewIssueRequest, idempotencyKey: string):
      Promise<Issue> {
    return this.#faulted(() => super.createIssue(projectKey, request, idempotencyKey));
  }

  override updateIssue(projectKey: string, issueId: string, changes: IssueChanges,
                       expectedRevision: Revision, idempotencyKey: string): Promise<Issue> {
    return this.#faulted(() =>
      super.updateIssue(projectKey, issueId, changes, expectedRevision, idempotencyKey));
  }

  /** Every approval request that reached the mock, faulted or not, in order. */
  async approveRequests(): Promise<Array<{ proposalId: string; approval: WikiProposalApproval; key: string }>> {
    return this.ctx.storage.kv.get(APPROVE_LOG_KEY) ?? [];
  }

  override approveProposal(proposalId: string, approval: WikiProposalApproval, idempotencyKey: string):
      Promise<WikiProposalRecord> {
    const log = this.ctx.storage.kv.get<unknown[]>(APPROVE_LOG_KEY) ?? [];
    this.ctx.storage.kv.put(APPROVE_LOG_KEY, [...log, { proposalId, approval, key: idempotencyKey }]);
    return this.#faulted(() => super.approveProposal(proposalId, approval, idempotencyKey));
  }
}

const APPROVE_LOG_KEY = "test:approveRequests";

const REPORT_FAULT_KEY = "test:failNextReport";
/** What the failed adjudication RPC's error carries, in its message and its stack. */
export const REPORT_SENTINEL = "PRIVATE_REPORT_SENTINEL";

/**
 * The production credentials object plus a one-shot failure of the rejection-adjudication RPC, as
 * a transport fault would fail it. Exported under the production name, so every account's
 * `ctx.exports.InferOpsCredentials` is this class.
 */
export class InferOpsCredentials extends BaseInferOpsCredentials {
  /** Makes the next `reportCredentialsRejected` throw instead of adjudicating. */
  async failNextReport(): Promise<void> {
    this.ctx.storage.kv.put(REPORT_FAULT_KEY, true);
  }

  override async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    if (this.ctx.storage.kv.get<boolean>(REPORT_FAULT_KEY)) {
      this.ctx.storage.kv.delete(REPORT_FAULT_KEY);
      const error = new Error(`Durable Object reset ${REPORT_SENTINEL}`);
      error.stack = `Error: ${REPORT_SENTINEL}\n    at ${REPORT_SENTINEL} (credentials.js:1:1)`;
      throw error;
    }
    return super.reportCredentialsRejected(identity);
  }
}

/**
 * The production gatekeeper plus one test-only method, so a test can write a stored action record
 * the way an older version (or a corrupted store) left it.
 */
export class TestProjectGatekeeper extends InferOpsProjectGatekeeper {
  async putRaw(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }
}

/** The production dispatch gatekeeper plus raw storage access, as `TestProjectGatekeeper`. */
export class TestDispatchGatekeeper extends InferOpsDispatchGatekeeper {
  async putRaw(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }
}

/** The production Wiki gatekeeper plus raw storage access, as `TestProjectGatekeeper`. */
export class TestWikiGatekeeper extends InferOpsWikiGatekeeper {
  async putRaw(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }
}

/** The production account gatekeeper plus raw storage access, as `TestProjectGatekeeper`. */
export class TestAccountGatekeeper extends InferOpsAccountGatekeeper {
  async putRaw(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }

  /** Every storage key under `prefix`. */
  async rawKeys(prefix: string): Promise<string[]> {
    return Array.from(this.ctx.storage.kv.list({ prefix }), ([key]) => key);
  }
}

/** The props the Workshop bakes into one account binding. */
export type AccountBindingProps = { accountId: string; tenant: string; connected?: boolean };

/** The props the Workshop bakes into one custom-table binding. */
export type TableProps = {
  accountId: string; host: string; tableId: string; connected?: boolean; workspaceId?: string;
};

/** The props the Workshop bakes into one workspace-members binding. */
export type MembersProps = { accountId: string; host: string; connected?: boolean; workspaceId?: string };

/** The props the Workshop bakes into one workflow-policy binding. */
export type WorkflowPolicyProps = {
  accountId: string; host: string; projectKey: string; connected?: boolean; workspaceId?: string;
};

/** The props the Workshop bakes into one Wiki binding. */
export type WikiProps = { accountId: string; host: string; connected?: boolean; workspaceId?: string };

/** The props the Workshop bakes into one project-board binding. */
export type BindingProps = {
  accountId: string; host: string; projectKey: string; connected?: boolean; workspaceId?: string;
};

/** What the recording approval queue was told, in order. */
export type QueueLog = {
  observations: string[];
  /** Each observation's description, parallel to `observations`. */
  observationTexts: string[];
  /** Each observation's collaborator exclusions, parallel to `observations`. */
  excluded: string[][];
  actions: Array<{
    id: number; title: string; description: string; implementsRevert: boolean;
    /** The run the action declared to the kernel (FAC-120), if any. */
    workflowRun?: { reference: string };
    /** The temporary canvas the action declared to the kernel (FAC-137), if any. */
    temporaryCanvas?: TemporaryCanvasInput;
    personalWorkflow?: { title: string; steps: { reference: string; input: { issueId: string; toStateId: string } }[] };
    personalWorkflowRun?: { reference: string; reportOutcome?: boolean };
    delegate?: ActionDescription["delegate"];
    /** Each field's label and shown value. */
    fields: Record<string, string>;
    /** Each list field's label and shown items. */
    lists: Record<string, string[]>;
    /** Every field's label, in the order shown. */
    labels: string[];
    /** The action kind's tag, when the action declares one. */
    kind?: string;
    /** Whether the description says nothing was dropped (`descriptionIsComplete`). */
    complete: boolean;
    /** The labels of fields shown truncated or omitted. */
    truncated: string[];
  }>;
};

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly log: QueueLog) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.observations.push(description.title);
    this.log.observationTexts.push(description.description ?? "");
    this.log.excluded.push([...(description.excludeObservers ?? [])]);
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    const fields: Record<string, string> = {};
    const lists: Record<string, string[]> = {};
    for (const field of description.fields ?? []) {
      if ("value" in field && typeof field.value === "string") fields[field.label] = field.value;
      if (field.kind === "list") lists[field.label] = [...field.items];
    }
    this.log.actions.push({
      id, title: description.title, description: description.description,
      implementsRevert: description.implementsRevert ?? false, fields, lists,
      labels: (description.fields ?? []).map(field => field.label),
      ...(description.actionKind ? { kind: description.actionKind.tag } : {}),
      ...(description.workflowRun ? { workflowRun: description.workflowRun } : {}),
      ...(description.temporaryCanvas ? { temporaryCanvas: description.temporaryCanvas } : {}),
      ...(description.personalWorkflow ? { personalWorkflow: description.personalWorkflow } : {}),
      ...(description.personalWorkflowRun ? { personalWorkflowRun: description.personalWorkflowRun } : {}),
      ...(description.delegate ? { delegate: description.delegate } : {}),
      complete: description.descriptionIsComplete === true,
      truncated: (description.fields ?? []).filter(field => "truncated" in field && field.truncated !== undefined)
        .map(field => field.label),
    });
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("not implemented");
  }
}

/** Stands in for the git cache the overseer passes to `applyAction()`; never touched. */
class TestGitCache extends RpcTarget implements GitCache {
  async get(_id: GitOid): Promise<{ type: GitObjectType; content: Uint8Array } | null> {
    throw new Error("not implemented");
  }
  async has(_id: GitOid): Promise<boolean> { throw new Error("not implemented"); }
  async stat(_id: GitOid): Promise<{ type: GitObjectType; size: number } | null> {
    throw new Error("not implemented");
  }
  async put(_type: GitObjectType, _content: Uint8Array): Promise<GitOid> {
    throw new Error("not implemented");
  }
  async advertiseCommit(_commitId: GitOid): Promise<void> { throw new Error("not implemented"); }
  async buildPack(): Promise<ReadableStream<Uint8Array>> { throw new Error("not implemented"); }
  async consumePack(_pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    throw new Error("not implemented");
  }
  async isAncestor(_ancestor: GitOid, _descendant: GitOid): Promise<boolean> {
    throw new Error("not implemented");
  }
}

/**
 * Stands in for another user's account during an account binding's admission and forward checks:
 * it reaches exactly the listed project keys and Wiki hosts.
 */
export class TestScopedVerifier extends WorkerEntrypoint<Cloudflare.Env, ScopedAccess> {
  async hasProjectAccess(_host: string, projectKey: string): Promise<boolean> {
    return this.ctx.props.projects.includes(projectKey);
  }

  async hasWikiAccess(host: string): Promise<boolean> {
    return this.ctx.props.wikis.includes(host);
  }
}

/** The boards (by key) and Wikis (by host) a `TestScopedVerifier` reaches. */
export type ScopedAccess = { projects: string[]; wikis: string[] };

/** Stands in for another user's account during an observer admission check. */
class TestVerifier extends RpcTarget {
  constructor(private readonly hasAccess: boolean) {
    super();
  }

  async hasProjectAccess(): Promise<boolean> {
    return this.hasAccess;
  }

  async hasWikiAccess(): Promise<boolean> {
    return this.hasAccess;
  }
}

/** The emails sign-in and connect flows reported to each `TestConnectCallback`, by label. */
export const signIns: Array<{ label: string; email: string | null }> = [];
/** The principal each sign-in's account names (ADR 0019), by label. */
export const signInSubjects: Array<{ label: string; subject: { issuer: string; subject: string } | null }> = [];
/** The stage ids reconnects reported, by label. */
export const reconnects: Array<{ label: string; stageId: string }> = [];
/** The labels whose credentials the gatekeeper reported expired, in order. */
export const expired: string[] = [];

/** The props of one account, as the Workshop's stub for it carries them. */
export type AccountProps = { accountId: string; email?: string; connected?: boolean };

/** Stands in for the Workshop's callback: records the account's email and returns a handoff. */
export class TestConnectCallback extends WorkerEntrypoint<Cloudflare.Env, { label: string }> {
  async complete(user: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    signIns.push({ label: this.ctx.props.label, email: await user.getAuthenticatedEmail() });
    const subject = await (user as unknown as Required<Pick<GatekeeperUser, "getAuthenticatedSubject">>).getAuthenticatedSubject();
    signInSubjects.push({ label: this.ctx.props.label, subject: subject && { issuer: subject.issuer, subject: subject.subject } });
    return { targetOrigin: "http://localhost:3000", ticket: `ticket-${this.ctx.props.label}` };
  }

  async reconnectComplete(stageId: string): Promise<ConnectHandoff> {
    reconnects.push({ label: this.ctx.props.label, stageId });
    return { targetOrigin: "http://localhost:3000", ticket: `reticket-${this.ctx.props.label}` };
  }

  async credentialsExpired(): Promise<void> {
    expired.push(this.ctx.props.label);
  }

  async credentialsRestored(): Promise<void> {}
}

/** The test worker's own entrypoints, as `ctx.exports` exposes them. */
export type SignInExports = {
  TestConnectCallback(options: { props: { label: string } }): Fetcher<TestConnectCallback>;
  GatekeeperVendor(options: object): Fetcher<import("../src/inferops.js").GatekeeperVendor>;
};

type TestExports = {
  TestAccountGatekeeper(options: { props: AccountBindingProps }): DurableObjectClass<TestAccountGatekeeper>;
  TestProjectGatekeeper(options: { props: BindingProps }):
    DurableObjectClass<TestProjectGatekeeper>;
  InferOpsAccount(options: { props: AccountProps }): Fetcher<GatekeeperUser>;
  TestDispatchGatekeeper(options: { props: BindingProps }): DurableObjectClass<TestDispatchGatekeeper>;
  TestWikiGatekeeper(options: { props: WikiProps }): DurableObjectClass<TestWikiGatekeeper>;
  InferOpsTableGatekeeper(options: { props: TableProps }): DurableObjectClass<InferOpsTableGatekeeper>;
  InferOpsMembersGatekeeper(options: { props: MembersProps }): DurableObjectClass<InferOpsMembersGatekeeper>;
  InferOpsDotGatekeeper(options: { props: DotProps }): DurableObjectClass<InferOpsDotGatekeeper>;
  InferOpsWorkflowPolicyGatekeeper(options: { props: WorkflowPolicyProps }):
    DurableObjectClass<InferOpsWorkflowPolicyGatekeeper>;
};

/** The project configurator's capability, as the picker iframe receives it. */
type ConfiguratorRpc = {
  defaultHost(): Promise<string | null>;
  listWorkspaces(): Promise<Array<{ value: string; title: string }>>;
  listProjects(query: string, host: string): Promise<Array<{ value: string }>>;
};

/** The failure an `applyAction` answer reports, if it reports one. */
const failureOf = (outcome: void | { failed: ActionApplyFailure } | ActionApplied) =>
  outcome && "failed" in outcome ? outcome.failed : undefined;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- A fake InferOps Dot (FAC-133), for the Dot facet's session, relay and apply over the real
// HTTP client. It writes the run stream exactly as InferOps' `streamAguiEvents` does: one
// `data: <json>\n\n` frame per event and `: ping\n\n` heartbeats.

/** What the fake Dot answers: the run's frames (or a refusal), and how its proposal routes answer. */
export type DotScript = {
  /** The run stream's raw frames, each written as given, in order; or a refusal before any stream. */
  run: { frames: string[] } | { status: number; code: string };
  /** The proposals `chatbot.proposal_list` and `conversation_get` answer. */
  proposals: Record<string, unknown>[];
  /** How a confirm answers: the proposal confirmed with `outcome`, or a refusal. */
  confirm: { outcome: unknown } | { status: number; code: string; settlesAs?: string };
  /** How a decline answers: declined (the default), or a refusal, settling the proposal as `settlesAs`. */
  decline?: { status: number; code: string; settlesAs?: string };
  /** How recording a run outcome answers (FAC-134): recorded (the default), or a refusal. */
  runOutcome?: { status: number; code: string };
  /**
   * FAC-135: what a confirm or decline answers as `resumed`, the proposing run it resumed; absent,
   * the answer has no `resumed` (an InferOps from before FAC-135).
   */
  resumed?: { runId: string; status: string } | null;
  /** FAC-135: the run status InferOps holds on a proposal once it is decided, confirmed or refused. */
  runStatusAfter?: string;
  /** FAC-135: how `chatbot.proposal_list` answers: listed (the default), or a refusal (a dead sign-in). */
  list?: { status: number; code: string };
  /**
   * FAC-135: the person's connection belongs to another company: the confirm is refused before it is
   * sent, as the account client restates the credential's refusal (stage `unsent`).
   */
  otherCompany?: boolean;
  /**
   * FAC-135: InferOps makes this many confirms (the first ones) but their answers are lost on the way
   * back (a timeout); a later confirm under the same key answers with what it stored.
   */
  confirmLost?: number;
  /** FAC-135: a confirm answers 200 with the proposal stored as this status (a replay of a decided one). */
  replayAs?: string;
  /** FAC-135 (r1 on #493): `chatbot.proposal_list` answers only after this many ms (a slow InferOps). */
  listDelayMs?: number;
  /** FAC-135: the session start's staging deadline, in ms (the facet's own by default). */
  sweepDeadlineMs?: number;
};

/** A Dot binding's props, as the vendor mints them. */
export type DotProps = { accountId: string; connected: boolean; host: string; workspaceId: string };

/** One request the fake Dot took. */
export type DotCall = { method: string; path: string; body: string | null; key: string | null };

const DOT_CONVERSATION = "70000000-0000-4000-8000-000000000001";
const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
export const DOT_FRAMES = { sse, ping: ": ping\n\n" };

/** InferOps' error envelope, with detail text a caller must never be shown. */
const refuse = (status: number, code: string) =>
  Response.json({ success: false, error: { code, message: `InferOps detail for ${code}` } }, { status });

class FakeDot {
  calls: DotCall[] = [];
  constructor(public script: DotScript) {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, "");
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    this.calls.push({ method, path, body, key: headers.get("x-idempotency-key") });
    const base = `/chatbot/conversations/${DOT_CONVERSATION}`;
    if (method === "POST" && path === "/chatbot/conversations") return Response.json({ id: DOT_CONVERSATION, title: "New conversation" });
    if (method === "GET" && path === base) {
      return Response.json({
        id: DOT_CONVERSATION, title: "New conversation", panel: {}, updatedAt: "2026-11-10T12:00:00.000Z",
        messages: [], nextCursor: null, activeRunId: null, proposals: this.script.proposals,
      });
    }
    if (method === "POST" && path === `${base}/runs`) {
      const run = this.script.run;
      if ("status" in run) return refuse(run.status, run.code);
      const encoder = new TextEncoder();
      const frames = run.frames;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && /\/runs\/[0-9a-f-]+\/cancel$/.test(path)) return Response.json({ ok: true });
    if (method === "GET" && /^\/chatbot\/conversations\/[0-9a-f-]+\/proposals$/.test(path)) {
      if (this.script.listDelayMs) await new Promise(resolve => setTimeout(resolve, this.script.listDelayMs));
      if (this.script.list) return refuse(this.script.list.status, this.script.list.code);
      if (path !== `${base}/proposals`) return refuse(404, "CONVERSATION_NOT_FOUND");
      return Response.json({ proposals: this.script.proposals });
    }
    const ran = /\/proposals\/([0-9a-f-]+)\/run-outcome$/.exec(path);
    if (method === "POST" && ran) {
      const proposal = this.script.proposals.find(p => p.id === ran[1]);
      if (!proposal) return refuse(404, "PROPOSAL_NOT_FOUND");
      if (this.script.runOutcome) return refuse(this.script.runOutcome.status, this.script.runOutcome.code);
      return Response.json({ proposal });
    }
    const decided = /\/proposals\/([0-9a-f-]+)\/(confirm|decline)$/.exec(path);
    if (method === "POST" && decided) {
      const proposal = this.script.proposals.find(p => p.id === decided[1]);
      if (!proposal) return refuse(404, "PROPOSAL_NOT_FOUND");
      // InferOps resumes the proposing run with the decision, confirmed, declined or refused (FAC-135).
      if (this.script.runStatusAfter !== undefined) Object.assign(proposal, { runStatus: this.script.runStatusAfter });
      const answer = (body: { proposal: unknown }) =>
        Response.json(this.script.resumed === undefined ? body : { ...body, resumed: this.script.resumed });
      if (decided[2] === "decline") {
        const decline = this.script.decline;
        if (decline) {
          if (decline.settlesAs) Object.assign(proposal, { status: decline.settlesAs, decidedAt: "2026-11-10T12:01:00.000Z" });
          return refuse(decline.status, decline.code);
        }
        Object.assign(proposal, { status: "declined", decidedAt: "2026-11-10T12:01:00.000Z" });
        return answer({ proposal });
      }
      const confirm = this.script.confirm;
      if ("status" in confirm) {
        if (confirm.settlesAs) Object.assign(proposal, { status: confirm.settlesAs, decidedAt: "2026-11-10T12:01:00.000Z" });
        return refuse(confirm.status, confirm.code);
      }
      if (this.script.replayAs) {
        Object.assign(proposal, { status: this.script.replayAs, decidedAt: "2026-11-10T12:01:00.000Z" });
        return answer({ proposal });
      }
      Object.assign(proposal, { status: "confirmed", outcome: confirm.outcome, decidedAt: "2026-11-10T12:01:00.000Z" });
      if (this.script.confirmLost) {
        this.script.confirmLost--;
        throw new TypeError("The answer was lost on the way back.");
      }
      return answer({ proposal });
    }
    return refuse(404, "NOT_FOUND");
  };
}

/** A write receipt as the overseer hands one back: its status, read when asked. */
class TestReceipt extends RpcTarget {
  constructor(readonly actionId: string) {
    super();
  }
  async status(): Promise<WriteStatus> {
    return { outcome: "waiting" };
  }
}

/** The approval queue for a Dot binding: records as the others do, and returns each write's receipt. */
class TestDotQueue extends TestApprovalQueue {
  override async submitAction(id: number, description: ActionDescription): Promise<void> {
    await super.submitAction(id, description);
    return new TestReceipt(String(id)) as never;
  }
}

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #log: QueueLog = { observations: [], observationTexts: [], excluded: [], actions: [] };
  // Classes the accounts minted, by binding name: a facet is re-initialized from its class on
  // every `facets.get`.
  #minted = new Map<string, DurableObjectClass<InferOpsProjectGatekeeper>>();

  #gatekeeper(props: BindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TestProjectGatekeeper>(
      `${props.accountId}/${props.projectKey}`,
      () => ({ class: exports.TestProjectGatekeeper({ props }) }));
  }

  // --- Driving an account the Workshop holds by its props. Stubs cannot leave a Durable Object's
  // context, so every account operation runs in here and hands back plain data or a session.

  #account(props: AccountProps): Fetcher<GatekeeperUser> {
    return (this.ctx.exports as unknown as TestExports).InferOpsAccount({ props });
  }

  async describeAccount(props: AccountProps) {
    return this.#account(props).describe();
  }

  /** The account's answer to the Workshop's shared-configuration question, or its failure message. */
  async holdsSharedConfiguration(props: AccountProps, action: "build" | "publish")
      : Promise<{ holds: boolean; scope: string | null } | string> {
    const account = this.#account(props) as unknown as
      Required<Pick<GatekeeperUser, "holdsSharedConfiguration">>;
    try {
      return { ...await account.holdsSharedConfiguration(action) };
    } catch (error) {
      return String(error instanceof Error ? error.message : error);
    }
  }

  /** The account's answer to the Workshop's workflow:invoke question (FAC-102), or its failure message. */
  async holdsWorkflowInvoke(props: AccountProps, resourceUrl: string): Promise<{ holds: boolean; scope: string | null } | string> {
    const account = this.#account(props) as unknown as Required<Pick<GatekeeperUser, "holdsWorkflowInvoke">>;
    try {
      return { ...await account.holdsWorkflowInvoke(resourceUrl) };
    } catch (error) {
      return String(error instanceof Error ? error.message : error);
    }
  }

  /** The company the account says its person works in (FAC-88), or its failure message as `{ failed }`. */
  async presentationCompany(props: AccountProps): Promise<string | null | { failed: string }> {
    const account = this.#account(props) as unknown as Required<Pick<GatekeeperUser, "presentationCompany">>;
    try {
      return await account.presentationCompany();
    } catch (error) {
      return { failed: String(error instanceof Error ? error.message : error) };
    }
  }

  /** The resource URL patterns the account offers now. */
  async supportedPatterns(props: AccountProps): Promise<string[]> {
    return (await this.#account(props).getSupportedResources()).map(r => r.urlPattern);
  }

  /** The resource kinds the account offers now, whole: pattern, title and Operate exclusion. */
  async supportedResources(props: AccountProps) {
    return (await this.#account(props).getSupportedResources()).map(r => ({ ...r }));
  }

  /** The resource pattern `getGatekeeperClassFor` binds `url` as, or its failure message. */
  async boundResourcePattern(props: AccountProps, url: string): Promise<string> {
    try {
      return (await this.#account(props).getGatekeeperClassFor(url)).resource.urlPattern;
    } catch (error) {
      return `refused: ${messageOf(error)}`;
    }
  }

  /** Whether the account starts a configurator for `pattern`; the failure message, or null. */
  async configuratorFor(props: AccountProps, pattern: string): Promise<string | null> {
    try {
      await this.#account(props).startResourceConfigurator(pattern);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async authenticatedEmail(props: AccountProps): Promise<string | null> {
    return this.#account(props).getAuthenticatedEmail();
  }

  /** The principal an account names (ADR 0019), as plain data. */
  async authenticatedSubject(props: AccountProps): Promise<{ issuer: string; subject: string } | null> {
    const found = await (this.#account(props) as unknown as Required<Pick<GatekeeperUser, "getAuthenticatedSubject">>)
      .getAuthenticatedSubject();
    return found && { issuer: found.issuer, subject: found.subject };
  }

  async revokeAccount(props: AccountProps): Promise<void> {
    await this.#account(props).revoke();
  }

  async reconnectAccount(props: AccountProps): Promise<string> {
    return (await this.#account(props).reconnect()).url;
  }

  /** Commits a reconnect; returns the failure message, or null on success. */
  async commitReconnect(props: AccountProps, stageId: string): Promise<string | null> {
    try {
      await this.#account(props).commitReconnect(stageId);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Whether the account's own `getGatekeeperClassFor` reports `url` as mock data. */
  async mockOf(props: AccountProps, url: string): Promise<boolean> {
    return (await this.#account(props).getGatekeeperClassFor(url)).mock === true;
  }

  // --- System credentials (FAC-102): the vendor's kernel-only methods, as the Workshop calls them.

  #vendor() {
    return (this.ctx.exports as unknown as SignInExports).GatekeeperVendor({}) as unknown as
        Required<Pick<import("../src/inferops.js").GatekeeperVendor,
          "provisionSystemCredential" | "forgetSystemCredential" | "getSystemGatekeeperClass">>;
  }

  /** Provisions `key` for `credentialRef` and board `url`; the failure message, or null. */
  async provisionSystem(credentialRef: string, url: string, key: string): Promise<string | null> {
    try {
      await this.#vendor().provisionSystemCredential(credentialRef, { resourceUrl: url }, key);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Forgets the key stored for `credentialRef`. */
  async forgetSystem(credentialRef: string): Promise<void> {
    await this.#vendor().forgetSystemCredential(credentialRef);
  }

  /** Binds `url` through the vendor's system class for `credentialRef`; the failure message, or null. */
  async bindSystem(name: string, credentialRef: string, url: string): Promise<string | null> {
    try {
      const cls = await this.#vendor().getSystemGatekeeperClass(credentialRef, { resourceUrl: url });
      this.#minted.set(name, cls as unknown as DurableObjectClass<InferOpsProjectGatekeeper>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Binds `url` through the account's own `getGatekeeperClassFor`; the failure message, or null. */
  async bindAccount(name: string, props: AccountProps, url: string): Promise<string | null> {
    try {
      const { class: cls } = await this.#account(props).getGatekeeperClassFor(url);
      this.#minted.set(name, cls as DurableObjectClass<InferOpsProjectGatekeeper>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** The company of a binding `bindAccount` or `bindSystem` made under `name` (FAC-14 K2), or its failure. */
  async boundConnectionCompany(name: string): Promise<string | null | { failed: string }> {
    try {
      return await this.#bound(name).connectionCompany();
    } catch (error) {
      return { failed: messageOf(error) };
    }
  }

  #bound(name: string) {
    const cls = this.#minted.get(name);
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsProjectGatekeeper>(`minted/${name}`, () => ({ class: cls }));
  }

  /** A dispatch session over a dispatch binding `bindAccount` made under `name`. */
  async startBoundDispatchSession(name: string): Promise<InferOpsDispatchSession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsDispatchGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsDispatchGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** A Wiki session over a Wiki binding `bindAccount` made under `name`. */
  async startBoundWikiSession(name: string): Promise<InferOpsWikiSession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsWikiGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsWikiGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** A table session over a custom-table binding `bindAccount` made under `name`. */
  async startBoundTableSession(name: string): Promise<InferOpsTableSession> {
    return this.#boundTable(name).startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  #boundTable(name: string) {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsTableGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsTableGatekeeper>(`minted/${name}`, () => ({ class: cls }));
  }

  /** Admission of a collaborator to a bound table binding; the failure message, or null. */
  async addTableObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    try {
      await this.#boundTable(name).addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  #tableGatekeeper(props: TableProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<InferOpsTableGatekeeper>(
      `${props.accountId}/table/${props.host}/${props.tableId}`,
      () => ({ class: exports.InferOpsTableGatekeeper({ props }) }));
  }

  /** A table session over a custom-table binding with these props. */
  async startTableSession(props: TableProps): Promise<InferOpsTableSession> {
    return this.#tableGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Admission of a collaborator who could read the table; the failure message, or null. */
  async addTableObserver(props: TableProps): Promise<string | null> {
    try {
      await this.#tableGatekeeper(props).addObserver("observer-1",
        new RpcStub(new TestVerifier(true)) as unknown as Fetcher<GatekeeperUserVerifier>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** An action call on a table binding; the failure message, or null. */
  async applyTable(props: TableProps): Promise<string | null> {
    try {
      await this.#tableGatekeeper(props).applyAction(1, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** The resource description of a table binding. */
  async describeTable(props: TableProps) {
    return this.#tableGatekeeper(props).describe();
  }

  /** A members session over a workspace-members binding `bindAccount` made under `name`. */
  async startBoundMembersSession(name: string): Promise<InferOpsMembersSession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsMembersGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsMembersGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Admission of a collaborator to a bound members binding; the failure message, or null. */
  async addMembersObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsMembersGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    try {
      await this.ctx.facets.get<InferOpsMembersGatekeeper>(`minted/${name}`, () => ({ class: cls }))
        .addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  #membersGatekeeper(props: MembersProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<InferOpsMembersGatekeeper>(
      `${props.accountId}/members/${props.host}`,
      () => ({ class: exports.InferOpsMembersGatekeeper({ props }) }));
  }

  /** A members session over a workspace-members binding with these props. */
  async startMembersSession(props: MembersProps): Promise<InferOpsMembersSession> {
    return this.#membersGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Admission of a collaborator who could read the list; the failure message, or null. */
  async addMembersObserver(props: MembersProps): Promise<string | null> {
    try {
      await this.#membersGatekeeper(props).addObserver("observer-1",
        new RpcStub(new TestVerifier(true)) as unknown as Fetcher<GatekeeperUserVerifier>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Each action call on a members binding; their failure messages, or null for one that ran. */
  async membersActions(props: MembersProps): Promise<Array<string | null>> {
    const gatekeeper = this.#membersGatekeeper(props);
    const calls = [
      () => gatekeeper.applyAction(1, new RpcStub(new TestGitCache())),
      () => gatekeeper.rejectAction(1),
      () => gatekeeper.revertAction(1),
    ];
    const results: Array<string | null> = [];
    for (const call of calls) {
      try {
        await call();
        results.push(null);
      } catch (error) {
        results.push(messageOf(error));
      }
    }
    return results;
  }

  /** The resource description of a members binding. */
  async describeMembers(props: MembersProps) {
    return this.#membersGatekeeper(props).describe();
  }

  /** A workflow-policy session over a binding `bindAccount` made under `name`. */
  /** A Dot session over a Dot binding `bindAccount` made under `name`, entering the facet's own `startSession` (FAC-135). */
  async startBoundDotSession(name: string): Promise<InferOpsDotSession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsDotGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsDotGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestDotQueue(this.#log)) as never);
  }

  async startBoundWorkflowPolicySession(name: string): Promise<InferOpsWorkflowPolicySession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsWorkflowPolicyGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsWorkflowPolicyGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Admission of a collaborator to a bound workflow-policy binding; the failure message, or null. */
  async addWorkflowPolicyObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsWorkflowPolicyGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    try {
      await this.ctx.facets.get<InferOpsWorkflowPolicyGatekeeper>(`minted/${name}`, () => ({ class: cls }))
        .addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  #workflowPolicyGatekeeper(props: WorkflowPolicyProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<InferOpsWorkflowPolicyGatekeeper>(
      `${props.accountId}/workflow/${props.host}/${props.projectKey}`,
      () => ({ class: exports.InferOpsWorkflowPolicyGatekeeper({ props }) }));
  }

  /** A workflow-policy session over a binding with these props. */
  async startWorkflowPolicySession(props: WorkflowPolicyProps): Promise<InferOpsWorkflowPolicySession> {
    return this.#workflowPolicyGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Admission of a collaborator who could read the policy; the failure message, or null. */
  async addWorkflowPolicyObserver(props: WorkflowPolicyProps): Promise<string | null> {
    try {
      await this.#workflowPolicyGatekeeper(props).addObserver("observer-1",
        new RpcStub(new TestVerifier(true)) as unknown as Fetcher<GatekeeperUserVerifier>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Each action call on a workflow-policy binding; their failure messages, or null for one that ran. */
  async workflowPolicyActions(props: WorkflowPolicyProps): Promise<Array<string | null>> {
    const gatekeeper = this.#workflowPolicyGatekeeper(props);
    const calls = [
      () => gatekeeper.applyAction(1, new RpcStub(new TestGitCache())),
      () => gatekeeper.rejectAction(1),
      () => gatekeeper.revertAction(1),
    ];
    const results: Array<string | null> = [];
    for (const call of calls) {
      try {
        await call();
        results.push(null);
      } catch (error) {
        results.push(messageOf(error));
      }
    }
    return results;
  }

  /** The resource description and auto-approvable actions of a workflow-policy binding. */
  async describeWorkflowPolicy(props: WorkflowPolicyProps) {
    const gatekeeper = this.#workflowPolicyGatekeeper(props);
    return { ...(await gatekeeper.describe()), autoApprovable: await gatekeeper.getAutoApprovableActions() };
  }

  /** What `bindAccount` minted under `name`, by the resource description it gives. */
  async describeBound(name: string) {
    return this.#bound(name).describe();
  }

  /** The kernel-only host-board read of a binding `bindAccount` made under `name`, as the overseer calls it. */
  async boundHostBoard(name: string) {
    return this.#bound(name).readHostBoardSnapshot();
  }

  /** The kernel-only connection fence of a binding `bindAccount` made under `name`. */
  async boundHostFence(name: string) {
    return this.#bound(name).connectionIdentity();
  }

  /** The kernel-only host-board read of a board binding with these props. */
  async hostBoard(props: BindingProps) {
    return this.#gatekeeper(props).readHostBoardSnapshot();
  }

  /** The kernel-only connection fence of a board binding with these props. */
  async hostFence(props: BindingProps) {
    return this.#gatekeeper(props).connectionIdentity();
  }

  /** A session over a binding `bindAccount` made under `name`. */
  async startBoundSession(name: string): Promise<InferOpsProjectSession> {
    return this.#bound(name).startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Apply an action of a bound binding; returns the failure message, or null on success. */
  async applyBound(name: string, actionId: number): Promise<string | null> {
    try {
      return failureOf(await this.#bound(name).applyAction(actionId, new RpcStub(new TestGitCache())))?.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Revert an action of a bound binding; the message it reports, or null once reverted. */
  async revertBound(name: string, actionId: number): Promise<string | null> {
    return (await this.#bound(name).revertAction(actionId))?.message ?? null;
  }

  /** Admission of a collaborator by their own account's verifier, over a bound binding. */
  async addObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    try {
      await this.#bound(name).addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async #configurator(props: AccountProps): Promise<ConfiguratorRpc> {
    const frame = await this.#account(props).startResourceConfigurator("inferops://*/project/board/*");
    return frame.ui as unknown as ConfiguratorRpc;
  }

  async defaultHost(props: AccountProps): Promise<string | null> {
    return (await this.#configurator(props)).defaultHost();
  }

  async listWorkspaces(props: AccountProps) {
    return (await this.#configurator(props)).listWorkspaces();
  }

  /** The project keys the configurator lists on `host`, or the failure message. */
  async listProjects(props: AccountProps, host: string, query = ""): Promise<string[] | string> {
    try {
      return (await (await this.#configurator(props)).listProjects(query, host)).map(p => p.value);
    } catch (error) {
      return messageOf(error);
    }
  }

  #dispatchGatekeeper(props: BindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TestDispatchGatekeeper>(
      `${props.accountId}/dispatch/${props.projectKey}`,
      () => ({ class: exports.TestDispatchGatekeeper({ props }) }));
  }

  /** A coding-dispatch session over a dispatch binding with these props. */
  async startDispatchSession(props: BindingProps): Promise<InferOpsDispatchSession> {
    return this.#dispatchGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Apply an action of a dispatch binding; returns the failure message, or null on success. */
  async applyDispatch(props: BindingProps, actionId: number): Promise<string | null> {
    try {
      return failureOf(await this.#dispatchGatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async rejectDispatch(props: BindingProps, actionId: number): Promise<void> {
    await this.#dispatchGatekeeper(props).rejectAction(actionId);
  }

  async revertDispatch(props: BindingProps, actionId: number): Promise<string | null> {
    const result = await this.#dispatchGatekeeper(props).revertAction(actionId);
    return result?.message ?? null;
  }

  /** A raw record of a dispatch binding's storage. */
  async getDispatchRaw(props: BindingProps, key: string): Promise<unknown> {
    return this.#dispatchGatekeeper(props).getRaw(key);
  }

  /** Write a raw record into a dispatch binding's storage. */
  async putDispatchRaw(props: BindingProps, key: string, value: unknown): Promise<void> {
    await this.#dispatchGatekeeper(props).putRaw(key, value);
  }

  #wikiGatekeeper(props: WikiProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TestWikiGatekeeper>(
      `${props.accountId}/wiki/${props.host}`,
      () => ({ class: exports.TestWikiGatekeeper({ props }) }));
  }

  /** A Wiki session over a Wiki binding with these props. */
  async startWikiSession(props: WikiProps): Promise<InferOpsWikiSession> {
    return this.#wikiGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** Apply an action of a Wiki binding; returns the failure message, or null on success. */
  async applyWiki(props: WikiProps, actionId: number): Promise<string | null> {
    try {
      return failureOf(await this.#wikiGatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async rejectWiki(props: WikiProps, actionId: number): Promise<void> {
    await this.#wikiGatekeeper(props).rejectAction(actionId);
  }

  async revertWiki(props: WikiProps, actionId: number): Promise<string | null> {
    const result = await this.#wikiGatekeeper(props).revertAction(actionId);
    return result?.message ?? null;
  }

  async getWikiRaw(props: WikiProps, key: string): Promise<unknown> {
    return this.#wikiGatekeeper(props).getRaw(key);
  }

  async putWikiRaw(props: WikiProps, key: string, value: unknown): Promise<void> {
    await this.#wikiGatekeeper(props).putRaw(key, value);
  }

  /** Admission of a collaborator to a Wiki binding, whose own account does or does not read it. */
  async addWikiObserver(props: WikiProps, hasAccess: boolean): Promise<string | null> {
    const verifier = new RpcStub(new TestVerifier(hasAccess)) as unknown as
      Fetcher<GatekeeperUserVerifier>;
    try {
      await this.#wikiGatekeeper(props).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** Forget the collaborator `addWikiObserver` admitted to a Wiki binding. */
  async removeWikiObserver(props: WikiProps): Promise<void> {
    await this.#wikiGatekeeper(props).removeObserver("observer-1");
  }

  /**
   * What the Wiki facet offers an approval surface: its auto-approvable kinds, and whether it has
   * the edit-before-approve methods a board facet has.
   */
  async wikiApprovalSurfaces(props: WikiProps):
      Promise<{ autoApprovable: unknown[]; getApprovalProposal: boolean; editApprovalProposal: boolean;
                boardEditPath: boolean }> {
    const prototype = InferOpsWikiGatekeeper.prototype as unknown as Record<string, unknown>;
    const board = InferOpsProjectGatekeeper.prototype as unknown as Record<string, unknown>;
    return {
      autoApprovable: await this.#wikiGatekeeper(props).getAutoApprovableActions(),
      getApprovalProposal: typeof prototype.getApprovalProposal === "function",
      editApprovalProposal: typeof prototype.editApprovalProposal === "function",
      // The control: a board facet does offer the edit-before-approve path.
      boardEditPath: typeof board.getApprovalProposal === "function" && typeof board.editApprovalProposal === "function",
    };
  }

  /** Admission of a collaborator by their own account's verifier, over a bound Wiki binding. */
  async addWikiObserverFrom(name: string, observer: AccountProps): Promise<string | null> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsWikiGatekeeper>;
    try {
      await this.ctx.facets.get<InferOpsWikiGatekeeper>(`minted/${name}`, () => ({ class: cls }))
        .addObserver("observer-2", await this.#account(observer).getVerifier());
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /** The workspaces the Wiki picker lists for this account. */
  /** The tables the table picker lists for this account on `host`. */
  async listPickerTables(props: AccountProps, host: string) {
    const frame = await this.#account(props).startResourceConfigurator("inferops://*/object/table/*");
    return (frame.ui as unknown as ConfiguratorRpc & {
      listTables(query: string, host: string): Promise<Array<{ value: string; title: string }>>;
    }).listTables("", host);
  }

  async listWikiWorkspaces(props: AccountProps) {
    const frame = await this.#account(props).startResourceConfigurator("inferops://*/knowledge/wiki");
    return (frame.ui as unknown as ConfiguratorRpc).listWorkspaces();
  }

  #accountGatekeeper(props: AccountBindingProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<TestAccountGatekeeper>(
      `${props.accountId}/account/${props.tenant}`,
      () => ({ class: exports.TestAccountGatekeeper({ props }) }));
  }

  /** An account session over an account binding with these props. */
  async startAccountSession(props: AccountBindingProps): Promise<InferOpsAccountSession> {
    return this.#accountGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /**
   * A board session opened through an account session that is disposed before the board session
   * is returned, as an agent's executeCode ends while a widget keeps the board.
   */
  async openBoardThenDispose(props: AccountBindingProps, boardRef: string): Promise<InferOpsProjectSession> {
    const account = await this.#accountGatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
    const board = await account.openBoard(boardRef);
    account[Symbol.dispose]();
    return board;
  }

  /** Apply an action of an account binding; the failure message, or null once applied. */
  async applyAccount(props: AccountBindingProps, actionId: number): Promise<string | null> {
    try {
      return failureOf(await this.#accountGatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))
        ?.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async rejectAccount(props: AccountBindingProps, actionId: number): Promise<void> {
    await this.#accountGatekeeper(props).rejectAction(actionId);
  }

  async revertAccount(props: AccountBindingProps, actionId: number): Promise<string | null> {
    const result = await this.#accountGatekeeper(props).revertAction(actionId);
    return result?.message ?? null;
  }

  async getAccountRaw(props: AccountBindingProps, key: string): Promise<unknown> {
    return this.#accountGatekeeper(props).getRaw(key);
  }

  async putAccountRaw(props: AccountBindingProps, key: string, value: unknown): Promise<void> {
    await this.#accountGatekeeper(props).putRaw(key, value);
  }

  async accountRawKeys(props: AccountBindingProps, prefix: string): Promise<string[]> {
    return this.#accountGatekeeper(props).rawKeys(prefix);
  }

  async describeAccountBinding(props: AccountBindingProps) {
    return this.#accountGatekeeper(props).describe();
  }

  /**
   * Admission of collaborator `id` to an account binding, whose own account reaches exactly
   * `access`; the failure message, or null once admitted.
   */
  async addAccountObserver(props: AccountBindingProps, id: string,
                           access: ScopedAccess): Promise<string | null> {
    try {
      // A service stub, as the overseer's verifiers are: the binding stores it to check later reads.
      const verifier = (this.ctx.exports as unknown as {
        TestScopedVerifier(options: { props: ScopedAccess }): Fetcher<GatekeeperUserVerifier>;
      }).TestScopedVerifier({ props: access });
      await this.#accountGatekeeper(props).addObserver(id, verifier);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async removeAccountObserver(props: AccountBindingProps, id: string): Promise<void> {
    await this.#accountGatekeeper(props).removeObserver(id);
  }

  /** An account session over an account binding `bindAccount` made under `name`. */
  async startBoundAccountSession(name: string): Promise<InferOpsAccountSession> {
    const cls = this.#minted.get(name) as unknown as DurableObjectClass<InferOpsAccountGatekeeper>;
    if (!cls) throw new Error(`No binding named ${name}.`);
    return this.ctx.facets.get<InferOpsAccountGatekeeper>(`minted/${name}`, () => ({ class: cls }))
      .startSession(new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  /** A session over a binding, recording into this object's queue log. */
  async startSession(props: BindingProps): Promise<InferOpsProjectSession> {
    return this.#gatekeeper(props).startSession(
      new RpcStub(new TestApprovalQueue(this.#log)) as never);
  }

  async log(): Promise<QueueLog> {
    return this.#log;
  }

  /** Apply an action; returns the failure message, or null on success. */
  async apply(props: BindingProps, actionId: number): Promise<string | null> {
    try {
      return failureOf(await this.#gatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
  }

  /**
   * Apply an action of any kind of binding and return what it reports: null once applied, the
   * returned failure, or the message of a thrown error.
   */
  async applyOutcome(props: BindingProps | WikiProps, actionId: number,
                     kind: "board" | "dispatch" | "wiki" = "board"):
      Promise<ActionApplyFailure | { thrown: string } | null> {
    const gatekeeper = kind === "wiki" ? this.#wikiGatekeeper(props as WikiProps)
      : kind === "dispatch" ? this.#dispatchGatekeeper(props as BindingProps)
      : this.#gatekeeper(props as BindingProps);
    try {
      return failureOf(await gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache()))) ?? null;
    } catch (error) {
      return { thrown: messageOf(error) };
    }
  }

  /** What a successful apply reported it produced (`{applied: {result}}`), or null when it reported none. */
  async appliedResult(props: BindingProps | WikiProps, actionId: number,
                      kind: "board" | "dispatch" | "wiki" = "board"): Promise<ActionResult | null> {
    const gatekeeper = kind === "wiki" ? this.#wikiGatekeeper(props as WikiProps)
      : kind === "dispatch" ? this.#dispatchGatekeeper(props as BindingProps)
      : this.#gatekeeper(props as BindingProps);
    const outcome = await gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache()));
    return outcome && "applied" in outcome ? outcome.applied.result : null;
  }

  /** Write a raw value into the binding's storage, as an older version might have left it. */
  async putRaw(props: BindingProps, key: string, value: unknown): Promise<void> {
    await this.#gatekeeper(props).putRaw(key, value);
  }

  /** Read a raw value from the binding's storage. */
  async getRaw(props: BindingProps, key: string): Promise<unknown> {
    return this.#gatekeeper(props).getRaw(key);
  }

  async reject(props: BindingProps, actionId: number): Promise<void> {
    await this.#gatekeeper(props).rejectAction(actionId);
  }

  async revert(props: BindingProps, actionId: number): Promise<string | null> {
    const result = await this.#gatekeeper(props).revertAction(actionId);
    return result?.message ?? null;
  }

  /** Forget the observer `addObserver` admitted. */
  async removeObserver(props: BindingProps): Promise<void> {
    await this.#gatekeeper(props).removeObserver("observer-1");
  }

  /** Admission of a collaborator whose own account does or does not reach the project. */
  async addObserver(props: BindingProps, hasAccess: boolean): Promise<string | null> {
    const verifier = new RpcStub(new TestVerifier(hasAccess)) as unknown as
      Fetcher<GatekeeperUserVerifier>;
    try {
      await this.#gatekeeper(props).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  // --- The Dot (FAC-133): the facet's own session, apply and reject, over the real HTTP client
  // and a scripted fake InferOps.
  #dot: FakeDot | null = null;
  /** The staging each Dot session start began in the background (FAC-135). */
  #sweeps: Promise<void>[] = [];

  #dotBinding() {
    if (!this.#dot) throw new Error("dotScript() first");
    const client = openHttpInferOpsClient({
      baseUrl: "https://ops.example/api", host: "acme.operations", token: "iex_test-dot-token",
      workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "operations",
    }, this.#dot.fetch as typeof fetch);
    const used = this.#dot.script.otherCompany ? {
      ...client,
      confirmDotProposal: async () => { throw new InferOpsError("OTHER_COMPANY", OTHER_COMPANY, { stage: "unsent" }); },
    } : client;
    return dotBindingOver(
      { accountId: "dot-account", connected: true, host: "acme.operations", workspaceId: "90000000-0000-4000-8000-000000000001" },
      this.ctx.storage.kv, used,
      { background: work => { this.#sweeps.push(work); }, sweepDeadlineMs: this.#dot.script.sweepDeadlineMs });
  }

  /** What the fake InferOps answers from now on. */
  async dotScript(script: DotScript): Promise<void> {
    if (this.#dot) this.#dot.script = script;
    else this.#dot = new FakeDot(script);
  }

  /** Every request the fake InferOps took. */
  async dotCalls(): Promise<DotCall[]> {
    return this.#dot?.calls ?? [];
  }

  async startDotSession(): Promise<InferOpsDotSession> {
    return this.#dotBinding().startSession(new RpcStub(new TestDotQueue(this.#log)) as never);
  }

  /** Waits for the staging every Dot session start so far began in the background (FAC-135). */
  async dotSweepSettled(): Promise<void> {
    await Promise.all(this.#sweeps);
  }

  /** Watches a conversation as a turn would (FAC-135). */
  async dotWatch(conversationId: string): Promise<void> {
    this.#dotBinding().watch(conversationId);
  }

  /** A Dot action's record as the facet keeps it (FAC-135: its resumed run and run status). */
  async dotRecord(actionId: number): Promise<Record<string, unknown> | null> {
    return (this.#dotBinding().record(actionId) as Record<string, unknown> | undefined) ?? null;
  }

  /** When the Dot's session start found the person's sign-in gone (FAC-135), or null. */
  async dotWaitsForReconnect(): Promise<string | null> {
    return this.#dotBinding().waitsForReconnect();
  }

  /** Each time the kernel's approved effects were asked to start the declared run (FAC-120). */
  #effectsAsked: string[] = [];

  async dotEffectsAsked(): Promise<string[]> {
    return this.#effectsAsked;
  }

  /**
   * Apply a Dot action: its failure, or its result once applied. With `run`, as a person's
   * approval: the kernel's approved effects answer each run with it (FAC-120); without, as an
   * automatic approval or an older kernel, there are none.
   */
  async applyDot(actionId: number, run?: { status: "started"; runId: string } | { status: "refused"; kind: ActionFailureKind; reason: string }
      | { status: "unknown"; reason: string })
      : Promise<{ failure: ActionApplyFailure | null; result: ActionResult | null }> {
    // The kernel's effects take no reference: the run is the one the action declared at submit.
    const effects = run ? {
      invokeWorkflow: async () => { this.#effectsAsked.push("invoked"); return run; },
      createTemporaryCanvas: async (): Promise<ApprovedTemporaryCanvas> => { throw new Error("No canvas was scripted."); },
    } : undefined;
    const outcome = await this.#dotBinding().applyAction(actionId, effects as never);
    if (outcome && "failed" in outcome) return { failure: outcome.failed, result: null };
    return { failure: null, result: outcome && "applied" in outcome ? outcome.applied.result ?? null : null };
  }

  /**
   * Apply a Dot canvas action as a person's approval (FAC-137): the kernel's `createTemporaryCanvas`
   * gives `answer`, or with `"throw"` rejects, as a kernel call whose answer was lost.
   */
  async applyDotCanvas(actionId: number, answer: ApprovedTemporaryCanvas | "throw")
      : Promise<{ failure: ActionApplyFailure | null; result: ActionResult | null }> {
    const effects = {
      invokeWorkflow: async (): Promise<ApprovedWorkflowRun> => { throw new Error("No run was scripted."); },
      createTemporaryCanvas: async () => {
        this.#effectsAsked.push("canvas");
        if (answer === "throw") throw new Error("The kernel's answer was lost.");
        return answer;
      },
    };
    const outcome = await this.#dotBinding().applyAction(actionId, effects as never);
    if (outcome && "failed" in outcome) return { failure: outcome.failed, result: null };
    return { failure: null, result: outcome && "applied" in outcome ? outcome.applied.result ?? null : null };
  }

  async rejectDot(actionId: number): Promise<void> {
    await this.#dotBinding().rejectAction(actionId);
  }

  /** The kernel telling the Dot facet how an approved action's run came out (FAC-134). */
  async dotRunOutcome(actionId: number, outcome: ApprovedRunOutcome): Promise<string | null> {
    try {
      await this.#dotBinding().workflowRunOutcome(actionId, outcome);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Applies a Dot action with the kernel's personal workflow effects (FAC-134 capability 2): each
   * answers as given, and records that it was asked. The invoke effect is there too, never to be
   * asked for a personal workflow.
   */
  async applyDotPersonal(actionId: number,
      answers: { created?: ApprovedPersonalWorkflow; run?: ApprovedWorkflowRun; launched?: ApprovedDelegate })
      : Promise<{ failure: ActionApplyFailure | null; asked: string[] }> {
    const asked: string[] = [];
    const effects = {
      invokeWorkflow: async () => { asked.push("invoked"); return answers.run; },
      createPersonalWorkflow: async () => { asked.push("created"); return answers.created; },
      runPersonalWorkflow: async () => { asked.push("ran"); return answers.run; },
      launchDelegate: async () => { asked.push("launched"); return answers.launched; },
    } as never;
    const outcome = await this.#dotBinding().applyAction(actionId, effects);
    return { failure: outcome && "failed" in outcome ? outcome.failed : null, asked };
  }

  /** A Dot action's recorded personal workflow (FAC-134 capability 2), if it created one. */
  async dotPersonalWorkflow(actionId: number): Promise<{ id: string; reference: string; expiresAt: string } | null> {
    return this.ctx.storage.kv.get<{ personalWorkflow?: { id: string; reference: string; expiresAt: string } }>(`action:${actionId}`)?.personalWorkflow ?? null;
  }

  /** A Dot action's recorded delegate (FAC-134 capability 3), if it launched one. */
  async dotDelegate(actionId: number): Promise<{ id: string } | null> {
    return this.ctx.storage.kv.get<{ delegate?: { id: string } }>(`action:${actionId}`)?.delegate ?? null;
  }

  /** The run outcomes a Dot action recorded (FAC-134). */
  async dotReportedRuns(actionId: number): Promise<unknown[]> {
    return this.ctx.storage.kv.get<{ reportedRuns?: unknown[] }>(`action:${actionId}`)?.reportedRuns ?? [];
  }

  /** A Dot action's stored status and, once settled, its stored message; null when there is none. */
  async dotAction(actionId: number): Promise<{ status: string; message: string | null } | null> {
    const raw = this.ctx.storage.kv.get<{ status: string; attempts?: { failure?: { message?: string } } }>(`action:${actionId}`);
    return raw ? { status: raw.status, message: raw.attempts?.failure?.message ?? null } : null;
  }

  /** Whether the real Dot facet admits a collaborator: the refusal's message, or null if admitted. */
  async addDotObserver(props: DotProps): Promise<string | null> {
    const exports = this.ctx.exports as unknown as TestExports;
    const facet = this.ctx.facets.get<InferOpsDotGatekeeper>(`${props.accountId}/dot/${props.host}`,
      () => ({ class: exports.InferOpsDotGatekeeper({ props }) }));
    try {
      await facet.addObserver("observer-1", new RpcStub(new TestVerifier(true)) as unknown as Fetcher<GatekeeperUserVerifier>);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }
}

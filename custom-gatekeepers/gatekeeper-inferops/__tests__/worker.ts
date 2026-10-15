// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object that plays the overseer: it instantiates the
// gatekeeper as a facet with props, hands it an approval queue that records what it is told, and
// applies or rejects the actions it collected.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionApplyFailure, ActionDescription, ConnectHandoff, GatekeeperUser, GatekeeperUserVerifier, GitCache,
  GitObjectType, GitOid, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  InferOpsCredentials as BaseInferOpsCredentials, InferOpsDispatchGatekeeper, InferOpsMembersGatekeeper,
  InferOpsProjectGatekeeper, InferOpsTableGatekeeper, InferOpsWikiGatekeeper, InferOpsWorkflowPolicyGatekeeper,
  MockInferOps as BaseMockInferOps,
} from "../src/inferops.js";
import type { RejectionVerdict } from "@gadgets/gatekeeper-kit/credentials";
import {
  InferOpsError, type IssueChanges, type NewIssueRequest, type WikiProposalApproval, type WikiProposalRecord,
  type WorkspaceMembersRead,
} from "../src/inferops-client.js";
import type { MockTables } from "../src/mock-inferops.js";
import type { Issue, Revision } from "../src/types.js";
import type {
  InferOpsDispatchSession, InferOpsMembersSession, InferOpsProjectSession, InferOpsTableSession,
  InferOpsWikiSession, InferOpsWorkflowPolicySession,
} from "../src/types.js";

export { default } from "../src/inferops.js";
export * from "../src/inferops.js";
// Vitest's ctx.exports analyzer does not follow `export *`, so the classes reached through
// ctx.exports are named explicitly.
export {
  GatekeeperVendor, InferLabLogin, InferOpsAccount, InferOpsDispatchGatekeeper, InferOpsMembersGatekeeper,
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
    /** Each field's label and shown value. */
    fields: Record<string, string>;
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
    for (const field of description.fields ?? []) {
      if ("value" in field && typeof field.value === "string") fields[field.label] = field.value;
    }
    this.log.actions.push({
      id, title: description.title, description: description.description,
      implementsRevert: description.implementsRevert ?? false, fields,
      ...(description.actionKind ? { kind: description.actionKind.tag } : {}),
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
  TestProjectGatekeeper(options: { props: BindingProps }):
    DurableObjectClass<TestProjectGatekeeper>;
  InferOpsAccount(options: { props: AccountProps }): Fetcher<GatekeeperUser>;
  TestDispatchGatekeeper(options: { props: BindingProps }): DurableObjectClass<TestDispatchGatekeeper>;
  TestWikiGatekeeper(options: { props: WikiProps }): DurableObjectClass<TestWikiGatekeeper>;
  InferOpsTableGatekeeper(options: { props: TableProps }): DurableObjectClass<InferOpsTableGatekeeper>;
  InferOpsMembersGatekeeper(options: { props: MembersProps }): DurableObjectClass<InferOpsMembersGatekeeper>;
  InferOpsWorkflowPolicyGatekeeper(options: { props: WorkflowPolicyProps }):
    DurableObjectClass<InferOpsWorkflowPolicyGatekeeper>;
};

/** The project configurator's capability, as the picker iframe receives it. */
type ConfiguratorRpc = {
  defaultHost(): Promise<string | null>;
  listWorkspaces(): Promise<Array<{ value: string; title: string }>>;
  listProjects(query: string, host: string): Promise<Array<{ value: string }>>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      return (await this.#bound(name).applyAction(actionId, new RpcStub(new TestGitCache())))?.failed.message ?? null;
    } catch (error) {
      return messageOf(error);
    }
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
      return (await this.#dispatchGatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.failed.message ?? null;
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
      return (await this.#wikiGatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.failed.message ?? null;
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
      return (await this.#gatekeeper(props).applyAction(actionId, new RpcStub(new TestGitCache())))?.failed.message ?? null;
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
      return (await gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache())))?.failed ?? null;
    } catch (error) {
      return { thrown: messageOf(error) };
    }
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
}

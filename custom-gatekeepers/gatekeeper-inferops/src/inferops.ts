// InferOps gatekeeper: scoped project-board reads and approved issue transitions.
//
// - `GatekeeperVendor` auto-provisions accounts (no OAuth): an account is just an id that keys its
//   private copy of the demo data in `MockInferOps`.
// - `InferOpsAccount` (the GatekeeperUser) maps `inferops://<tenant>.<workspace>/project/board/<KEY>`
//   (InferOps' own URI grammar) to an `InferOpsProjectGatekeeper` facet whose props fix the
//   account, host, workspace id and project key. Scope is read from those props only; no session
//   method accepts a project, host, workspace or account.
// - The URL never names a deployment, and its labels authorize nothing. The `<workspace>` slug is
//   resolved against the signed-in person's own workspaces (`resolveWorkspace`), so a slug they do
//   not hold is refused exactly like a missing project. The `<tenant>` label is checked for syntax
//   only: the identity InferLab reports carries a tenant id, never its slug, so there is nothing to
//   compare it with (InferOps' own widgets do not check it either). `demo.local` names the demo
//   data and nothing else.
// - Sessions: `InferOpsProjectSession` reads the board and narrows to one issue with `openIssue`;
//   `InferOpsIssueSession` reads that issue and proposes transitions.
// - Every returned read is authorized as an observation. A transition is checked against the
//   simulated issue, recorded, and submitted as an action; until it is decided, reads show the issue
//   in its target state (simulation.ts), and a second move of the same issue is refused. Applying
//   calls the data source with this facet's id plus the action id as the idempotency key, which
//   also rechecks scope, state, workflow and the expected revision against current data. Rejecting
//   deletes the record, which ends the simulation.
// - Observers (strategy B): a binding is one project, so a collaborator is admitted when their own
//   InferOps account can open that project.
//
// - Identity: when INFERLAB_AUTH_ORIGIN is set the vendor provides authentication ("Sign in with
//   InferLab", `connectAccount` with `scopes: "auth"`) and a real connect flow (`scopes: "full"`),
//   both InferLab PKCE sign-ins (inferlab-login.ts). A connected account is backed by the person's
//   own InferLab session, held in its `InferOpsCredentials` object (inferops-credentials.ts), and
//   every request it makes carries that person's token and one of their workspaces. Auto-provisioned
//   accounts exist only while no auth origin is configured: they carry no identity and serve demo
//   data, or the local-development stopgap connection.
//
// All project data comes through `InferOpsClient` (inferops-client.ts), chosen by `clientFor`: the
// mock (mock-inferops.ts) for the demo host, the HTTP client (http-inferops.ts) with a connected
// account's own authority in one of its workspaces, and the same client with the stopgap
// connection for a URL naming the stopgap's workspace slug.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GitCache,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import {
  CredentialSource, isCredentialsChanged, isCredentialsExpired,
} from "@gadgets/gatekeeper-kit/credentials";
import {
  InferOpsError, inferOpsErrorCode, type InferOpsClient, type ProjectSummary,
} from "./inferops-client";
import {
  connectionFromEnv, openHttpInferOpsClient, type InferOpsAuthority, type InferOpsEndpoint,
} from "./http-inferops";
import { MockInferOps, openInferOpsClient } from "./mock-inferops";
import { assertInferOpsEnabled, whileInferOpsEnabled } from "./enablement";
import { InferOpsCredentials, type InferOpsWorkspace } from "./inferops-credentials";
import {
  InferLabLogin, handleInferLabLogin, inferLabAuthOrigin, inferOpsApiEndpoint, startInferLabLogin,
} from "./inferlab-login";
import {
  DEMO_HOST, PROJECT_BOARD_RESOURCE, parseHost, parseProjectBoardUrl, projectBoardUrl,
} from "./resources";
import { buildBoard, livePendingMove, simulateIssue, type PendingTransition } from "./simulation";
import type { InferOpsProjectConfiguratorRpc } from "./configurator/project-configurator-types";
import type {
  Board, InferOpsIssueSession, InferOpsProjectSession, Issue, Revision,
} from "./types";
import TYPES_CODE from "./types.txt";
import PROJECT_CONFIGURATOR_HTML from "./generated/project-ui.txt";

export { InferLabLogin, InferOpsCredentials, MockInferOps };

const VENDOR_ID = "inferops";

type LogFields = { vendorId: string; projectKey: string; action: number; code: string };
const logger = createLogger<LogFields>({ component: "gatekeeper.inferops", vendorId: VENDOR_ID });

// The Phosphor "Kanban" glyph as a self-contained SVG data URI.
const INFEROPS_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M216,48H40A16,16,0,0,0,24,64V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V64A16," +
    "16,0,0,0,216,48ZM40,64H88V192H40Zm64,0h48V160H104Zm112,128H168V64h48V192Z'/></svg>"),
};

const NO_CONNECT_FLOW = "The InferOps connector is provided automatically; it has no connect flow.";
const NOT_CONNECTED = "This InferOps account is not connected to an InferLab identity.";
const EXPIRED_MESSAGE = "Your InferLab session has ended. Reconnect InferOps.";
const OPTION_LIMIT = 100;

/** HTTP serves only the InferLab sign-in legs; everything else is RPC. */
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handleInferLabLogin(request, env, ctx.exports.InferLabLogin);
    return response ?? new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Props

/**
 * An account: an id, which keys the account's InferOps data and, for a connected account
 * (`connected`), its `InferOpsCredentials` object; plus the InferLab-verified email when the
 * account was minted by a sign-in or a connect that proved it. Auto-provisioned accounts carry no
 * identity.
 */
type AccountProps = { accountId: string; email?: string; connected?: boolean };

/** What `clientFor` needs to know about an account. */
type AccountRef = Pick<AccountProps, "accountId" | "connected">;

/**
 * One project-board binding, fixed when the Workshop mints it. `host` is the URL's
 * `<tenant>.<workspace>`, kept for the binding's description and the mock's key. `workspaceId` is
 * the InferOps workspace a connected account made the binding in: the membership the URL's
 * workspace slug resolved to, never an id taken from the URL.
 */
type ProjectGatekeeperProps = AccountRef & { host: string; projectKey: string; workspaceId?: string };

type ExportsWithStores = {
  MockInferOps: DurableObjectNamespace<MockInferOps>;
  InferOpsCredentials: DurableObjectNamespace<InferOpsCredentials>;
};

function credentialsOf(exports: ExportsWithStores, accountId: string) {
  return exports.InferOpsCredentials.get(exports.InferOpsCredentials.idFromName(accountId));
}

/**
 * The HTTP client as one connected person: every request fetches the account's current token for
 * `workspaceId` (one of the person's own), and a token InferOps rejects is
 * adjudicated by the account before the request fails. A dead session surfaces as `UNAUTHORIZED`;
 * a session replaced mid-request as `UNAVAILABLE`, which a retry resolves.
 */
function accountClient(
  exports: ExportsWithStores, endpoint: InferOpsEndpoint, accountId: string, workspaceId: string,
): InferOpsClient {
  const source = new CredentialSource<InferOpsAuthority>({
    account: () => {
      const store = credentialsOf(exports, accountId);
      return {
        getCredentials: () => store.getCredentials(workspaceId),
        reportCredentialsRejected: identity => store.reportCredentialsRejected(identity),
      };
    },
    isAuthError: error => inferOpsErrorCode(error) === "UNAUTHORIZED",
    expiredMessage: EXPIRED_MESSAGE,
    vendorId: VENDOR_ID,
  });
  return openHttpInferOpsClient({
    ...endpoint,
    async authorize(operation) {
      try {
        // Every InferOps call here is safe to repeat: reads, or a transition under its own
        // idempotency key.
        return await source.run(operation, { replayable: true });
      } catch (error) {
        if (isCredentialsExpired(error)) {
          throw new InferOpsError("UNAUTHORIZED", (error as Error).message);
        }
        if (isCredentialsChanged(error)) {
          throw new InferOpsError("UNAVAILABLE", "This InferOps connection changed. Try again.");
        }
        throw error;
      }
    },
  });
}

/**
 * The data source for a binding, refused with `DISABLED` on every call while the deployment has
 * InferOps turned off (enablement.ts). Checked per call, so existing bindings and sessions stop
 * and resume with the switch.
 */
function clientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  return whileInferOpsEnabled(env, () => openClientFor(env, exports, account, host, workspaceId));
}

/**
 * The data source for a binding: the mock for the demo host; for a connected account, the HTTP
 * client with its own authority in `workspaceId`, which the caller resolved from the URL's
 * workspace slug against the person's memberships; for any other account, the stopgap connection
 * when the host names its workspace slug. Anything else is refused as a missing project would be.
 * No address or credential is ever taken from the host.
 *
 * STOPGAP: the connection from worker vars is shared by every account of the deployment. Local
 * development only; it never backs a connected person, whose own token always wins.
 */
function openClientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  const mock = () => openInferOpsClient(exports.MockInferOps, { accountId: account.accountId, host });
  if (host === DEMO_HOST) return mock();
  if (account.connected) {
    const endpoint = inferOpsApiEndpoint(env);
    if (endpoint && workspaceId) return accountClient(exports, endpoint, account.accountId, workspaceId);
  } else {
    const stopgap = connectionFromEnv(env);
    if (stopgap && parseHost(host)?.workspace === stopgap.workspaceSlug) {
      return openHttpInferOpsClient(stopgap);
    }
  }
  // The mock refuses every host but its own, with the same NOT_FOUND an unknown project gets.
  return mock();
}

/** The message every refused binding gets, whatever was missing: workspace, host or project. */
function unavailableProject(projectKey: string, host: string): string {
  return `No InferOps project ${projectKey} is available on ${host}.`;
}

/** The deployment a connected account calls, for its display name; null when it serves demo data. */
function deploymentHost(env: Cloudflare.Env, account: AccountRef): string | null {
  if (account.connected) return inferOpsApiEndpoint(env)?.host ?? null;
  return connectionFromEnv(env)?.host ?? null;
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    const identity = inferLabAuthOrigin(this.env) !== null;
    return {
      displayName: "InferOps",
      url: "https://github.com/factory-level/inferops",
      logo: INFEROPS_ICON,
      tagline: "Read project boards and propose issue moves",
      description:
        "Gives Gadgets access to one InferOps project board at a time: read its issues and " +
        "propose moving them between workflow states, each move approved by you. " +
        (identity
          ? "Connecting signs you in with InferLab, so everything happens with your own " +
            "InferOps access."
          : "Unless the deployment is configured with an InferOps connection, it serves demo data."),
      // With an InferLab identity configured, every account is a person's own; without one, the
      // demo account is provided automatically.
      autoProvisionsAccount: !identity,
      providesAuth: identity,
    };
  }

  /**
   * Mint a fresh account with no user identity; its random id keys its own copy of the demo data.
   * Return validation is skipped: proxy-wrapping a WorkerEntrypoint stub breaks serialization.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.InferOpsAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /**
   * Both flows are InferLab sign-ins: `scopes: "auth"` hands back only the verified email, anything
   * else connects an account backed by the person's own session. Without an InferLab origin the
   * demo account is provided automatically and there is no flow at all.
   */
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    if (inferLabAuthOrigin(this.env) === null) throw new Error(NO_CONNECT_FLOW);
    const purpose = options?.scopes === "auth" ? { kind: "signin" as const } : { kind: "connect" as const };
    return startInferLabLogin(this.ctx.exports.InferLabLogin, this.env, purpose, callback);
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [PROJECT_BOARD_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// Account

@validateRpc()
export class InferOpsAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
    implements GatekeeperUser {
  #client(host: string, workspaceId?: string): InferOpsClient {
    return clientFor(this.env, this.ctx.exports, this.ctx.props, host, workspaceId);
  }

  #credentials() {
    if (!this.ctx.props.connected) throw new Error(NOT_CONNECTED);
    return credentialsOf(this.ctx.exports, this.ctx.props.accountId);
  }

  async describe(): Promise<AccountDescription> {
    const deployment = deploymentHost(this.env, this.ctx.props);
    const identity = this.ctx.props.connected ? await this.#credentials().identity() : null;
    return {
      displayName: deployment ? `InferOps (${deployment})` : "InferOps (demo data)",
      uniqueName: identity?.email,
      avatar: INFEROPS_ICON,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [PROJECT_BOARD_RESOURCE];
  }

  /**
   * The workspace a URL's host names for this account: the id of the person's own workspace with
   * that slug for a connected account, or null when they hold none (whether or not it exists).
   * Undefined for the demo host and for an account with no identity, whose stopgap connection
   * fixes its own workspace.
   */
  async #workspaceFor(host: string): Promise<string | null | undefined> {
    if (host === DEMO_HOST || !this.ctx.props.connected) return undefined;
    const labels = parseHost(host);
    return labels ? this.#credentials().resolveWorkspace(labels.workspace) : null;
  }

  /** Whether the project is available on `host` to this account; false for a workspace it lacks. */
  async #hasProject(host: string, workspaceId: string | null | undefined, projectKey: string) {
    if (workspaceId === null) return false;
    try {
      return await this.#client(host, workspaceId).hasProject(projectKey);
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") return false;
      throw error;
    }
  }

  /**
   * Bind one project board. The URL only names the target: its workspace slug must be one of the
   * person's own, the project must exist there for this account, and the resulting class carries
   * the account, host, key and (for a connected account) workspace id in its props, which is the
   * only place the gatekeeper ever reads its scope from. A workspace the person lacks, an unknown
   * host and a missing project are refused with one message, so a URL cannot probe for any of them.
   */
  @skipRpcValidation()
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    assertInferOpsEnabled(this.env);
    const { host, projectKey } = parseProjectBoardUrl(url);
    const workspaceId = await this.#workspaceFor(host);
    if (!(await this.#hasProject(host, workspaceId, projectKey))) {
      throw new Error(unavailableProject(projectKey, host));
    }
    const { accountId, connected } = this.ctx.props;
    const props: ProjectGatekeeperProps = {
      accountId, connected, host, projectKey, workspaceId: workspaceId ?? undefined,
    };
    return {
      class: this.ctx.exports.InferOpsProjectGatekeeper({ props }),
      resource: PROJECT_BOARD_RESOURCE,
    };
  }

  @skipRpcValidation()
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== PROJECT_BOARD_RESOURCE.urlPattern) {
      throw new Error(`Unsupported InferOps resource configurator type: ${resourceUrlPattern}`);
    }
    const store = this.ctx.props.connected ? this.#credentials() : null;
    const stopgap = store ? null : connectionFromEnv(this.env);
    return {
      iframeHtml: PROJECT_CONFIGURATOR_HTML,
      ui: new RpcStub(new InferOpsProjectConfiguratorUI({
        // Demo data needs no organization or workspace; every other account must name both.
        defaultHost: store || stopgap ? null : DEMO_HOST,
        workspaces: async () => store
          ? (await store.identity())?.workspaces ?? []
          : stopgap ? [{ workspaceId: stopgap.workspaceId, workspaceName: "Configured workspace",
                         workspaceSlug: stopgap.workspaceSlug }] : [],
        projects: async host => {
          const workspaceId = await this.#workspaceFor(host);
          if (workspaceId === null) return [];
          try {
            return await this.#client(host, workspaceId).listProjects();
          } catch (error) {
            if (inferOpsErrorCode(error) === "NOT_FOUND") return [];
            throw error;
          }
        },
      })),
    };
  }

  /**
   * Delete this account's demo data, and for a connected account sign its InferLab session out and
   * forget it; its bindings then fail on their next read. Nothing is held for the stopgap
   * connection, whose credential is the deployment's (see `clientFor`).
   */
  async revoke(): Promise<void> {
    await this.#client(DEMO_HOST).forget();
    if (this.ctx.props.connected) await this.#credentials().revoke();
  }

  /** A fresh InferLab sign-in whose session replaces this account's once the Workshop commits it. */
  async reconnect(): Promise<{ url: string }> {
    if (!this.ctx.props.connected) throw new Error(NO_CONNECT_FLOW);
    return startInferLabLogin(this.ctx.exports.InferLabLogin, this.env,
      { kind: "reconnect", accountId: this.ctx.props.accountId });
  }

  async commitReconnect(stageId: string): Promise<void> {
    if (!this.ctx.props.connected) throw new Error(NO_CONNECT_FLOW);
    await this.#credentials().commitReconnect(stageId);
  }

  /** The InferLab-verified email of a sign-in or connected account; null without one. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return this.ctx.props.email ?? null;
  }

  /** No grantable resource types, so nothing to authorize and no URL to return. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** A verifier answering, from this account's own data, which projects it can open. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.InferOpsVerifier({ props: this.ctx.props });
  }
}

/** The verifier surface `addObserver` relies on; the overseer only hands it back to this vendor. */
export interface InferOpsVerifierApi extends GatekeeperUserVerifier {
  /** Whether this account can open the project, in the binding's workspace when it names one. */
  hasProjectAccess(host: string, projectKey: string, workspaceId?: string): Promise<boolean>;
}

@validateRpc()
export class InferOpsVerifier extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
    implements InferOpsVerifierApi {
  async hasProjectAccess(host: string, projectKey: string, workspaceId?: string): Promise<boolean> {
    try {
      // A connected observer must reach the project with their own token in the binding's
      // workspace; the account refuses a workspace they are not a member of before any request.
      return await clientFor(this.env, this.ctx.exports, this.ctx.props, host, workspaceId)
        .hasProject(projectKey);
    } catch (error) {
      // An unknown host, a refused credential, or no membership of the workspace is "no access";
      // anything else fails the open loudly instead of denying.
      const code = inferOpsErrorCode(error);
      if (code === "NOT_FOUND" || code === "UNAUTHORIZED" || code === "FORBIDDEN") return false;
      if (error instanceof Error && error.message.includes("not a member")) return false;
      throw error;
    }
  }
}

/** What the configurator may ask of the account. */
type ConfiguratorSource = {
  /** The host a binding names when the form names no workspace; null when one must be named. */
  defaultHost: string | null;
  /** The workspaces a URL may name for this account, each with its slug. */
  workspaces(): Promise<InferOpsWorkspace[]>;
  /** The projects this account can open on `host`; empty for a workspace it does not hold. */
  projects(host: string): Promise<ProjectSummary[]>;
};

// Keeps the account out of the iframe-facing object's public surface.
const configuratorSources = new WeakMap<object, ConfiguratorSource>();

@validateRpc()
class InferOpsProjectConfiguratorUI extends RpcTarget implements InferOpsProjectConfiguratorRpc {
  constructor(source: ConfiguratorSource) {
    super();
    configuratorSources.set(this, source);
  }

  #source(): ConfiguratorSource {
    const source = configuratorSources.get(this);
    if (!source) throw new Error("The InferOps configurator is not initialized.");
    return source;
  }

  async defaultHost(): Promise<string | null> {
    return this.#source().defaultHost;
  }

  async listWorkspaces(): Promise<ConfiguratorUIOption[]> {
    const workspaces = await this.#source().workspaces();
    return workspaces.flatMap(w => w.workspaceSlug
      ? [{ value: w.workspaceSlug, title: w.workspaceName, subtitle: w.workspaceSlug }] : []);
  }

  async listProjects(query: string, host: string): Promise<ConfiguratorUIOption[]> {
    if (host !== DEMO_HOST && !parseHost(host)) {
      throw new Error("Enter your organization and choose a workspace first.");
    }
    const needle = query.trim().toLowerCase();
    return (await this.#source().projects(host))
      .filter(p => !needle || p.identifier.toLowerCase().includes(needle) ||
        p.name.toLowerCase().includes(needle))
      .slice(0, OPTION_LIMIT)
      .map(p => ({ value: p.identifier, title: p.name, subtitle: p.identifier }));
  }
}

// ---------------------------------------------------------------------------
// Project gatekeeper (a facet of the Overseer, one per binding)

/** A submitted transition and its outcome so far. */
type ActionRecord = PendingTransition & {
  toStateName: string;
  status: "pending" | "applied" | "reverted";
};

const ACTION_PREFIX = "action:";
const NEXT_ACTION_KEY = "nextActionId";
const INSTANCE_KEY = "instanceId";

/** The facet's state and data source, as the sessions it hands out need them. */
class ProjectBinding {
  constructor(
    readonly ctx: DurableObjectState<ProjectGatekeeperProps>,
    readonly client: InferOpsClient,
  ) {}

  get projectKey(): string {
    return this.ctx.props.projectKey;
  }

  get kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  /** A random id for this facet, so two bindings of one account never share idempotency keys. */
  instanceId(): string {
    let id = this.kv.get<string>(INSTANCE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      this.kv.put(INSTANCE_KEY, id);
    }
    return id;
  }

  idempotencyKey(actionId: number, suffix = ""): string {
    return `${this.instanceId()}:${actionId}${suffix}`;
  }

  action(actionId: number): ActionRecord | undefined {
    return this.kv.get<ActionRecord>(ACTION_PREFIX + actionId);
  }

  putAction(record: ActionRecord): void {
    this.kv.put(ACTION_PREFIX + record.actionId, record);
  }

  deleteAction(actionId: number): void {
    this.kv.delete(ACTION_PREFIX + actionId);
  }

  pending(): PendingTransition[] {
    const out: PendingTransition[] = [];
    for (const [, record] of this.kv.list<ActionRecord>({ prefix: ACTION_PREFIX })) {
      if (record.status === "pending") out.push(record);
    }
    return out;
  }

  /** Record a pending transition before it is submitted, so an immediate apply can find it. */
  stage(record: Omit<ActionRecord, "actionId" | "status">): number {
    const actionId = this.kv.get<number>(NEXT_ACTION_KEY) ?? 1;
    this.kv.put(NEXT_ACTION_KEY, actionId + 1);
    this.putAction({ ...record, actionId, status: "pending" });
    return actionId;
  }

  async board(): Promise<Board> {
    return buildBoard(await this.client.readProject(this.projectKey), this.pending());
  }

  async issue(issueId: string): Promise<Issue> {
    return simulateIssue(await this.client.readIssue(this.projectKey, issueId), this.pending());
  }
}

@validateRpc()
export class InferOpsProjectGatekeeper
    extends DurableObject<Cloudflare.Env, ProjectGatekeeperProps>
    implements Gatekeeper<InferOpsProjectSession> {
  #binding(): ProjectBinding {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    return new ProjectBinding(
      this.ctx, clientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId));
  }

  async describe(): Promise<ResourceDescription> {
    const { host, projectKey } = this.ctx.props;
    return {
      url: projectBoardUrl({ host, projectKey }),
      title: `InferOps board ${projectKey}`,
      snippet: `Board of InferOps project ${projectKey} on ${host}: read issues and propose moves.`,
      suggestedBindingName: "INFEROPS_BOARD",
      tsType: "InferOpsProjectSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every transition waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsProjectSession> {
    return new ProjectSessionImpl(this.#binding(), approvalQueue.dup());
  }

  /** Strategy B: the binding is one project, so admit an observer who can open that project. */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const { host, projectKey, workspaceId } = this.ctx.props;
    const verifier = user as unknown as Fetcher<InferOpsVerifierApi>;
    if (!(await verifier.hasProjectAccess(host, projectKey, workspaceId))) {
      throw new Error(
        `This collaborator cannot open InferOps project ${projectKey}, so they cannot observe ` +
        `data the Gadget read from its board.`);
    }
  }

  /** Nothing is tracked per observer under strategy B. */
  async removeObserver(_id: string): Promise<void> {}

  /** `cache` is unused: transitions involve no git objects. */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
    if (record.status === "applied") return;
    if (record.status !== "pending") throw new Error(`InferOps action ${actionId} was reverted.`);
    try {
      await binding.client.transition(
        binding.projectKey, record.issueId, record.toStateId, record.expectedRevision,
        binding.idempotencyKey(actionId));
    } catch (error) {
      const code = inferOpsErrorCode(error);
      logger.warn("transition failed", {
        event: "transition.apply.failed", projectKey: binding.projectKey, action: actionId,
        code: code ?? "UNKNOWN", error,
      });
      throw new Error(applyFailureMessage(record, code), { cause: error });
    }
    binding.putAction({ ...record, status: "applied" });
    logger.info("transition applied", {
      event: "transition.applied", projectKey: binding.projectKey, action: actionId,
    });
  }

  /** Forget the pending move; reads stop simulating it at once, so no restart is needed. */
  async rejectAction(actionId: number): Promise<void> {
    const binding = this.#binding();
    if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
  }

  /**
   * Move the issue back to the state it left, provided nothing has moved it since. The data source
   * checks the current revision again, so a concurrent change makes this fail rather than clobber.
   */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record || record.status !== "applied") {
      return { message: "This move was never applied, so there is nothing to revert." };
    }
    let current: Issue;
    try {
      current = await binding.client.readIssue(binding.projectKey, record.issueId);
    } catch (error) {
      if (inferOpsErrorCode(error) !== "NOT_FOUND") throw error;
      return { message: `${record.identifier} is no longer in project ${binding.projectKey}.` };
    }
    if (current.stateId !== record.toStateId) {
      return {
        message: `${record.identifier} has moved again since this change, so it was not moved ` +
          `back. Move it in InferOps if needed.`,
      };
    }
    await binding.client.transition(
      binding.projectKey, record.issueId, record.fromStateId, current.revision,
      binding.idempotencyKey(actionId, ":revert"));
    binding.putAction({ ...record, status: "reverted" });
  }
}

function applyFailureMessage(record: ActionRecord, code: string | null): string {
  const what = `${record.identifier} → ${record.toStateName}`;
  switch (code) {
    case "STALE_REVISION":
      return `${what} was not applied: the issue changed in InferOps after this move was ` +
        `proposed (expected revision ${record.expectedRevision}). Discard this move and read the ` +
        `board again.`;
    case "WORKFLOW_MISMATCH":
    case "INVALID_STATE":
      return `${what} was not applied: the target state is no longer valid for this issue.`;
    case "NOT_FOUND":
      return `${what} was not applied: the issue or its target state is no longer in this project.`;
    case "CONFLICT":
      return `${what} was not applied: InferOps refused the move in the issue's current ` +
        `condition. Read the board again.`;
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return `${what} was not applied: InferOps no longer accepts this connection's access.`;
    case "DISABLED":
      return `${what} was not applied: InferOps is turned off for this deployment. It can be ` +
        `applied once InferOps is turned back on.`;
    default:
      return `${what} could not be applied. Try again later.`;
  }
}

// ---------------------------------------------------------------------------
// Sessions

const REVISION = /^\d+$/;

// Errors the caller branches on carry the documented code first, as the data source's do.
function fail(code: "NOT_FOUND" | "STALE_REVISION" | "WORKFLOW_MISMATCH" | "INVALID_STATE" |
    "INVALID_REQUEST" | "CONFLICT", detail: string): never {
  throw new InferOpsError(code, detail);
}

/** Rethrow a data-source "not found" for an issue without saying which way it was not found. */
function hideIssueExistence(error: unknown): never {
  if (inferOpsErrorCode(error) === "NOT_FOUND") fail("NOT_FOUND", "No such issue in this project.");
  throw error;
}

@validateRpc()
class ProjectSessionImpl extends RpcTarget implements InferOpsProjectSession {
  #binding: ProjectBinding;
  #queue: RpcStub<ApprovalQueue>;

  constructor(binding: ProjectBinding, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#binding = binding;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async readBoard(): Promise<Board> {
    const board = await this.#binding.board();
    const issues = board.columns.reduce((sum, column) => sum + column.issues.length, 0);
    await this.#queue.authorizeObservation({
      title: `Read InferOps board ${board.project.identifier}`,
      description:
        `Read the board of project ${board.project.identifier}: ${issues} issues in ` +
        `${board.columns.length} states.`,
    });
    return board;
  }

  /**
   * Not an observation: issue ids are random UUIDs, so confirming one exists tells the caller
   * nothing it did not already hold. The issue session's reads are logged instead.
   */
  async openIssue(issueId: string): Promise<InferOpsIssueSession> {
    await this.#binding.client.readIssue(this.#binding.projectKey, issueId)
      .catch(hideIssueExistence);
    return new IssueSessionImpl(this.#binding, this.#queue.dup(), issueId);
  }
}

@validateRpc()
class IssueSessionImpl extends RpcTarget implements InferOpsIssueSession {
  #binding: ProjectBinding;
  #queue: RpcStub<ApprovalQueue>;
  #issueId: string;

  constructor(binding: ProjectBinding, queue: RpcStub<ApprovalQueue>, issueId: string) {
    super();
    this.#binding = binding;
    this.#queue = queue;
    this.#issueId = issueId;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async read(): Promise<Issue> {
    const issue = await this.#binding.issue(this.#issueId).catch(hideIssueExistence);
    await this.#queue.authorizeObservation({
      title: `Read InferOps issue ${issue.identifier}`,
      description: `Read issue ${issue.identifier} of project ${this.#binding.projectKey}.`,
    });
    return issue;
  }

  async transition(toStateId: string, expectedRevision: Revision): Promise<void> {
    if (!REVISION.test(expectedRevision)) {
      fail("INVALID_REQUEST", "expectedRevision must be the decimal string returned by read().");
    }
    const binding = this.#binding;
    const snapshot = await binding.client.readProject(binding.projectKey);
    const stored = snapshot.issues.find(i => i.id === this.#issueId);
    if (!stored) fail("NOT_FOUND", "No such issue in this project.");
    const pending = binding.pending();
    const issue = simulateIssue(stored, pending);

    const target = snapshot.states.find(s => s.id === toStateId);
    if (!target) fail("INVALID_STATE", `The target state is not part of project ${binding.projectKey}.`);
    if (target.workflow !== issue.workflow) {
      fail("WORKFLOW_MISMATCH",
        `${issue.identifier} is a ${issue.workflow} issue; "${target.name}" is a ${target.workflow} state.`);
    }
    if (issue.revision !== expectedRevision) {
      fail("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${expectedRevision}. Read it again.`);
    }
    if (issue.stateId === toStateId) return;
    // The revision a move produces is not knowable in advance, so moves cannot be chained.
    if (livePendingMove(stored, pending)) {
      fail("CONFLICT",
        `${issue.identifier} already has a move that has not taken effect yet. Wait for it, then ` +
        `read the issue again.`);
    }

    const from = snapshot.states.find(s => s.id === issue.stateId);
    const actionId = binding.stage({
      issueId: issue.id,
      identifier: issue.identifier,
      fromStateId: issue.stateId,
      toStateId,
      toStateName: target.name,
      expectedRevision,
    });
    const rendered = buildDescription(
      `Move an issue of InferOps project ${binding.projectKey} to another workflow state. It is ` +
      `applied only if the issue is still at the revision below when approved.`)
      .inline("Issue", issue.identifier)
      .inline("Title", issue.title)
      .inline("From", from?.name ?? issue.stateId)
      .inline("To", target.name)
      .inline("Expected revision", expectedRevision)
      .finish();
    try {
      await this.#queue.submitAction(actionId, {
        title: sanitizeTitle(`Move ${issue.identifier} to ${target.name}`),
        ...rendered,
        implementsRevert: true,
      });
    } catch (error) {
      // Not submitted (unless an auto-approval already applied it), so stop simulating it.
      if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
      throw error;
    }
  }
}

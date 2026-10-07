// InferOps gatekeeper: scoped project-board reads and approved issue creates, updates and
// transitions.
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
// - Sessions: `InferOpsProjectSession` reads the board, proposes new issues and narrows to one
//   issue with `openIssue`; `InferOpsIssueSession` reads that issue and proposes transitions and
//   field updates.
// - Coding dispatch is a second, separate resource kind,
//   `inferops://<tenant>.<workspace>/project/dispatch/<KEY>`, bound by the same rules into an
//   `InferOpsDispatchGatekeeper` facet. A board binding cannot dispatch. `InferOpsDispatchSession`
//   lists repositories and runs (observations) and proposes dispatches and cancels (actions). It is
//   offered and served only while the deployment has `CODING_WORKBENCH_ENABLED` on
//   (coding-workbench.ts),
//   and only for repositories on the wrapper's allowlist (`CODING_WORKBENCH_REPOS`), checked before
//   any request at proposal and again at apply. InferOps itself requires `issue:delegate` of the
//   person, so a connection without it is refused at apply with FORBIDDEN.
// - The InferMind Wiki is a third kind, `inferops://<tenant>.<workspace>/knowledge/wiki`, bound into an
//   `InferOpsWikiGatekeeper` facet whose props fix the account, host and InferMind workspace id. The
//   workspace slug resolves only among the person's InferMind workspaces; one of their InferOps
//   workspaces is refused as having no Wiki. `InferOpsWikiSession` lists pages, reads the Wiki's
//   structure (root, pillars, Masters), and reads one page with its body, its sections, its
//   `[[target#tag]]` links and its embedded `inferops://` references, or as text by InferOps'
//   page-text contract (wiki.ts); references are never resolved. Section edits and page body edits
//   are approved actions. A section edit is checked at apply against the section's current version,
//   since InferOps' section PATCH has no expected version; a body edit is InferOps' own strict
//   compare-and-swap on the page version (see `InferOpsWikiGatekeeper.applyAction`). InferOps'
//   product gate and `knowledge:*` permissions apply to the person's token.
// - Every returned read is authorized as an observation. Every write is checked against the
//   simulated board, recorded with the exact request it will send and that request's fingerprint
//   (actions.ts), and submitted as an action; none is auto-approvable. Until it is decided, reads
//   overlay it (simulation.ts), and a second move or update of the same issue is refused. Applying
//   recomputes the fingerprint and refuses a mismatch, then calls the data source with this facet's
//   id plus the action id as the idempotency key, which also rechecks scope, state, workflow and
//   the expected revision against current data. Rejecting deletes the record, which ends the
//   simulation.
// - Reverts: a transition moves back while the issue is still in the state it moved to; an update
//   restores the previous title and priority while the issue is still at the revision the update
//   produced and still shows its values; an update that changed the description, and every create,
//   cannot be reverted (InferOS never reads the description, and InferOps has no issue delete).
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
import { buildDescription, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ActionApplyFailure, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GitCache,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import {
  CredentialSource, isCredentialsChanged, isCredentialsExpired,
} from "@gadgets/gatekeeper-kit/credentials";
import {
  InferOpsError, atStage, inferOpsErrorCode, isPolicyRefusal, writeStage, type InferOpsClient,
  type ProjectSummary, type RunRecord, type WikiDocumentHead, type WriteStage,
} from "./inferops-client";
import {
  BOARD_WRITES, CheckRefused, RECONCILE_ONLY, classifyAttempt, type ApplyPolicy,
} from "./apply-attempts";
import {
  WIKI_FORBIDDEN, connectionFromEnv, openHttpInferOpsClient, type InferOpsAuthority,
  type InferOpsEndpoint,
} from "./http-inferops";
import { MockInferOps, openInferOpsClient } from "./mock-inferops";
import { assertInferOpsEnabled, whileInferOpsEnabled } from "./enablement";
import {
  assertCodingWorkbenchEnabled, assertRepoAllowlisted, codingRepoAllowlist, codingWorkbenchEnabled,
  whileCodingWorkbenchEnabled,
} from "./coding-workbench";
import { InferOpsCredentials, type InferOpsWorkspace } from "./inferops-credentials";
import {
  InferLabLogin, handleInferLabLogin, inferLabAuthOrigin, inferOpsApiEndpoint, startInferLabLogin,
} from "./inferlab-login";
import {
  DEMO_HOST, KNOWLEDGE_WIKI_RESOURCE, PROJECT_BOARD_RESOURCE, PROJECT_DISPATCH_RESOURCE,
  parseHost, parseProjectBoardUrl, parseProjectDispatchUrl, parseWikiUrl,
  projectBoardUrl, projectDispatchUrl, resourceKind, wikiUrl,
} from "./resources";
import {
  buildBoard, livePendingChange, orderStates, simulateIssue, type Pending,
} from "./simulation";
import {
  fingerprintOf, isCodingAction, isIssueChange, isWikiAction, matchesFingerprint, readAction,
  type ActionRecord, type CancelRunAction, type CreateAction, type DispatchAction,
  type DocumentUpdateAction, type SectionUpdateAction, type StagedAction, type StoredFailure,
  type UpdateAction, type WikiAction,
} from "./actions";
import {
  authoredContent, composeDocumentText, embeddedReferences, masterStructureText, wikilinksOf,
} from "./wiki";
import {
  MAX_DISCOVERY_QUERY_LENGTH, MAX_DISCOVERY_SCANNED_PROJECTS, rankBoards, type DiscoveryProject,
  type DiscoveryWorkspace,
} from "./board-discovery";
import type { InferOpsProjectConfiguratorRpc } from "./configurator/project-configurator-types";
import type {
  Board, BoardCandidate, DispatchTarget, InferOpsDispatchSession, InferOpsIssueSession, InferOpsProjectSession,
  InferOpsWikiSession, Issue, IssueChanges, NewIssue, Repo, Revision, Run, WikiDocument,
  WikiDocumentNode, WikiSection, WikiStructure,
} from "./types";
import type { NewIssueRequest, WikiSectionRecord } from "./inferops-client";
import TYPES_CODE from "./types.txt";
import PROJECT_CONFIGURATOR_HTML from "./generated/project-ui.txt";
import DISPATCH_CONFIGURATOR_HTML from "./generated/dispatch-ui.txt";
import WIKI_CONFIGURATOR_HTML from "./generated/wiki-ui.txt";

export { InferLabLogin, InferOpsCredentials, MockInferOps };

const VENDOR_ID = "inferops";

type LogFields = {
  vendorId: string; projectKey: string; host: string; action: number; code: string;
  /** What a failed apply proves: `notApplied` or `unknown`. */
  outcome: string;
};
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

/**
 * One Wiki binding, fixed when the Workshop mints it: the workspace's `host` and, for a connected
 * account, the InferMind workspace its slug resolved to.
 */
type WikiGatekeeperProps = AccountRef & { host: string; workspaceId?: string };

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
      let sent = false;
      try {
        // Every InferOps call here is safe to repeat: reads, or a write under its own
        // idempotency key.
        return await source.run(authority => {
          sent = true;
          return operation(authority);
        }, { replayable: true });
      } catch (error) {
        if (isCredentialsExpired(error)) {
          // Confirmed dead before InferOps processed anything: either no credential was ever
          // handed to the request (unsent), or InferOps answered every send 401 (refused). A
          // changed credential below proves nothing.
          throw new InferOpsError("UNAUTHORIZED", (error as Error).message,
                                  { stage: sent ? "refused" : "unsent" });
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

/**
 * The data source for a coding-dispatch binding: the same source as `clientFor`, refused with
 * `DISABLED` on every call while InferOps or coding dispatch is off.
 */
function codingClientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  return whileCodingWorkbenchEnabled(env, () => openClientFor(env, exports, account, host, workspaceId));
}

/** The resource kinds offered now: coding dispatch only while the deployment has it on. */
function supportedResources(env: Cloudflare.Env): SupportedResource[] {
  return codingWorkbenchEnabled(env)
    ? [PROJECT_BOARD_RESOURCE, PROJECT_DISPATCH_RESOURCE, KNOWLEDGE_WIKI_RESOURCE]
    : [PROJECT_BOARD_RESOURCE, KNOWLEDGE_WIKI_RESOURCE];
}

/** The message every refused Wiki binding gets, whatever was missing: workspace or host. */
function unavailableWiki(host: string): string {
  return `No InferMind Wiki is available on ${host}.`;
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
      tagline: "Read project boards and the InferMind Wiki, and propose changes",
      description:
        "Gives Gadgets access to one InferOps project board at a time: read its issues and " +
        "propose creating issues, editing them and moving them between workflow states, each " +
        "change approved by you. It can also read a workspace's InferMind Wiki and propose " +
        "section edits, approved the same way. " +
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
    return supportedResources(this.env);
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
    return supportedResources(this.env);
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

  /**
   * The InferMind workspace a Wiki URL's host names for this account, as `#workspaceFor` does for
   * boards. A workspace the person holds that is an InferOps one (no InferMind, so no Wiki) is
   * refused with FORBIDDEN saying so, before any request; it is their own, so nothing is disclosed.
   */
  async #wikiWorkspaceFor(host: string): Promise<string | null | undefined> {
    if (host === DEMO_HOST || !this.ctx.props.connected) return undefined;
    const labels = parseHost(host);
    if (!labels) return null;
    const store = this.#credentials();
    const workspaceId = await store.resolveWorkspace(labels.workspace, "infermind");
    if (workspaceId === null && await store.resolveWorkspace(labels.workspace, "inferops") !== null) {
      throw new InferOpsError("FORBIDDEN",
        `${host} is an InferOps workspace without InferMind, so it has no Wiki.`);
    }
    return workspaceId;
  }

  /**
   * Whether the Wiki of `host` is available to this account: false for a workspace it lacks or a
   * host no data source serves. InferOps' refusal (no InferMind, no knowledge permission) is
   * passed on as the FORBIDDEN it is, so the person learns why.
   */
  async #hasWiki(host: string, workspaceId: string | null | undefined): Promise<boolean> {
    if (workspaceId === null) return false;
    try {
      await this.#client(host, workspaceId).listDocuments();
      return true;
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") return false;
      throw error;
    }
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
   * Bind one project board, or one project's coding dispatch. The URL only names the target: its
   * workspace slug must be one of the person's own, the project must exist there for this account,
   * and the resulting class carries the account, host, key and (for a connected account) workspace
   * id in its props, which is the only place the gatekeeper ever reads its scope from. A workspace
   * the person lacks, an unknown host and a missing project are refused with one message, so a URL
   * cannot probe for any of them. A dispatch binding is refused while coding dispatch is off.
   * `mock` reports the demo host, whose data is the built-in mock's, never an InferOps tenant's.
   */
  @skipRpcValidation()
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    assertInferOpsEnabled(this.env);
    const kind = resourceKind(url);
    if (kind === "wiki") return this.#wikiClassFor(url);
    const dispatch = kind === "dispatch";
    if (dispatch) assertCodingWorkbenchEnabled(this.env);
    const { host, projectKey } = dispatch ? parseProjectDispatchUrl(url) : parseProjectBoardUrl(url);
    const workspaceId = await this.#workspaceFor(host);
    if (!(await this.#hasProject(host, workspaceId, projectKey))) {
      throw new Error(unavailableProject(projectKey, host));
    }
    const { accountId, connected } = this.ctx.props;
    const props: ProjectGatekeeperProps = {
      accountId, connected, host, projectKey, workspaceId: workspaceId ?? undefined,
    };
    const mock = host === DEMO_HOST;
    return dispatch
      ? { class: this.ctx.exports.InferOpsDispatchGatekeeper({ props }), resource: PROJECT_DISPATCH_RESOURCE, mock }
      : { class: this.ctx.exports.InferOpsProjectGatekeeper({ props }), resource: PROJECT_BOARD_RESOURCE, mock };
  }

  /**
   * Bind one workspace's Wiki: the URL's workspace slug must be one of the person's InferMind
   * workspaces and the Wiki must answer for this account. A workspace the person lacks and a host no
   * data source serves are refused with one message; an InferOps workspace without InferMind, and
   * InferOps' own refusal, with the FORBIDDEN that says why.
   */
  async #wikiClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    const { host } = parseWikiUrl(url);
    const workspaceId = await this.#wikiWorkspaceFor(host);
    if (!(await this.#hasWiki(host, workspaceId))) throw new Error(unavailableWiki(host));
    const { accountId, connected } = this.ctx.props;
    const props: WikiGatekeeperProps = { accountId, connected, host, workspaceId: workspaceId ?? undefined };
    return {
      class: this.ctx.exports.InferOpsWikiGatekeeper({ props }), resource: KNOWLEDGE_WIKI_RESOURCE,
      mock: host === DEMO_HOST,
    };
  }

  @skipRpcValidation()
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const wiki = resourceUrlPattern === KNOWLEDGE_WIKI_RESOURCE.urlPattern;
    const iframeHtml = resourceUrlPattern === PROJECT_BOARD_RESOURCE.urlPattern
      ? PROJECT_CONFIGURATOR_HTML
      : resourceUrlPattern === PROJECT_DISPATCH_RESOURCE.urlPattern && codingWorkbenchEnabled(this.env)
        ? DISPATCH_CONFIGURATOR_HTML
        : wiki ? WIKI_CONFIGURATOR_HTML : null;
    if (!iframeHtml) {
      throw new Error(`Unsupported InferOps resource configurator type: ${resourceUrlPattern}`);
    }
    const store = this.ctx.props.connected ? this.#credentials() : null;
    const stopgap = store ? null : connectionFromEnv(this.env);
    return {
      iframeHtml,
      ui: new RpcStub(new InferOpsProjectConfiguratorUI({
        // Demo data needs no organization or workspace; every other account must name both.
        defaultHost: store || stopgap ? null : DEMO_HOST,
        // The Wiki picker offers InferMind workspaces, the project pickers InferOps ones.
        workspaces: async () => store
          ? ((await store.identity())?.workspaces ?? [])
            .filter(w => (w.product === "infermind") === wiki)
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
  /** Whether this account can read the Wiki, in the binding's workspace when it names one. */
  hasWikiAccess(host: string, workspaceId?: string): Promise<boolean>;
}

/** Whether a verifier's check failed as "no access" rather than as a failure to report. */
function deniesAccess(error: unknown): boolean {
  const code = inferOpsErrorCode(error);
  if (code === "NOT_FOUND" || code === "UNAUTHORIZED" || code === "FORBIDDEN") return true;
  return error instanceof Error && error.message.includes("not a member");
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
      if (deniesAccess(error)) return false;
      throw error;
    }
  }

  async hasWikiAccess(host: string, workspaceId?: string): Promise<boolean> {
    try {
      // The observer's own token in the binding's workspace; InferOps' product gate and their
      // knowledge:read decide, as they do for the owner.
      await clientFor(this.env, this.ctx.exports, this.ctx.props, host, workspaceId).listDocuments();
      return true;
    } catch (error) {
      if (deniesAccess(error)) return false;
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

const ACTION_PREFIX = "action:";
/** Observers admitted to a board binding, so its search results can be kept from them. */
const OBSERVER_PREFIX = "observer:";
const NEXT_ACTION_KEY = "nextActionId";
const INSTANCE_KEY = "instanceId";

/**
 * A facet's action store and data source: the parts every kind of binding shares. `scope` keys the
 * fingerprints: the bound project's key, or `knowledge/wiki`.
 */
class ActionBinding<P> {
  constructor(
    readonly ctx: DurableObjectState<P>,
    readonly client: InferOpsClient,
    readonly scope: string,
  ) {}

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

  /** A recorded action; a record from before creates and updates reads as a transition. */
  action(actionId: number): ActionRecord | undefined {
    return readAction(this.kv.get(ACTION_PREFIX + actionId));
  }

  putAction(record: ActionRecord): void {
    this.kv.put(ACTION_PREFIX + record.actionId, record);
  }

  deleteAction(actionId: number): void {
    this.kv.delete(ACTION_PREFIX + actionId);
  }

  /**
   * Record a pending action, with the fingerprint of the request it will send, before it is
   * submitted, so an immediate apply can find it.
   */
  async stage(staged: StagedAction, guard?: () => void): Promise<number> {
    return (await this.stageOnce(staged, false, guard)).actionId;
  }

  /**
   * Like `stage`, but when `join` is set, a pending action whose request has the same fingerprint
   * is returned instead (`joined`), and nothing new is staged. The lookup and the write happen in
   * one synchronous step after the fingerprint is computed, so two concurrent proposals of one
   * request (two tabs) cannot both stage it. `guard`, when given, runs in that same synchronous
   * step, before anything is written, so a check of other pending actions (one edit per target)
   * cannot be overtaken by a concurrent proposal; it throws to refuse.
   */
  async stageOnce(staged: StagedAction, join = true, guard?: () => void): Promise<{ actionId: number; joined: boolean }> {
    const fingerprint = await fingerprintOf(this.scope, staged);
    guard?.();
    if (join) {
      for (const [, raw] of this.kv.list({ prefix: ACTION_PREFIX })) {
        const record = readAction(raw);
        if (record?.status === "pending" && record.fingerprint === fingerprint) {
          return { actionId: record.actionId, joined: true };
        }
      }
    }
    const actionId = this.kv.get<number>(NEXT_ACTION_KEY) ?? 1;
    this.kv.put(NEXT_ACTION_KEY, actionId + 1);
    this.putAction({ ...staged, actionId, status: "pending", fingerprint, attempts: {} } as ActionRecord);
    return { actionId, joined: false };
  }

  /**
   * Apply a pending or failed `record` once, keeping what each attempt proves (apply-attempts.ts):
   *
   * - a `failed` record replays its stored refusal, and a reconcile-only record that an earlier
   *   attempt may have sent (or with no attempt history) returns its stored unknown; neither sends;
   * - otherwise `check` runs (a throw refuses the apply unsent), the record is marked dispatched,
   *   and `send` makes the write and returns the applied record.
   *
   * The applied record is stored outside the failure handling, so a storage error after InferOps
   * took the write propagates as itself, never as a refusal. Returns the failure to report, or
   * nothing once applied.
   */
  async applyOnce(record: ActionRecord, options: {
    policy: ApplyPolicy;
    fields: Partial<LogFields>;
    check?: () => Promise<void> | void;
    send: (marked: ActionRecord) => Promise<ActionRecord>;
  }): Promise<void | { failed: ActionApplyFailure }> {
    const { policy, fields } = options;
    if (record.status === "failed") {
      const stored = record.attempts?.failure;
      return { failed: {
        outcome: "notApplied", retryable: false,
        message: stored?.message ?? applyFailureMessage(record, null),
        ...(stored?.code !== undefined ? { code: stored.code } : {}),
      } };
    }
    const earlierUncertain = record.attempts === undefined || record.attempts.dispatchedAt !== undefined;
    if (earlierUncertain && !policy.replayable) {
      logger.warn(`${record.kind} not sent again`, { event: `${record.kind}.apply.reconcile_only`, ...fields });
      const stored = record.attempts?.failure;
      return { failed: {
        outcome: "unknown", retryable: false,
        message: stored?.message ?? reconcileOnlyMessage(record),
        ...(stored?.code !== undefined ? { code: stored.code } : {}),
      } };
    }
    let marked: ActionRecord | undefined;
    let applied: ActionRecord;
    try {
      await options.check?.();
      marked = this.markDispatched(record);
      applied = await options.send(marked);
    } catch (error) {
      return { failed: this.#settle(marked ?? record, marked ? error : atStage(error, "unsent"),
                                    earlierUncertain, options) };
    }
    this.putAction(applied);
    logger.info(`${record.kind} applied`, { event: `${record.kind}.applied`, ...fields });
  }

  /** Store that `record`'s write is about to be sent, before it is (see `ApplyAttempts`). */
  markDispatched(record: ActionRecord): ActionRecord {
    const dispatchedAt = record.attempts?.dispatchedAt ?? new Date().toISOString();
    const marked = { ...record, attempts: { ...record.attempts, dispatchedAt } };
    this.putAction(marked);
    return marked;
  }

  /** Store and return what a failed attempt of `record` proves; see `applyOnce`. */
  #settle(record: ActionRecord, error: unknown, earlierUncertain: boolean,
          options: { policy: ApplyPolicy; fields: Partial<LogFields> }): ActionApplyFailure {
    const code = inferOpsErrorCode(error);
    const stage = writeStage(error);
    const { outcome, retryable } = classifyAttempt(
      { code, stage, policy: isPolicyRefusal(error) }, earlierUncertain, options.policy);
    const message = outcome === "notApplied"
      ? error instanceof CheckRefused ? error.reason : applyFailureMessage(record, code)
      : uncertainMessage(record, code, stage, earlierUncertain, retryable && options.policy.replayable);
    const failure: StoredFailure = { outcome, message, ...(code !== null ? { code } : {}) };
    if (outcome === "notApplied") {
      // No earlier attempt may have been sent, so any mark is this attempt's, and it proved unsent.
      this.putAction(retryable
        ? { ...record, attempts: {} }
        : { ...record, status: "failed", attempts: { failure } });
    } else {
      const dispatchedAt = record.attempts?.dispatchedAt ?? new Date().toISOString();
      this.putAction({ ...record, attempts: { dispatchedAt, failure } });
    }
    logger.warn(`${record.kind} failed`, {
      event: `${record.kind}.apply.failed`, ...options.fields, code: code ?? "UNKNOWN", outcome, error,
    });
    return { ...failure, retryable };
  }

  /** Submit a staged action; if it was not submitted, forget it so it is no longer simulated. */
  async submit(queue: RpcStub<ApprovalQueue>, actionId: number,
               description: Parameters<ApprovalQueue["submitAction"]>[1]): Promise<void> {
    try {
      await queue.submitAction(actionId, description);
    } catch (error) {
      // Not submitted (unless an auto-approval already applied it), so stop simulating it.
      if (this.action(actionId)?.status === "pending") this.deleteAction(actionId);
      throw error;
    }
  }
}

/** A project binding (board or coding dispatch): the bound project and its simulated board. */
/** One InferOps workspace `findBoards` searches: its host and a data source in it. */
type DiscoverySource = { host: string; client: InferOpsClient };

class ProjectBinding extends ActionBinding<ProjectGatekeeperProps> {
  /**
   * `otherWorkspaces` lists the person's other InferOps workspaces for `findBoards`, each with a
   * data source as the same person; omitted where there is no person to list them for.
   */
  constructor(ctx: DurableObjectState<ProjectGatekeeperProps>, client: InferOpsClient,
              readonly otherWorkspaces: () => Promise<DiscoverySource[]> = async () => []) {
    super(ctx, client, ctx.props.projectKey);
  }

  get projectKey(): string {
    return this.ctx.props.projectKey;
  }

  pending(): Pending {
    const changes: Pending["changes"][number][] = [];
    const creates: CreateAction[] = [];
    for (const [, raw] of this.kv.list({ prefix: ACTION_PREFIX })) {
      const record = readAction(raw);
      if (record?.status !== "pending") continue;
      if (isIssueChange(record)) changes.push(record);
      else if (record.kind === "create") creates.push(record);
    }
    return { changes, creates };
  }

  /** The pending actions of a coding-dispatch binding. */
  codingPending(): { dispatches: DispatchAction[]; cancels: CancelRunAction[] } {
    const dispatches: DispatchAction[] = [];
    const cancels: CancelRunAction[] = [];
    for (const [, raw] of this.kv.list({ prefix: ACTION_PREFIX })) {
      const record = readAction(raw);
      if (record?.status !== "pending") continue;
      if (record.kind === "dispatch") dispatches.push(record);
      else if (record.kind === "cancel") cancels.push(record);
    }
    return { dispatches, cancels };
  }

  async board(): Promise<Board> {
    return buildBoard(await this.client.readProject(this.projectKey), this.pending());
  }

  async issue(issueId: string): Promise<Issue> {
    return simulateIssue(await this.client.readIssue(this.projectKey, issueId), this.pending().changes);
  }
}

@validateRpc()
export class InferOpsProjectGatekeeper
    extends DurableObject<Cloudflare.Env, ProjectGatekeeperProps>
    implements Gatekeeper<InferOpsProjectSession> {
  #binding(): ProjectBinding {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    const account = { accountId, connected };
    return new ProjectBinding(
      this.ctx, clientFor(this.env, this.ctx.exports, account, host, workspaceId),
      () => this.#otherWorkspaces());
  }

  /**
   * A connected person's other InferOps workspaces, for `findBoards`: those InferLab reported at
   * connect time with a slug, each read with the person's own token in that workspace (the
   * credentials object refuses any workspace that is not theirs). The tenant label is the binding's,
   * since a person's workspaces share one tenant. The stopgap connection and the demo serve one
   * workspace, so they search only the binding's.
   */
  async #otherWorkspaces(): Promise<DiscoverySource[]> {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    const tenant = parseHost(host)?.tenant;
    if (!connected || host === DEMO_HOST || !tenant) return [];
    const identity = await credentialsOf(this.ctx.exports, accountId).identity();
    return (identity?.workspaces ?? []).flatMap(workspace => {
      if (workspace.product === "infermind" || !workspace.workspaceSlug ||
          workspace.workspaceId === workspaceId) {
        return [];
      }
      const other = `${tenant}.${workspace.workspaceSlug}`;
      if (!parseHost(other)) return [];
      return [{
        host: other,
        client: clientFor(this.env, this.ctx.exports, { accountId, connected }, other, workspace.workspaceId),
      }];
    });
  }

  async describe(): Promise<ResourceDescription> {
    const { host, projectKey } = this.ctx.props;
    return {
      url: projectBoardUrl({ host, projectKey }),
      title: `InferOps board ${projectKey}`,
      snippet: `Board of InferOps project ${projectKey} on ${host}: read issues and propose ` +
        `creating, editing and moving them.`,
      suggestedBindingName: "INFEROPS_BOARD",
      tsType: "InferOpsProjectSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every write waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsProjectSession> {
    return new ProjectSessionImpl(this.#binding(), approvalQueue.dup());
  }

  /**
   * Strategy B: the binding is one project, so admit an observer who can open that project. The
   * observer is remembered only so `findBoards` can exclude them: its results name other projects,
   * which admitting them for this one does not cover.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await admitProjectObserver(this.ctx.props, user);
    this.ctx.storage.kv.put(OBSERVER_PREFIX + id, true);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(OBSERVER_PREFIX + id);
  }

  /**
   * Send the recorded request under the action's idempotency key, so a repeated apply (or one
   * whose response was lost) is answered by InferOps without writing twice. The fingerprint staged
   * with the action must still match the request, or nothing is sent. A failure is returned with
   * what it proves (apply-attempts.ts): a first attempt InferOps refused, or one that failed before
   * sending, is known not applied, and a refusal that will stand ends the action `failed` and
   * no longer simulated; anything after an attempt that may have reached InferOps is unknown.
   * `cache` is unused: no git objects are involved.
   */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
    if (record.status === "applied") return;
    if (record.status === "reverted") throw new Error(`InferOps action ${actionId} was reverted.`);
    if (isCodingAction(record) || isWikiAction(record)) {
      throw new Error(`InferOps action ${actionId} is not a board action.`);
    }
    const fields = { projectKey: binding.projectKey, action: actionId };
    const key = binding.idempotencyKey(actionId);
    return binding.applyOnce(record, {
      policy: BOARD_WRITES, fields,
      check: () => assertFingerprint(binding.projectKey, record, fields),
      async send(marked) {
        switch (record.kind) {
          case "transition":
            await binding.client.transition(
              binding.projectKey, record.issueId, record.toStateId, record.expectedRevision, key);
            return { ...marked, status: "applied" };
          case "create": {
            const created = await binding.client.createIssue(binding.projectKey, record.issue, key);
            return { ...marked, status: "applied", createdIdentifier: created.identifier } as ActionRecord;
          }
          case "update": {
            const updated = await binding.client.updateIssue(
              binding.projectKey, record.issueId, record.changes, record.expectedRevision, key);
            return { ...marked, status: "applied", appliedRevision: updated.revision } as ActionRecord;
          }
        }
      },
    });
  }

  /** Forget the pending action; reads stop simulating it at once, so no restart is needed. */
  async rejectAction(actionId: number): Promise<void> {
    const binding = this.#binding();
    if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
  }

  /**
   * Undo an applied move or title/priority update, provided nothing has changed the issue since.
   * The data source checks the current revision again, so a concurrent change makes this fail
   * rather than clobber. Creates, and updates that changed the description, are submitted as not
   * revertible.
   */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record || record.status !== "applied") {
      return { message: "This change was never applied, so there is nothing to revert." };
    }
    if (isCodingAction(record) || isWikiAction(record)) return { message: "This is not a board action." };
    if (record.kind === "create") {
      return {
        message: `Creating ${record.createdIdentifier ?? "an issue"} cannot be undone here. ` +
          `Cancel it in InferOps if needed.`,
      };
    }
    if (record.kind === "update" && record.changes.description !== undefined) {
      return {
        message: `This change to ${record.identifier} replaced its description, which cannot be ` +
          `restored here. Edit it in InferOps if needed.`,
      };
    }
    let current: Issue;
    try {
      current = await binding.client.readIssue(binding.projectKey, record.issueId);
    } catch (error) {
      if (inferOpsErrorCode(error) !== "NOT_FOUND") throw error;
      return { message: `${record.identifier} is no longer in project ${binding.projectKey}.` };
    }
    const revertKey = binding.idempotencyKey(actionId, ":revert");
    if (record.kind === "transition") {
      if (current.stateId !== record.toStateId) {
        return {
          message: `${record.identifier} has moved again since this change, so it was not moved ` +
            `back. Move it in InferOps if needed.`,
        };
      }
      await binding.client.transition(
        binding.projectKey, record.issueId, record.fromStateId, current.revision, revertKey);
    } else {
      if (!stillShowsUpdate(record, current)) {
        return {
          message: `${record.identifier} has changed again since this update, so its previous ` +
            `values were not restored. Edit it in InferOps if needed.`,
        };
      }
      await binding.client.updateIssue(
        binding.projectKey, record.issueId, record.previous, current.revision, revertKey);
    }
    binding.putAction({ ...record, status: "reverted" });
  }
}

/**
 * The titles of a project's open issues, for matching only; null when the board cannot be read
 * now, so the project is still matched on its key and name.
 */
async function openIssueTitles(client: InferOpsClient, projectKey: string): Promise<string[] | null> {
  try {
    const { states, issues } = await client.readProject(projectKey);
    const closed = new Set(states.filter(s => s.group === "completed" || s.group === "cancelled").map(s => s.id));
    return issues.filter(issue => !closed.has(issue.stateId)).map(issue => issue.title);
  } catch (error) {
    if (inferOpsErrorCode(error) === null) throw error;
    return null;
  }
}

/**
 * Observer strategy B, for both kinds of binding: a binding is one project, so a collaborator is
 * admitted when their own account can open that project in the binding's workspace.
 */
async function admitProjectObserver(props: ProjectGatekeeperProps,
                                    user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
  const { host, projectKey, workspaceId } = props;
  const verifier = user as unknown as Fetcher<InferOpsVerifierApi>;
  if (!(await verifier.hasProjectAccess(host, projectKey, workspaceId))) {
    throw new Error(
      `This collaborator cannot open InferOps project ${projectKey}, so they cannot observe ` +
      `data the Gadget read from it.`);
  }
}

/** Whether `current` is exactly what `update` left: its revision and the values it set. */
function stillShowsUpdate(update: UpdateAction, current: Issue): boolean {
  const { title, priority } = update.changes;
  return current.revision === update.appliedRevision &&
    (title === undefined || current.title === title) &&
    (priority === undefined || current.priority === priority);
}

/** What an action does, for its failure messages; untrusted titles are kept to one short line. */
function actionLabel(record: ActionRecord): string {
  switch (record.kind) {
    case "transition":
      return `${record.identifier} → ${record.toStateName}`;
    case "create":
      return `Creating "${plainInline(record.issue.title, 60)}"`;
    case "update":
      return `The update of ${record.identifier}`;
    case "dispatch":
      return `Dispatching ${record.identifier} to ${plainInline(record.repoSlug, 60)}`;
    case "cancel":
      return `Cancelling the run of ${record.identifier}`;
    case "section-update":
      return `The edit of section ${plainInline(record.tag, 60)} of "${plainInline(record.documentTitle, 60)}"`;
    case "document-update":
      return `The edit of page "${plainInline(record.documentTitle, 60)}"`;
  }
}

/**
 * Refuse, unsent, an apply whose request no longer matches the fingerprint staged with it. A
 * legacy record without one passes, unless `required`.
 */
async function assertFingerprint(scope: string, record: ActionRecord, fields: Partial<LogFields>,
                                 { required = false } = {}): Promise<void> {
  if (!(required && record.fingerprint === undefined) && await matchesFingerprint(scope, record)) return;
  logger.error("action no longer matches its fingerprint", {
    event: "action.fingerprint.mismatch", ...fields, code: "IDEMPOTENCY_CONFLICT",
  });
  throw new CheckRefused("IDEMPOTENCY_CONFLICT", applyFailureMessage(record, "IDEMPOTENCY_CONFLICT"));
}

/**
 * Why an apply's outcome is unknown, and what to do. `canResend` is whether approving it again
 * sends it under the same key.
 */
function uncertainMessage(record: ActionRecord, code: string | null, stage: WriteStage | undefined,
                          earlierUncertain: boolean, canResend: boolean): string {
  const what = actionLabel(record);
  const next = canResend
    ? "Approving it again resends it under the same idempotency key, which InferOps applies at most once."
    : isBoardAction(record)
      ? "Check it in InferOps before deciding again."
      : "It is not sent again from here: check it in InferOps, then reject it.";
  if (earlierUncertain && stage !== undefined) {
    const now = stage === "unsent" ? "this attempt was not sent" : `InferOps now refuses it (${code})`;
    return `${what} may already have been applied by an earlier attempt, whose outcome is unknown; ` +
      `${now}. ${next}`;
  }
  if (stage === "refused") {
    return `${what} may or may not have been applied: InferOps refused it (${code}), which is not ` +
      `yet taken as proof for this kind of change. ${next}`;
  }
  return `${what} may or may not have been applied: InferOps did not confirm the outcome` +
    `${code ? ` (${code})` : ""}. ${next}`;
}

/** Why a reconcile-only action an earlier attempt may have sent is not sent again. */
function reconcileOnlyMessage(record: ActionRecord): string {
  const what = actionLabel(record);
  const why = record.attempts === undefined
    ? "it was proposed before apply attempts were recorded, so an earlier approval may already " +
      "have reached InferOps"
    : "an earlier attempt was interrupted before InferOps answered";
  return `${what} may or may not have been applied: ${why}. It is not sent again from here: check ` +
    `it in InferOps, then reject it.`;
}

/** Whether an action belongs to a board binding. */
function isBoardAction(record: ActionRecord): boolean {
  return !isCodingAction(record) && !isWikiAction(record);
}

function applyFailureMessage(record: ActionRecord, code: string | null): string {
  const what = actionLabel(record);
  if (isCodingAction(record)) {
    const coding = codingFailureMessage(record, what, code);
    if (coding) return coding;
  }
  if (isWikiAction(record)) return wikiFailureMessage(record, what, code);
  const noun = {
    transition: "move", create: "issue", update: "update", dispatch: "dispatch", cancel: "cancel",
  }[record.kind];
  switch (code) {
    case "STALE_REVISION":
      return `${what} was not applied: the issue changed in InferOps after this ${noun} was ` +
        `proposed (expected revision ${"expectedRevision" in record ? record.expectedRevision : "?"}). ` +
        `Discard this ${noun} and read the board again.`;
    case "WORKFLOW_MISMATCH":
    case "INVALID_STATE":
      return `${what} was not applied: the target state is no longer valid for this issue.`;
    case "NOT_FOUND":
      return record.kind === "create"
        ? `${what} was not applied: its target state is no longer in this project.`
        : `${what} was not applied: the issue or its target state is no longer in this project.`;
    case "CONFLICT":
      return `${what} was not applied: InferOps refused it in the issue's current condition. ` +
        `Read the board again.`;
    case "INVALID_REQUEST":
      return `${what} was not applied: InferOps rejected the request as invalid.`;
    case "IDEMPOTENCY_CONFLICT":
      return `${what} was not applied: the stored request no longer matches the one proposed. ` +
        `Discard it and propose it again.`;
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return `${what} was not applied: InferOps does not permit it for this connection (its ` +
        `access or the workflow policy refused it).`;
    case "DISABLED":
      return `${what} was not applied: InferOps is turned off for this deployment. It can be ` +
        `applied once InferOps is turned back on.`;
    default:
      return `${what} could not be applied. Try again later.`;
  }
}

/** Why a Wiki section or page body edit was not applied. */
function wikiFailureMessage(record: WikiAction, what: string, code: string | null): string {
  const target = record.kind === "section-update" ? "section" : "page";
  switch (code) {
    case "STALE_REVISION":
      return `${what} was not applied: the ${target} changed in InferOps after this edit was ` +
        `proposed (expected version ${record.expectedVersion}). Discard this edit and read the page again.`;
    case "NOT_FOUND":
      return `${what} was not applied: the ${target} is no longer in this Wiki.`;
    case "IDEMPOTENCY_CONFLICT":
      return `${what} was not applied: the stored request no longer matches the one proposed. ` +
        `Discard it and propose it again.`;
    case "UNAUTHORIZED":
      return `${what} was not applied: InferOps rejected this connection's credential. Reconnect InferOps.`;
    case "FORBIDDEN":
      return `${what} was not applied: ${WIKI_FORBIDDEN}`;
    case "INVALID_REQUEST":
      return `${what} was not applied: InferOps rejected the request as invalid.`;
    case "DISABLED":
      return `${what} was not applied: InferOps is turned off for this deployment. It can be ` +
        `applied once InferOps is turned back on.`;
    default:
      return `${what} could not be applied. Try again later.`;
  }
}

/** The failure messages specific to dispatches and cancels; null falls back to the shared ones. */
function codingFailureMessage(record: DispatchAction | CancelRunAction, what: string,
                              code: string | null): string | null {
  switch (code) {
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return `${what} was not applied: your InferOps connection needs dispatch permission ` +
        `(issue:delegate) in InferOps for this workspace.`;
    case "RUN_ACTIVE":
      return `${what} was not applied: ${record.identifier} already has a queued or running run ` +
        `in InferOps. Follow it or cancel it first.`;
    case "DISABLED":
      return `${what} was not applied: coding dispatch is turned off for this deployment. It can ` +
        `be applied once it is turned back on.`;
    case "WORKFLOW_MISMATCH":
      return `${what} was not applied: only software issues can be coded.`;
    case "CONFLICT":
      return record.kind === "dispatch"
        ? `${what} was not applied: InferOps refused it in the issue's current condition (it is ` +
          `closed, or its lease is quarantined). Read the board again.`
        : `${what} was not applied: the run has already finished.`;
    case "INVALID_REQUEST":
      return record.kind === "dispatch"
        ? `${what} was not applied: InferOps rejected it (the repository may be disabled or no ` +
          `longer enrolled).`
        : null;
    case "NOT_FOUND":
      // InferOps answers a dispatch with the same 404 when the issue is gone and when the
      // project's workflow has no Queued state to move it to (older software workflows lack one).
      return record.kind === "dispatch"
        ? `${what} was not applied: InferOps found no issue to dispatch, or this project's ` +
          `workflow has no Queued state for coding runs. Read the board again; if the issue is ` +
          `still there, the project needs a software workflow with a Queued state.`
        : `${what} was not applied: the run is no longer in this project.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sessions

const REVISION = /^\d+$/;
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20_000;

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

/** A title trimmed as InferOps trims it, or INVALID_REQUEST when empty or too long. */
function validTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_TITLE) {
    fail("INVALID_REQUEST", `A title must be 1 to ${MAX_TITLE} characters.`);
  }
  return trimmed;
}

function checkDescription(description: string | null | undefined): void {
  if (description && description.length > MAX_DESCRIPTION) {
    fail("INVALID_REQUEST", `A description must be at most ${MAX_DESCRIPTION} characters.`);
  }
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
   * Ranks the projects the person's own token lists in this binding's workspace and, for a
   * connected person, in each of their other InferOps workspaces (see `rankBoards`). Only bindable
   * keys are candidates, and the issue titles read for matching never leave the gatekeeper. The
   * binding's own workspace must be readable; another one InferOps now refuses (membership removed
   * since connect) is left out rather than failing the search. The observation excludes every
   * observer of the binding, since they were admitted for its one project only, so a shared
   * workspace refuses the search.
   */
  async findBoards(query: string): Promise<BoardCandidate[]> {
    const text = query.trim();
    if (text.length === 0 || text.length > MAX_DISCOVERY_QUERY_LENGTH) {
      fail("INVALID_REQUEST", `A board search must be 1-${MAX_DISCOVERY_QUERY_LENGTH} characters.`);
    }
    const binding = this.#binding;
    const { host } = binding.ctx.props;
    if (host !== DEMO_HOST && !parseHost(host)) {
      fail("INVALID_REQUEST", "This connection's workspace cannot be searched.");
    }
    const sources = [{ host, client: binding.client }, ...await binding.otherWorkspaces()];
    const listed = await Promise.all(sources.map(async (source, index) => {
      try {
        return { source, projects: await source.client.listProjects() };
      } catch (error) {
        const code = inferOpsErrorCode(error);
        if (index > 0 && (code === "FORBIDDEN" || code === "NOT_FOUND")) return null;
        throw error;
      }
    }));
    let scanned = 0;
    const workspaces = await Promise.all(listed.flatMap(entry => entry ? [entry] : [])
      .map(async ({ source, projects }): Promise<DiscoveryWorkspace> => {
        const labels = source.host === DEMO_HOST
          ? { tenant: "demo", workspace: "local" } : parseHost(source.host)!;
        const boardRef = (projectKey: string) => projectBoardUrl({ host: source.host, projectKey });
        const bindable = projects.filter(project => {
          try {
            parseProjectBoardUrl(boardRef(project.identifier));
            return true;
          } catch {
            return false;
          }
        });
        const read = bindable.map(() => scanned++ < MAX_DISCOVERY_SCANNED_PROJECTS);
        return {
          scope: { ...labels, boardRef },
          projects: await Promise.all(bindable.map(async (project, index): Promise<DiscoveryProject> => ({
            identifier: project.identifier,
            name: project.name,
            openIssueTitles: read[index] ? await openIssueTitles(source.client, project.identifier) : null,
          }))),
        };
      }));
    const candidates = rankBoards(text, workspaces);
    const count = workspaces.reduce((sum, workspace) => sum + workspace.projects.length, 0);
    const others = workspaces.length - 1;
    const where = others > 0
      ? `${host} and ${others} other workspace${others === 1 ? "" : "s"}` : host;
    const observers = Array.from(binding.kv.list({ prefix: OBSERVER_PREFIX }),
      ([key]) => key.slice(OBSERVER_PREFIX.length));
    await this.#queue.authorizeObservation({
      title: `Searched InferOps boards on ${where}`,
      description:
        `Matched a search against the ${count} projects listed on ` +
        `${workspaces.map(workspace => `${workspace.scope.tenant}.${workspace.scope.workspace}`).join(", ")}: ` +
        `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}.`,
      ...(observers.length > 0 ? { excludeObservers: observers } : {}),
    });
    return candidates;
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

  /**
   * The state is resolved now, from the board, and sent explicitly, so the issue lands in the
   * column the approver saw. The workflow is the state's, named only when it is `content`
   * (InferOps' default is `software`).
   */
  async createIssue(issue: NewIssue): Promise<void> {
    const title = validTitle(issue.title);
    checkDescription(issue.description);
    const binding = this.#binding;
    const snapshot = await binding.client.readProject(binding.projectKey);
    const states = orderStates(snapshot.states);
    const state = issue.stateId !== undefined
      ? states.find(s => s.id === issue.stateId)
      : states.find(s => s.workflow === "software") ?? states[0];
    if (!state) {
      fail("INVALID_STATE", issue.stateId !== undefined
        ? `The target state is not part of project ${binding.projectKey}.`
        : `Project ${binding.projectKey} has no states to create an issue in.`);
    }
    const request: NewIssueRequest = {
      title,
      ...(issue.description ? { description: issue.description } : {}),
      ...(issue.priority ? { priority: issue.priority } : {}),
      stateId: state.id,
      ...(state.workflow === "content" ? { workflow: "content" as const } : {}),
    };
    // One intent, one create: the same proposal again (another tab, a retried submit) while the
    // first is pending joins it rather than queueing a second issue. Edits and moves need no
    // such step, since a pending change to an issue already refuses another (`refuseIfPending`).
    const { actionId, joined } = await binding.stageOnce({ kind: "create", issue: request, stateName: state.name });
    if (joined) return;
    const description = buildDescription(
      `Create an issue in InferOps project ${binding.projectKey}.`)
      .inline("Project", binding.projectKey)
      .inline("Title", title)
      .inline("State", state.name)
      .inline("Workflow", state.workflow)
      .inline("Priority", request.priority ?? "none");
    if (request.description) description.verbatim("Description", request.description);
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Create issue: ${title}`),
      ...description.finish(),
      implementsRevert: false,
    });
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

  /**
   * The stored and simulated issue, after checking the expected revision. The revision a change
   * produces is not knowable in advance, so changes cannot be chained: `livePending` says whether
   * one is already waiting.
   */
  async #current(expectedRevision: Revision) {
    if (!REVISION.test(expectedRevision)) {
      fail("INVALID_REQUEST", "expectedRevision must be the decimal string returned by read().");
    }
    const binding = this.#binding;
    const snapshot = await binding.client.readProject(binding.projectKey);
    const stored = snapshot.issues.find(i => i.id === this.#issueId);
    if (!stored) fail("NOT_FOUND", "No such issue in this project.");
    const { changes } = binding.pending();
    const issue = simulateIssue(stored, changes);
    if (issue.revision !== expectedRevision) {
      fail("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${expectedRevision}. Read it again.`);
    }
    const refuseIfPending = () => {
      if (livePendingChange(stored, changes)) {
        fail("CONFLICT",
          `${issue.identifier} already has a change that has not taken effect yet. Wait for it, ` +
          `then read the issue again.`);
      }
    };
    return { snapshot, stored, issue, refuseIfPending };
  }

  async transition(toStateId: string, expectedRevision: Revision): Promise<void> {
    const binding = this.#binding;
    const { snapshot, issue, refuseIfPending } = await this.#current(expectedRevision);
    const target = snapshot.states.find(s => s.id === toStateId);
    if (!target) fail("INVALID_STATE", `The target state is not part of project ${binding.projectKey}.`);
    if (target.workflow !== issue.workflow) {
      fail("WORKFLOW_MISMATCH",
        `${issue.identifier} is a ${issue.workflow} issue; "${target.name}" is a ${target.workflow} state.`);
    }
    if (issue.stateId === toStateId) return;
    refuseIfPending();

    const from = snapshot.states.find(s => s.id === issue.stateId);
    const actionId = await binding.stage({
      kind: "transition",
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
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Move ${issue.identifier} to ${target.name}`),
      ...rendered,
      implementsRevert: true,
    });
  }

  /**
   * Only fields whose value differs from the (simulated) issue are sent; the description is not
   * part of `Issue`, so a supplied one is always sent. The previous title and priority are
   * recorded for revert; a description change makes the action not revertible.
   */
  async update(changes: IssueChanges, expectedRevision: Revision): Promise<void> {
    const title = changes.title === undefined ? undefined : validTitle(changes.title);
    checkDescription(changes.description);
    const binding = this.#binding;
    const { issue, refuseIfPending } = await this.#current(expectedRevision);

    const sent: IssueChanges = {
      ...(title !== undefined && title !== issue.title ? { title } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.priority !== undefined && changes.priority !== issue.priority
        ? { priority: changes.priority } : {}),
    };
    const named = (["title", "description", "priority"] as const).filter(f => sent[f] !== undefined);
    if (named.length === 0) return;
    refuseIfPending();

    const previous = {
      ...(sent.title !== undefined ? { title: issue.title } : {}),
      ...(sent.priority !== undefined ? { priority: issue.priority } : {}),
    };
    const actionId = await binding.stage({
      kind: "update",
      issueId: issue.id,
      identifier: issue.identifier,
      expectedRevision,
      changes: sent,
      previous,
    });
    const description = buildDescription(
      `Change fields of an issue of InferOps project ${binding.projectKey}. It is applied only if ` +
      `the issue is still at the revision below when approved.`)
      .inline("Issue", issue.identifier);
    if (sent.title !== undefined) {
      description.inline("Current title", issue.title).inline("New title", sent.title);
    } else {
      description.inline("Title", issue.title);
    }
    if (sent.priority !== undefined) {
      description.inline("Priority", `${issue.priority} → ${sent.priority}`);
    }
    if (sent.description === null) description.prose("The description is cleared.");
    else if (sent.description !== undefined) description.verbatim("New description", sent.description);
    description.inline("Expected revision", expectedRevision);
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Update ${issue.identifier}: ${named.join(", ")}`),
      ...description.finish(),
      implementsRevert: sent.description === undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Coding-dispatch gatekeeper (a facet of the Overseer, one per dispatch binding)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/;
/** InferOps' git ref rule (`GIT_REF_NAME` in run.dto.ts): it reaches the runner's command line. */
const GIT_REF = /^(?![-/])(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\]+(?<![/.])$/;
const PROVISIONAL_RUN = "pending-";
const ACTIVE_RUN: ReadonlySet<Run["status"]> = new Set(["queued", "running"]);

@validateRpc()
export class InferOpsDispatchGatekeeper
    extends DurableObject<Cloudflare.Env, ProjectGatekeeperProps>
    implements Gatekeeper<InferOpsDispatchSession> {
  #binding(): ProjectBinding {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    return new ProjectBinding(this.ctx,
      codingClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId));
  }

  async describe(): Promise<ResourceDescription> {
    const { host, projectKey } = this.ctx.props;
    return {
      url: projectDispatchUrl({ host, projectKey }),
      title: `InferOps coding dispatch ${projectKey}`,
      snippet: `Coding dispatch for InferOps project ${projectKey} on ${host}: propose handing its ` +
        `software issues to the local coding runner, and follow or cancel the runs.`,
      suggestedBindingName: "INFEROPS_DISPATCH",
      tsType: "InferOpsDispatchSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every dispatch and cancel waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsDispatchSession> {
    return new DispatchSessionImpl(this.#binding(), approvalQueue.dup(), this.env);
  }

  /** Strategy B, as for a board binding. */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await admitProjectObserver(this.ctx.props, user);
  }

  /** Nothing is tracked per observer under strategy B. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * Send the recorded dispatch or cancel under the action's idempotency key, after checking that
   * coding dispatch is still on, that a dispatch's repository is still allowlisted, and that the
   * request still matches its fingerprint; InferOps rechecks the person's `issue:delegate`, the
   * project scope (through the client), the issue's condition and revision. A cancel answered
   * CONFLICT for a run that has already stopped counts as applied: there is nothing left to stop.
   *
   * Both are reconcile-only (apply-attempts.ts): a failure before sending is known not applied, but
   * any answer from InferOps that is not a success leaves the outcome unknown, and once an attempt
   * may have reached InferOps no later apply sends it again.
   */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
    if (record.status === "applied") return;
    if (record.status === "reverted") throw new Error(`InferOps action ${actionId} was reverted.`);
    if (!isCodingAction(record)) throw new Error(`InferOps action ${actionId} is not a coding action.`);
    const fields = { projectKey: binding.projectKey, action: actionId };
    const key = binding.idempotencyKey(actionId);
    const env = this.env;
    return binding.applyOnce(record, {
      policy: RECONCILE_ONLY, fields,
      async check() {
        await assertFingerprint(binding.projectKey, record, fields);
        assertCodingWorkbenchEnabled(env);
        if (record.kind === "dispatch" && !codingRepoAllowlist(env).has(record.repoId.toLowerCase())) {
          logger.warn("dispatch refused: repository not allowlisted", {
            event: "dispatch.apply.not_allowlisted", ...fields, code: "FORBIDDEN",
          });
          throw new CheckRefused("FORBIDDEN", `${actionLabel(record)} was not applied: the repository ` +
            `is no longer on this deployment's coding allowlist.`);
        }
      },
      async send(marked) {
        if (record.kind === "dispatch") {
          const run = await binding.client.dispatchIssue(binding.projectKey, record.issueId, {
            repoId: record.repoId, baseRef: record.baseRef, expectedRevision: record.expectedRevision,
          }, key);
          return { ...marked, status: "applied", runId: run.id } as ActionRecord;
        }
        await cancelOrConfirmStopped(binding, record.runId, key);
        return { ...marked, status: "applied" };
      },
    });
  }

  /** Forget the pending action; reads stop simulating it at once. */
  async rejectAction(actionId: number): Promise<void> {
    const binding = this.#binding();
    if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
  }

  /** Neither kind is revertible: a dispatch is stopped by a cancel, and a stopped run stays stopped. */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#binding().action(actionId);
    return {
      message: record?.kind === "dispatch"
        ? `A dispatch cannot be undone. Cancel the run of ${record.identifier} instead.`
        : "A cancelled run cannot be restarted. Dispatch the issue again instead.",
    };
  }
}

/**
 * Cancel the run; when InferOps answers CONFLICT because it has already stopped (a retried apply
 * whose first response was lost, or someone else stopping it), that is the outcome asked for.
 */
async function cancelOrConfirmStopped(binding: ProjectBinding, runId: string, key: string) {
  try {
    await binding.client.cancelRun(binding.projectKey, runId, key);
  } catch (error) {
    if (inferOpsErrorCode(error) !== "CONFLICT") throw error;
    const run = await binding.client.readRun(binding.projectKey, runId);
    if (ACTIVE_RUN.has(run.status)) throw error;
  }
}

/** A run as the caller sees it: a real one, marked when a cancel of it is pending. */
function shownRun(run: RunRecord, cancels: CancelRunAction[]): Run {
  return cancels.some(c => c.runId === run.id) ? { ...run, pending: "cancel" } : run;
}

/** The provisional run a pending dispatch shows as until it is decided. */
function provisionalRun(dispatch: DispatchAction): Run {
  return {
    id: `${PROVISIONAL_RUN}${dispatch.actionId}`, issueId: dispatch.issueId,
    issueIdentifier: dispatch.identifier, repoId: dispatch.repoId, status: "queued",
    baseRef: dispatch.baseRef ?? null, externalRunId: null, result: null, error: null,
    queuedAt: dispatch.proposedAt, startedAt: null, finishedAt: null, pending: "dispatch",
  };
}

/** Rethrow a data-source "not found" for a run without saying which way it was not found. */
function hideRunExistence(error: unknown): never {
  if (inferOpsErrorCode(error) === "NOT_FOUND") fail("NOT_FOUND", "No such run in this project.");
  throw error;
}

@validateRpc()
class DispatchSessionImpl extends RpcTarget implements InferOpsDispatchSession {
  #binding: ProjectBinding;
  #queue: RpcStub<ApprovalQueue>;
  #env: Cloudflare.Env;

  constructor(binding: ProjectBinding, queue: RpcStub<ApprovalQueue>, env: Cloudflare.Env) {
    super();
    this.#binding = binding;
    this.#queue = queue;
    this.#env = env;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async listRepos(): Promise<Repo[]> {
    const allowed = codingRepoAllowlist(this.#env);
    const repos = (await this.#binding.client.listRepos())
      .map(repo => ({ ...repo, allowed: allowed.has(repo.id.toLowerCase()) }));
    await this.#queue.authorizeObservation({
      title: "List InferOps repositories",
      description: `Listed the ${repos.length} repositories of the workspace of project ` +
        `${this.#binding.projectKey}; ${repos.filter(r => r.allowed).length} are allowed for coding.`,
    });
    return repos;
  }

  async getRun(runId: string): Promise<Run> {
    if (runId.startsWith(PROVISIONAL_RUN)) fail("NOT_FOUND", "No such run in this project.");
    const binding = this.#binding;
    const run = await binding.client.readRun(binding.projectKey, runId).catch(hideRunExistence);
    await this.#queue.authorizeObservation({
      title: `Read InferOps coding run of ${run.issueIdentifier}`,
      description: `Read the ${run.status} coding run of issue ${run.issueIdentifier} of project ` +
        `${binding.projectKey}.`,
    });
    return shownRun(run, binding.codingPending().cancels);
  }

  async listRuns(): Promise<Run[]> {
    const binding = this.#binding;
    const runs = await binding.client.listRuns(binding.projectKey);
    const { dispatches, cancels } = binding.codingPending();
    const shown = [
      ...dispatches.toSorted((a, b) => b.actionId - a.actionId).map(provisionalRun),
      ...runs.map(run => shownRun(run, cancels)),
    ];
    await this.#queue.authorizeObservation({
      title: `Read InferOps coding runs of ${binding.projectKey}`,
      description: `Read the ${runs.length} recent coding runs of project ${binding.projectKey}.`,
    });
    return shown;
  }

  /**
   * Everything that can be checked without a request is checked first: the switch, the arguments
   * and the allowlist. Then the issue is resolved from the board by its key (which also fixes it to
   * the bound project), and its workflow, state and revision, the repository and any active run are
   * checked, so a dispatch InferOps would refuse is not proposed. None of it is an observation: the
   * approval shows what was read.
   */
  async dispatch(issueKey: string, target: DispatchTarget, expectedRevision: Revision): Promise<void> {
    const binding = this.#binding;
    assertCodingWorkbenchEnabled(this.#env);
    if (!REVISION.test(expectedRevision)) {
      fail("INVALID_REQUEST", "expectedRevision must be the decimal string the issue was read at.");
    }
    if (!ISSUE_KEY.test(issueKey)) fail("INVALID_REQUEST", "issueKey must be an issue key such as ENG-42.");
    if (!UUID.test(target.repoId)) fail("INVALID_REQUEST", "repoId must be a repository id from listRepos().");
    if (target.baseRef !== undefined && (target.baseRef.length > 255 || !GIT_REF.test(target.baseRef) ||
        target.baseRef.endsWith(".lock"))) {
      fail("INVALID_REQUEST", "baseRef must be a git ref name, such as main.");
    }
    const repoId = target.repoId.toLowerCase();
    assertRepoAllowlisted(this.#env, repoId);

    const snapshot = await binding.client.readProject(binding.projectKey);
    const issue = snapshot.issues.find(i => i.identifier === issueKey);
    if (!issue) fail("NOT_FOUND", "No such issue in this project.");
    if (issue.workflow !== "software") {
      fail("WORKFLOW_MISMATCH", `${issue.identifier} is content work; only software issues can be coded.`);
    }
    const state = snapshot.states.find(s => s.id === issue.stateId);
    if (state?.group === "completed" || state?.group === "cancelled") {
      fail("CONFLICT", `${issue.identifier} is already ${state.group}; there is nothing to dispatch.`);
    }
    if (issue.revision !== expectedRevision) {
      fail("STALE_REVISION",
        `${issue.identifier} is at revision ${issue.revision}, not ${expectedRevision}. Read it again.`);
    }
    if (binding.codingPending().dispatches.some(d => d.issueId === issue.id)) {
      throw new InferOpsError("RUN_ACTIVE",
        `${issue.identifier} already has a dispatch that has not taken effect yet.`);
    }
    const repo = (await binding.client.listRepos()).find(r => r.id.toLowerCase() === repoId);
    if (!repo?.enabled) {
      fail("INVALID_REQUEST", "The repository is not enrolled in this workspace, or is disabled.");
    }
    const runs = await binding.client.listRuns(binding.projectKey, issue.id);
    const active = runs.find(run => ACTIVE_RUN.has(run.status));
    if (active) {
      throw new InferOpsError("RUN_ACTIVE",
        `${issue.identifier} already has a ${active.status} run. Follow it or cancel it first.`);
    }

    const actionId = await binding.stage({
      kind: "dispatch", issueId: issue.id, identifier: issue.identifier, repoId,
      repoSlug: repo.slug, ...(target.baseRef !== undefined ? { baseRef: target.baseRef } : {}),
      expectedRevision, proposedAt: new Date().toISOString(),
    });
    const description = buildDescription(
      `Hand an issue of InferOps project ${binding.projectKey} to the local coding runner, which ` +
      `works on it in a local checkout and reports a patch and test results. It is dispatched only ` +
      `if the issue is still at the revision below when approved, and only with your own InferOps ` +
      `dispatch permission.`)
      .inline("Issue", issue.identifier)
      .inline("Title", issue.title)
      .inline("Repository", repo.slug)
      .inline("Base ref", target.baseRef ?? `${repo.defaultBaseRef} (default)`)
      .inline("Expected revision", expectedRevision)
      .finish();
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Dispatch ${issue.identifier} to ${repo.slug}`),
      ...description,
      implementsRevert: false,
      actionKind: { tag: "inferops.code-dispatch", label: "Dispatch a coding task" },
    });
  }

  /** A cancel already pending for the run makes this a no-op. */
  async cancel(runId: string): Promise<void> {
    if (runId.startsWith(PROVISIONAL_RUN)) fail("NOT_FOUND", "No such run in this project.");
    const binding = this.#binding;
    const run = await binding.client.readRun(binding.projectKey, runId).catch(hideRunExistence);
    if (!ACTIVE_RUN.has(run.status)) fail("CONFLICT", `The run of ${run.issueIdentifier} is already ${run.status}.`);
    if (binding.codingPending().cancels.some(c => c.runId === run.id)) return;

    const actionId = await binding.stage({ kind: "cancel", runId: run.id, identifier: run.issueIdentifier });
    const description = buildDescription(
      `Stop a coding run of InferOps project ${binding.projectKey}. A queued run ends cancelled; a ` +
      `running one ends unknown, because its work may be partly done, and InferOps holds the issue ` +
      `for a person to recover.`)
      .inline("Issue", run.issueIdentifier)
      .inline("Run", run.id)
      .inline("Status", run.status)
      .finish();
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Cancel the ${run.status} run of ${run.issueIdentifier}`),
      ...description,
      implementsRevert: false,
      actionKind: { tag: "inferops.run-cancel", label: "Cancel a coding run" },
    });
  }
}

// ---------------------------------------------------------------------------
// Wiki gatekeeper (a facet of the Overseer, one per Wiki binding)

/**
 * A page slug as the session looks it up: InferOps slugs may have `/`-separated segments (such as
 * dispatch/dispatch-a-crew). It is only compared with the listed slugs, never put in a request path.
 */
const PAGE_SLUG = /^(?=.{1,512}$)[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

/** The fingerprint scope of every Wiki binding: its facet is one workspace's Wiki. */
const WIKI_SCOPE = "knowledge/wiki";
const MAX_SECTION_BODY = 100_000;
/** InferOps' bound on a page body (`EditPageRequestSchema`). */
const MAX_PAGE_BODY = 200_000;

/** A Wiki binding: its action store, data source and the edits still waiting for a decision. */
class WikiBinding extends ActionBinding<WikiGatekeeperProps> {
  constructor(ctx: DurableObjectState<WikiGatekeeperProps>, client: InferOpsClient) {
    super(ctx, client, WIKI_SCOPE);
  }

  get host(): string {
    return this.ctx.props.host;
  }

  /** Pending section and page body edits, oldest first. */
  pendingEdits(): WikiAction[] {
    const edits: WikiAction[] = [];
    for (const [, raw] of this.kv.list({ prefix: ACTION_PREFIX })) {
      const record = readAction(raw);
      if (record?.status === "pending" && isWikiAction(record)) edits.push(record);
    }
    return edits.toSorted((a, b) => a.actionId - b.actionId);
  }

  /**
   * The pending edit that still applies to `section`: the newest one proposed at its current
   * version. An edit made stale by a change in InferOps is no longer shown and blocks nothing.
   */
  liveEdit(section: WikiSectionRecord, edits = this.pendingEdits()): SectionUpdateAction | undefined {
    return edits.findLast((e): e is SectionUpdateAction =>
      e.kind === "section-update" && e.sectionId === section.id && e.expectedVersion === section.version);
  }

  /**
   * The pending body edit that still applies to `page`: the newest one proposed at its current
   * version. One made stale by any change of the page in InferOps is no longer shown.
   */
  liveBodyEdit(page: WikiDocumentHead, edits = this.pendingEdits()): DocumentUpdateAction | undefined {
    return edits.findLast((e): e is DocumentUpdateAction =>
      e.kind === "document-update" && e.documentId === page.id && e.expectedVersion === page.version);
  }

  /** A section as the caller sees it: with its live pending edit, and its links. */
  shown(section: WikiSectionRecord, edits = this.pendingEdits()): WikiSection {
    const edit = this.liveEdit(section, edits);
    const body = edit?.body ?? section.body;
    return {
      id: section.id, tag: section.tag, body, version: section.version,
      wikilinks: wikilinksOf(body), ...(edit ? { pending: "update" as const } : {}),
    };
  }
}

/** Thrown from a staging guard when the same edit is already pending: the proposal is a no-op. */
class AlreadyProposed extends Error {}

const failBodyConflict = (slug: string): never =>
  fail("CONFLICT",
    `Page ${slug} already has a body edit that has not taken effect yet. Wait for it, then read the ` +
    `page again.`);

const failSectionConflict = (tag: string): never =>
  fail("CONFLICT",
    `Section ${tag} already has an edit that has not taken effect yet. Wait for it, then read the ` +
    `page again.`);

/** Rethrow a data-source "not found" for a page without saying which way it was not found. */
function hideDocumentExistence(error: unknown): never {
  if (inferOpsErrorCode(error) === "NOT_FOUND") fail("NOT_FOUND", "No such page in this Wiki.");
  throw error;
}

@validateRpc()
export class InferOpsWikiGatekeeper
    extends DurableObject<Cloudflare.Env, WikiGatekeeperProps>
    implements Gatekeeper<InferOpsWikiSession> {
  #binding(): WikiBinding {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    return new WikiBinding(
      this.ctx, clientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId));
  }

  async describe(): Promise<ResourceDescription> {
    const { host } = this.ctx.props;
    return {
      url: wikiUrl({ host }),
      title: `InferMind Wiki ${host}`,
      snippet: `The InferMind Wiki of ${host}: read its pages and propose edits to their sections.`,
      suggestedBindingName: "INFEROPS_WIKI",
      tsType: "InferOpsWikiSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every section edit waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsWikiSession> {
    return new WikiSessionImpl(this.#binding(), approvalQueue.dup());
  }

  /** Strategy B: the binding is one workspace's Wiki, so admit an observer who can read it. */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const { host, workspaceId } = this.ctx.props;
    const verifier = user as unknown as Fetcher<InferOpsVerifierApi>;
    if (!(await verifier.hasWikiAccess(host, workspaceId))) {
      throw new Error(
        `This collaborator cannot read the InferMind Wiki of ${host}, so they cannot observe data ` +
        `the Gadget read from it.`);
    }
  }

  /** Nothing is tracked per observer under strategy B. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * Apply a section edit or a page body edit; see `#sendSectionEdit` and `#sendBodyEdit`. The
   * fingerprint is required: every Wiki record has one. Both are reconcile-only
   * (apply-attempts.ts): a failure before sending is known not applied, any other failure leaves
   * the outcome unknown, and once an attempt may have reached InferOps no later apply sends it
   * again, even when the page now shows the edit.
   */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
    if (record.status === "applied") return;
    if (record.status === "reverted") throw new Error(`InferOps action ${actionId} was reverted.`);
    if (!isWikiAction(record)) throw new Error(`InferOps action ${actionId} is not a Wiki action.`);
    const fields = { host: binding.host, action: actionId };
    return binding.applyOnce(record, {
      policy: RECONCILE_ONLY, fields,
      check: () => assertFingerprint(WIKI_SCOPE, record, fields, { required: true }),
      send: marked => record.kind === "document-update"
        ? this.#sendBodyEdit(binding, marked as DocumentUpdateAction)
        : this.#sendSectionEdit(binding, marked as SectionUpdateAction),
    });
  }

  /**
   * A page body edit is sent as it was approved: the body, the version it was proposed at, and a
   * key fixed per action (`<instance>:<action>`). InferOps compares the version itself, so the page
   * is not read first, and its text decides nothing: a page already holding this body at a later
   * version fails STALE_REVISION like any other change, since matching text does not show this
   * action wrote it. Returns the record with the version reported.
   */
  async #sendBodyEdit(binding: WikiBinding, record: DocumentUpdateAction): Promise<ActionRecord> {
    const written = await binding.client.updateDocument(
      record.documentId, { body: record.body }, record.expectedVersion,
      binding.idempotencyKey(record.actionId));
    return { ...record, status: "applied", appliedVersion: written.version };
  }

  /**
   * Send a section edit. InferOps' section PATCH takes no expected version and ignores the
   * idempotency key, so the check is made here, by reading the section first:
   *
   * - at the version the edit was proposed at: send the body (under the action's key, for when
   *   InferOps honors it), and record the version InferOps reports;
   * - already showing exactly this body at a later version, on a first attempt: the same text was
   *   written elsewhere, so it counts as applied and nothing is sent;
   * - anything else: refused as stale, nothing sent.
   *
   * The read and the write are two requests, so an edit made in between is overwritten (see the
   * design's Open Questions).
   */
  async #sendSectionEdit(binding: WikiBinding, record: SectionUpdateAction): Promise<ActionRecord> {
    let current: WikiSectionRecord;
    try {
      current = await binding.client.readSection(record.sectionId);
    } catch (error) {
      throw atStage(error, "unsent");
    }
    if (current.version === record.expectedVersion) {
      const updated = await binding.client.updateSection(
        record.sectionId, record.body, binding.idempotencyKey(record.actionId));
      return { ...record, status: "applied", appliedVersion: updated.version };
    }
    if (current.body === record.body) {
      logger.info("section edit already in effect", {
        event: "section-update.apply.in_effect", host: binding.host, action: record.actionId,
      });
      return { ...record, status: "applied", appliedVersion: current.version };
    }
    throw new InferOpsError("STALE_REVISION", "The section changed since the edit was proposed.",
                            { stage: "unsent" });
  }

  /** Forget the pending edit; reads stop showing it at once. */
  async rejectAction(actionId: number): Promise<void> {
    const binding = this.#binding();
    if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
  }

  /**
   * Restore the body an applied edit replaced, provided the section or page is still exactly what
   * the edit left; otherwise explain instead of clobbering a later edit. A section is checked by
   * reading it (its version and body); a page by InferOps' compare-and-swap, sent expecting the
   * version the edit produced under `<instance>:<action>:revert`, so a page changed since in any way
   * fails STALE_REVISION and keeps its content, and a retried revert whose response was lost is
   * replayed under its key.
   */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record || record.status !== "applied") {
      return { message: "This change was never applied, so there is nothing to revert." };
    }
    if (!isWikiAction(record)) return { message: "This is not a Wiki action." };
    if (record.kind === "document-update") return this.#revertBodyEdit(binding, record);
    let current: WikiSectionRecord;
    try {
      current = await binding.client.readSection(record.sectionId);
    } catch (error) {
      if (inferOpsErrorCode(error) !== "NOT_FOUND") throw error;
      return { message: `Section ${plainInline(record.tag, 60)} is no longer in this Wiki.` };
    }
    if (current.version !== record.appliedVersion || current.body !== record.body) {
      return {
        message: `Section ${plainInline(record.tag, 60)} has changed again since this edit, so its previous text ` +
          `was not restored. Edit it in InferMind if needed.`,
      };
    }
    await binding.client.updateSection(
      record.sectionId, record.previousBody, binding.idempotencyKey(actionId, ":revert"));
    binding.putAction({ ...record, status: "reverted" });
  }

  async #revertBodyEdit(binding: WikiBinding, record: DocumentUpdateAction):
      Promise<void | { message?: string }> {
    const page = `Page "${plainInline(record.documentTitle, 60)}"`;
    if (record.appliedVersion === undefined) {
      return { message: `${page} has no recorded version for this edit, so its previous text was not restored.` };
    }
    try {
      await binding.client.updateDocument(
        record.documentId, { body: record.previousBody }, record.appliedVersion,
        binding.idempotencyKey(record.actionId, ":revert"));
    } catch (error) {
      switch (inferOpsErrorCode(error)) {
        case "STALE_REVISION":
          return {
            message: `${page} has changed again since this edit, so its previous text was not ` +
              `restored. Edit it in InferMind if needed.`,
          };
        case "NOT_FOUND":
          return { message: `${page} is no longer in this Wiki.` };
        default:
          throw error;
      }
    }
    binding.putAction({ ...record, status: "reverted" });
    logger.info("document-update reverted", {
      event: "document-update.reverted", host: binding.host, action: record.actionId,
    });
  }
}

@validateRpc()
class WikiSessionImpl extends RpcTarget implements InferOpsWikiSession {
  #binding: WikiBinding;
  #queue: RpcStub<ApprovalQueue>;

  constructor(binding: WikiBinding, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#binding = binding;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async listDocuments(): Promise<WikiDocumentNode[]> {
    const documents = await this.#binding.client.listDocuments();
    await this.#queue.authorizeObservation({
      title: "List InferMind Wiki pages",
      description: `Listed the ${documents.length} pages of the InferMind Wiki of ${this.#binding.host}.`,
    });
    return documents.map(({ id, slug, title, parentId, siblingOrder }) =>
      ({ id, slug, title, parentId, siblingOrder }));
  }

  /** A page's UUID from a slug or UUID; the list is read only for a slug. Not an observation. */
  async #documentId(slugOrId: string): Promise<string> {
    if (UUID.test(slugOrId)) return slugOrId.toLowerCase();
    if (!PAGE_SLUG.test(slugOrId)) {
      fail("INVALID_REQUEST", "slugOrId must be a page slug, such as handbook, or a page UUID.");
    }
    const found = (await this.#binding.client.listDocuments()).find(d => d.slug === slugOrId);
    if (!found) fail("NOT_FOUND", "No such page in this Wiki.");
    return found.id;
  }

  async readStructure(): Promise<WikiStructure> {
    const structure = await this.#binding.client.readStructure();
    const filed = new Set(structure.pillars.flatMap(p => p.members.map(m => m.id)));
    await this.#queue.authorizeObservation({
      title: "Read InferMind Wiki structure",
      description: `Read how the InferMind Wiki of ${this.#binding.host} is organized: ` +
        `${structure.root ? "a company root page" : "no company root page"}, ` +
        `${structure.pillars.length} pillars filing ${filed.size} pages, and ${structure.unfiled.length} unfiled pages.`,
    });
    return structure;
  }

  /**
   * The page as shown (its pending body edit and section edits overlaid) and, for a Master, the
   * structure its generated block lists. Only a Master's read costs the structure request.
   */
  async #page(slugOrId: string, withStructure: boolean) {
    const binding = this.#binding;
    const documentId = await this.#documentId(slugOrId);
    const head = await binding.client.readDocument(documentId).catch(hideDocumentExistence);
    const records = await binding.client.listSections(head.id).catch(hideDocumentExistence);
    const edits = binding.pendingEdits();
    const bodyEdit = binding.liveBodyEdit(head, edits);
    const structure = withStructure && head.masterRole !== null
      ? await binding.client.readStructure() : null;
    return {
      head, body: bodyEdit?.body ?? head.body, pendingBody: bodyEdit !== undefined, structure,
      sections: records.map(section => binding.shown(section, edits)),
    };
  }

  async readDocument(slugOrId: string): Promise<WikiDocument> {
    const { head, body, pendingBody, sections } = await this.#page(slugOrId, false);
    const page: WikiDocument = {
      id: head.id, slug: head.slug, title: head.title, body, version: head.version,
      masterRole: head.masterRole, ...(pendingBody ? { pendingBody: true as const } : {}), sections,
      references: embeddedReferences(authoredContent(head.title, { body, visibleSections: sections.map(s => s.body) })),
    };
    await this.#queue.authorizeObservation({
      title: `Read Wiki page ${plainInline(head.slug, 80)}`,
      description: `Read page "${plainInline(head.title, 120)}" of the InferMind Wiki of ` +
        `${this.#binding.host}: ${body.trim() ? "its body, " : ""}${sections.length} sections, ` +
        `${page.references.length} embedded references.`,
    });
    return page;
  }

  /**
   * InferOps' page-text contract (wiki.ts): the body, else the visible sections, then a Master's
   * generated block. A page with none of them is answered as not readable, as InferOps answers it,
   * rather than as a bare title.
   */
  async readDocumentText(slugOrId: string): Promise<string> {
    const { head, body, sections, structure } = await this.#page(slugOrId, true);
    const text = composeDocumentText(head.title, {
      body, visibleSections: sections.map(s => s.body),
      generated: structure ? masterStructureText(head, structure) : null,
    });
    if (text === null) fail("NOT_FOUND", "Nothing on this page is readable.");
    await this.#queue.authorizeObservation({
      title: `Read Wiki page ${plainInline(head.slug, 80)} as text`,
      description: `Read page "${plainInline(head.title, 120)}" of the InferMind Wiki of ` +
        `${this.#binding.host} as text: ` +
        `${body.trim() ? "its body" : `${sections.length} sections`}` +
        `${structure ? " and its generated structure list" : ""}.`,
    });
    return text;
  }

  /**
   * Checked against the page as InferOps has it now: its version (STALE_REVISION), a body equal to
   * the one shown (nothing to do) and a live pending body edit (CONFLICT). Not an observation: the
   * approval shows what was read.
   */
  async updateDocumentBody(slugOrId: string, body: string, expectedVersion: number): Promise<void> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      fail("INVALID_REQUEST", "expectedVersion must be the version readDocument() returned.");
    }
    if (body.length > MAX_PAGE_BODY) {
      fail("INVALID_REQUEST", `A page body must be at most ${MAX_PAGE_BODY} characters.`);
    }
    const binding = this.#binding;
    const documentId = await this.#documentId(slugOrId);
    const head = await binding.client.readDocument(documentId).catch(hideDocumentExistence);
    if (head.version !== expectedVersion) {
      fail("STALE_REVISION",
        `Page ${head.slug} is at version ${head.version}, not ${expectedVersion}. Read it again.`);
    }
    const live = binding.liveBodyEdit(head);
    if ((live?.body ?? head.body) === body) return;
    if (live) failBodyConflict(head.slug);
    const actionId = await binding.stage({
      kind: "document-update", documentId: head.id, documentTitle: head.title, body, expectedVersion,
      previousBody: head.body,
    }, () => {
      // Re-checked with the write, after the fingerprint: a concurrent proposal may have staged since.
      const now = binding.liveBodyEdit(head);
      if (now?.body === body) throw new AlreadyProposed();
      if (now) failBodyConflict(head.slug);
    }).catch(error => {
      if (error instanceof AlreadyProposed) return null;
      throw error;
    });
    if (actionId === null) return;
    const description = buildDescription(
      `Replace the body of one page of the InferMind Wiki of ${binding.host}. InferOps applies it ` +
      `only if the page is still at the version below when approved. Its sections are not changed.`)
      .inline("Page", head.title)
      .inline("Expected version", String(expectedVersion))
      .verbatim("Current text", head.body)
      .verbatim("New text", body)
      .finish();
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Edit Wiki page ${head.title}`),
      ...description,
      implementsRevert: true,
      actionKind: { tag: "inferops.wiki-page-update", label: "Edit a Wiki page" },
    });
  }

  /**
   * Checked against the section as InferOps has it now: its version (STALE_REVISION), a live
   * pending edit (CONFLICT), and a body equal to the one shown (nothing to do). The section's page
   * is read for the approval's title. Not an observation: the approval shows what was read.
   */
  async updateSection(sectionId: string, body: string, expectedVersion: number): Promise<void> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      fail("INVALID_REQUEST", "expectedVersion must be the version readDocument() returned.");
    }
    if (body.length > MAX_SECTION_BODY) {
      fail("INVALID_REQUEST", `A section body must be at most ${MAX_SECTION_BODY} characters.`);
    }
    if (!UUID.test(sectionId)) fail("NOT_FOUND", "No such section in this Wiki.");
    const binding = this.#binding;
    const stored = await binding.client.readSection(sectionId);
    if (stored.version !== expectedVersion) {
      fail("STALE_REVISION",
        `Section ${stored.tag} is at version ${stored.version}, not ${expectedVersion}. Read it again.`);
    }
    const live = binding.liveEdit(stored);
    if ((live?.body ?? stored.body) === body) return;
    if (live) failSectionConflict(stored.tag);
    const head = await binding.client.readDocument(stored.documentId).catch(hideDocumentExistence);
    const actionId = await binding.stage({
      kind: "section-update", sectionId: stored.id, documentTitle: head.title, tag: stored.tag, body,
      expectedVersion, previousBody: stored.body,
    }, () => {
      // Re-checked with the write, after the awaits above: a concurrent proposal may have staged since.
      const now = binding.liveEdit(stored);
      if (now?.body === body) throw new AlreadyProposed();
      if (now) failSectionConflict(stored.tag);
    }).catch(error => {
      if (error instanceof AlreadyProposed) return null;
      throw error;
    });
    if (actionId === null) return;
    const description = buildDescription(
      `Replace the markdown of one section of the InferMind Wiki of ${binding.host}. It is applied ` +
      `only if the section is still at the version below when approved.`)
      .inline("Page", head.title)
      .inline("Section", stored.tag)
      .inline("Expected version", String(expectedVersion))
      .verbatim("Current text", stored.body)
      .verbatim("New text", body)
      .finish();
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Edit Wiki section ${stored.tag} of ${head.title}`),
      ...description,
      implementsRevert: true,
      actionKind: { tag: "inferops.wiki-section-update", label: "Edit a Wiki section" },
    });
  }
}

import type { ServiceQueryName, ServiceQueryOptions, ServiceQueryPage } from "./types";
import type { ApprovalEdit, ApprovalProposal } from "@gadgets/workshop-shared/operate-approval";
import { GovernedRequestError, listGoverned, parseGovernedListRequest } from "@gadgets/workshop-shared/governed-data";
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
//   product gate and `knowledge:*` permissions apply to the person's token. Drafted page proposals
//   are read, and one is approved for publication as an approved action that only the binding's own
//   account holder can decide: refused while the gadget is shared or on the stopgap connection
//   (`approveProposal`). Approving queues InferOps' publication; nothing here publishes.
// - A custom table is a fourth kind, `inferops://<tenant>.<workspace>/object/table/<tableId>`, bound
//   into an `InferOpsTableGatekeeper` facet whose props fix the account, host, table id and
//   workspace id, and offered only while `INFEROPS_TABLES_ENABLED` is on (table.ts). It is read-only
//   and private-only: `InferOpsTableSession` describes the table, lists up to 50 rows and reads one
//   row, every read through InferOps' `object.embed` with a reference built from the props, so
//   InferOps checks the exact `<tenant>.<workspace>` on each read (the membership lookup here
//   matches the workspace slug only). Personal columns are projected out (table.ts). A connected
//   person's own sign-in or the demo mock only: the stopgap connection never serves a table.
//   `addObserver` refuses every collaborator.
// - Workspace members are a fifth kind, `inferops://<tenant>.<workspace>/portal/members`, bound into
//   an `InferOpsMembersGatekeeper` facet whose props fix the account, host and InferOps workspace id,
//   and offered only while `INFEROPS_MEMBERS_ENABLED` is on (members.ts). Read-only and private-only,
//   like a table: `InferOpsMembersSession.listMembers` reads InferOps' `member.list` with the person's
//   own sign-in in the bound workspace, so InferOps' `member:read`, explicit denies and RLS decide;
//   the email is projected out (members.ts). InferOps workspaces only; never the stopgap connection.
// - A workflow policy is a sixth kind, `inferops://<tenant>.<workspace>/project/workflow/<KEY>` (an
//   InferOS-minted binding URL; it never reaches InferOps), bound into an
//   `InferOpsWorkflowPolicyGatekeeper` facet whose props fix the account, host, project key and
//   InferOps workspace id, and offered only while `INFEROPS_WORKFLOW_POLICY_ENABLED` is on
//   (workflow-policy.ts). Read-only and private-only, like members: each
//   `InferOpsWorkflowPolicySession.readWorkflowPolicy` is exactly two GETs with the person's own
//   sign-in in the bound workspace (`project.list`, then `workflow.get` for the project the key names
//   there), so InferOps' `project:read`, explicit denies and RLS decide. Rule reasons, agent notes
//   and the publisher are projected out (workflow-policy.ts). Never the stopgap connection.
// - Host boards (host-board.ts) are a kernel-only read of a board binding's fixed target:
//   `readHostBoardSnapshot` and `connectionIdentity` on the board facet itself, never on a session
//   or in the agent types, so only the overseer, which alone holds facet stubs, can call them. Off
//   unless `INFEROPS_HOST_BOARDS` is on, a connected person only, fenced on the attempt that
//   answered, and not an observation: the kernel owns its audit.
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
import { COMPANY_MISCONFIGURED, companyAdmits, deploymentCompany } from "./deployment-company";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { buildDescription, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { ObserverTracker, asVerifier, isObservationRefused } from "@gadgets/gatekeeper-kit/observers";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ActionApplied, ActionApplyFailure, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GitCache,
  GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ObservationDescription, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription, SharedConfigurationAction, SharedConfigurationAnswer,
  WidgetIndexEntry, WidgetIndexOutcome, WidgetIndexWorkspace, WidgetSearchAnswer, WidgetSearchResult,
} from "@gadgets/workshop-shared/gatekeeper";
import { mergeWidgetSearches } from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import {
  CredentialSource, isCredentialsChanged, isCredentialsExpired, type CredentialRead,
} from "@gadgets/gatekeeper-kit/credentials";
import {
  InferOpsError, atStage, inferOpsErrorCode, isPolicyRefusal, writeStage, type InferOpsClient,
  type ProjectSummary, type RunRecord, type TableRead, type WikiDocumentHead, type WikiProposalRead,
  type WikiProposalRecord, type WikiStructureRecord, type WriteStage,
} from "./inferops-client";
import {
  BOARD_WRITES, CheckRefused, PROPOSAL_APPROVE, RECONCILE_ONLY, classifyAttempt, type ApplyPolicy,
} from "./apply-attempts";
import {
  WIDGET_SEARCH_DENIED, WIKI_FORBIDDEN, connectionFromEnv, fetchBoardSnapshot, listWorkspaceSlugs, openHttpInferOpsClient,
  readCallerPrincipal, tableNotFound,
  type BoardSnapshotAnswer, type InferOpsAuthority, type InferOpsEndpoint,
} from "./http-inferops";
import { CREDENTIAL_REF, InferOpsSystemCredentials } from "./system-credentials";
import { inferLabFetch } from "./edge-header";
import type {
  HostBoardConnectionFence, HostBoardFence, HostBoardRead, HostBoardReader,
} from "@gadgets/gatekeeper-kit/host-board";
import {
  HOST_BOARD_NOT_CONNECTED, HOST_BOARD_STALE, hostBoardRef, hostBoardsEnabled, unavailable,
} from "./host-board";
import { MockInferOps, openInferOpsClient } from "./mock-inferops";
import { assertInferOpsEnabled, whileInferOpsEnabled } from "./enablement";
import {
  assertCodingWorkbenchEnabled, assertRepoAllowlisted, codingRepoAllowlist, codingWorkbenchEnabled,
  whileCodingWorkbenchEnabled,
} from "./coding-workbench";
import {
  InferOpsCredentials, WIKI_SEARCHES_PER_MINUTE, type InferOpsWorkspace, type WorkspaceProduct,
} from "./inferops-credentials";
import {
  MAX_TABLE_ROWS, assertTablesEnabled, describeTable, projectRows, tableReadOptions, tablesEnabled, whileTablesEnabled,
} from "./table";
import {
  assertMembersEnabled, membersEnabled, membersNotFound, projectMembers, whileMembersEnabled,
} from "./members";
import {
  assertWorkflowPolicyEnabled, projectWorkflowHead, whileWorkflowPolicyEnabled, workflowPolicyEnabled,
  workflowPolicyNotFound,
} from "./workflow-policy";
import {
  InferLabLogin, handleInferLabLogin, inferLabAuthOrigin, inferOpsApiEndpoint, startInferLabLogin,
} from "./inferlab-login";
import {
  DEMO_HOST, INFEROPS_ACCOUNT_RESOURCE, KNOWLEDGE_WIKI_RESOURCE, OBJECT_TABLE_RESOURCE,
  PORTAL_MEMBERS_RESOURCE, PROJECT_BOARD_RESOURCE, PROJECT_DISPATCH_RESOURCE, PROJECT_WORKFLOW_RESOURCE,
  accountUrl, hostInTenant, membersUrl, parseAccountUrl, parseHost, parseMembersUrl, parseProjectBoardUrl,
  parseProjectDispatchUrl, parseProjectWorkflowUrl, parseTableUrl, parseWikiUrl, projectBoardUrl,
  projectDispatchUrl, projectWorkflowUrl, resourceKind, tableUrl, wikiUrl, type ProjectBoardRef, type WikiRef,
} from "./resources";
import {
  buildBoard, livePendingChange, orderStates, simulateIssue, type Pending,
} from "./simulation";
import {
  appliedResult, fingerprintOf, isCodingAction, isIssueChange, isWikiAction, isWikiEdit, matchesFingerprint, readAction,
  sortedSources, type ActionRecord, type ActionScope, type CancelRunAction, type FingerprintScope, type CreateAction, type DispatchAction,
  type DocumentUpdateAction, type ProposalApproveAction, type SectionUpdateAction, type StagedAction,
  type StoredFailure, type UpdateAction, type WikiEditAction,
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
  AccountWorkspace, Board, BoardCandidate, DispatchTarget, InferOpsAccountSession, InferOpsDispatchSession, InferOpsIssueSession,
  InferOpsMembersSession, InferOpsProjectSession, InferOpsTableSession, InferOpsWikiSession,
  InferOpsWorkflowPolicySession, Issue, IssueActivity, IssueChanges, ListRecordsOptions, NewIssue, Repo,
  WorkflowPolicyHead, WorkspaceMembers,
  Revision, Run, TableDescription, TableRecord, WikiDocument,
  GovernedDescription, GovernedListQuery, GovernedListResult, GovernedRow,
  WikiDocumentNode, WikiProposal, WikiProposalDetail, WikiProposalState, WikiSearchHit, WikiSection, WikiStructure,
} from "./types";
import type { NewIssueRequest, WikiSectionRecord } from "./inferops-client";
import TYPES_CODE from "./types.txt";
import PROJECT_CONFIGURATOR_HTML from "./generated/project-ui.txt";
import DISPATCH_CONFIGURATOR_HTML from "./generated/dispatch-ui.txt";
import WIKI_CONFIGURATOR_HTML from "./generated/wiki-ui.txt";
import TABLE_CONFIGURATOR_HTML from "./generated/table-ui.txt";
import MEMBERS_CONFIGURATOR_HTML from "./generated/members-ui.txt";
import WORKFLOW_CONFIGURATOR_HTML from "./generated/workflow-ui.txt";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/account-ui.txt";

export { InferLabLogin, InferOpsCredentials, InferOpsSystemCredentials, MockInferOps };

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
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/health/ready")) {
      const endpoint = inferOpsApiEndpoint(env);
      if (!endpoint) return Response.json({ status: "down", checks: [{ name: "inferops-config", status: "down" }] }, { status: 503 });
      try {
        const response = await inferLabFetch(env)(`${endpoint.baseUrl}/health/ready`, {
          headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5_000),
        });
        const body = await response.json().catch(() => null) as { status?: unknown; checks?: unknown } | null;
        const ready = response.status === 200 && (body?.status === "ok" || body?.status === "degraded");
        const checks = Array.isArray(body?.checks) ? body.checks.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const check = item as { name?: unknown; status?: unknown };
          return typeof check.name === "string" && typeof check.status === "string"
            ? [{ name: check.name, status: check.status }] : [];
        }) : [];
        return Response.json({ status: ready ? body?.status : "down", checks }, { status: ready ? 200 : 503 });
      } catch {
        return Response.json({ status: "down", checks: [{ name: "inferops-api", status: "unreachable" }] }, { status: 503 });
      }
    }
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
type AccountProps = {
  accountId: string; email?: string; connected?: boolean;
  /**
   * Set only on a configured system workflow's binding (FAC-102, `getSystemGatekeeperClass`): the
   * Workshop's assignment reference whose stored service-account key the binding acts as. Such a
   * binding never reaches a person's token, the stopgap connection or the mock.
   */
  systemCredentialRef?: string;
};

/** What `clientFor` needs to know about an account. */
type AccountRef = Pick<AccountProps, "accountId" | "connected" | "systemCredentialRef">;

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

/**
 * One custom-table binding, fixed when the Workshop mints it: the workspace's `host`, the table's
 * id and, for a connected account, the InferOps workspace the host's slug resolved to.
 */
type TableGatekeeperProps = AccountRef & { host: string; tableId: string; workspaceId?: string };

/**
 * One workspace-members binding, fixed when the Workshop mints it: the workspace's `host` and, for
 * a connected account, the InferOps workspace the host's slug resolved to.
 */
type MembersGatekeeperProps = AccountRef & { host: string; workspaceId?: string };

/**
 * One workflow-policy binding, fixed when the Workshop mints it: the workspace's `host`, the project
 * key and, for a connected account, the InferOps workspace the host's slug resolved to.
 */
type WorkflowPolicyGatekeeperProps = AccountRef & { host: string; projectKey: string; workspaceId?: string };

/**
 * One account binding, fixed when the Workshop mints it: the account and the organization's tenant
 * label (or `demo.local`). No workspace, project or Wiki: each is resolved when it is opened.
 */
type AccountGatekeeperProps = AccountRef & { tenant: string };

type ExportsWithStores = {
  MockInferOps: DurableObjectNamespace<MockInferOps>;
  InferOpsCredentials: DurableObjectNamespace<InferOpsCredentials>;
  InferOpsSystemCredentials: DurableObjectNamespace<InferOpsSystemCredentials>;
};

function systemCredentialsOf(exports: ExportsWithStores, credentialRef: string) {
  return exports.InferOpsSystemCredentials.get(exports.InferOpsSystemCredentials.idFromName(credentialRef));
}

/** What a system run's call is refused with when nothing usable is provisioned for it (FAC-102). */
const NO_SYSTEM_CREDENTIAL = "No service account is provisioned for this workflow's runs.";

/** What a system session says when InferOps refuses the service-account key (FAC-102 follow-up C). */
const SYSTEM_KEY_REFUSED = "The assignment's service-account key was refused. An Admin needs to assign it again.";

/**
 * The refusal for a service-account key InferOps rejected: still an `UNAUTHORIZED` InferOpsError,
 * so every mapping by code is unchanged, but worded for the assignment and named plainly, so the
 * message a run or an approver sees carries no `InferOpsError:` prefix.
 */
function systemKeyRefused(cause: InferOpsError): InferOpsError {
  const refused = new InferOpsError("UNAUTHORIZED", SYSTEM_KEY_REFUSED, cause.facts);
  refused.name = "Error";
  return refused;
}

/**
 * A system workflow run's client (FAC-102): its authority is the service-account key stored for
 * `credentialRef`, read per request, and only for the `host` it was checked for. Nothing provisioned
 * is UNAUTHORIZED; there is no fallback to anyone's token, the stopgap or the mock. InferOps refusing
 * the key (revoked) fails the call as any refused credential does.
 */
function systemClient(env: Cloudflare.Env, exports: ExportsWithStores, credentialRef: string, host: string): InferOpsClient {
  const endpoint = inferOpsApiEndpoint(env);
  if (!endpoint || host === DEMO_HOST) throw new InferOpsError("UNAUTHORIZED", NO_SYSTEM_CREDENTIAL);
  return openHttpInferOpsClient({
    ...endpoint,
    async authorize(operation) {
      const authority = await systemCredentialsOf(exports, credentialRef).authority(host);
      if (!authority) throw new InferOpsError("UNAUTHORIZED", NO_SYSTEM_CREDENTIAL);
      try {
        return await operation(authority);
      } catch (error) {
        // A refused service-account key is the assignment's to fix, not a person's to reconnect
        // (FAC-102 follow-up C): named as such, without the person-oriented hint or a class name.
        if (error instanceof InferOpsError && error.code === "UNAUTHORIZED") throw systemKeyRefused(error);
        throw error;
      }
    },
  }, inferLabFetch(env));
}

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
  env: Cloudflare.Env, exports: ExportsWithStores, endpoint: InferOpsEndpoint, accountId: string,
  workspaceId: string, options: { fenceSuccess?: boolean } = {},
): InferOpsClient {
  const source = accountSource(exports, accountId, workspaceId);
  return openHttpInferOpsClient({
    ...endpoint,
    async authorize(operation) {
      let sent = false;
      try {
        // Every InferOps call here is safe to repeat: reads, or a write under its own
        // idempotency key.
        return await source.run(async (authority, read) => {
          sent = true;
          const result = await operation(authority);
          if (options.fenceSuccess) await assertConnectionUnchanged(source, read);
          return result;
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
  }, inferLabFetch(env));
}

/**
 * The connected person's authority in `workspaceId` (one of their own), fetched per operation from
 * the account's `InferOpsCredentials` object; a token InferOps rejects is adjudicated there.
 */
function accountSource(
  exports: ExportsWithStores, accountId: string, workspaceId: string,
  options: { redactAccountErrors?: boolean } = {},
): CredentialSource<InferOpsAuthority> {
  return new CredentialSource<InferOpsAuthority>({
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
    ...options,
  });
}

/** What a fenced read says when the connection moved while it was in flight. */
const CONNECTION_CHANGED = "This InferOps connection changed. Try again.";

/**
 * The completion fence of a read: a successful answer counts only if the account still holds the
 * connection (identity and generation) the request was sent under. A reconnect or a revoke that
 * completed while the request was in flight discards the answer before anything uses it. A
 * session confirmed dead is `UNAUTHORIZED`; any other failure to vouch is `UNAVAILABLE`, and the
 * next read reports the account's real state.
 */
async function assertConnectionUnchanged(
  source: CredentialSource<InferOpsAuthority>, sent: CredentialRead,
): Promise<void> {
  let now: CredentialRead;
  try {
    now = await source.read();
  } catch (error) {
    // Only the code crosses RPC; what the account said stays out of the answer.
    throw new InferOpsError(isCredentialsExpired(error) ? "UNAUTHORIZED" : "UNAVAILABLE",
      isCredentialsExpired(error) ? EXPIRED_MESSAGE : CONNECTION_CHANGED);
  }
  if (now.identity !== sent.identity || now.generation !== sent.generation) {
    throw new InferOpsError("UNAVAILABLE", CONNECTION_CHANGED);
  }
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
  // A system run's binding acts only as its stored service account (FAC-102), never anything below.
  if (account.systemCredentialRef !== undefined) return systemClient(env, exports, account.systemCredentialRef, host);
  const mock = () => openInferOpsClient(exports.MockInferOps, { accountId: account.accountId, host });
  if (host === DEMO_HOST) return mock();
  if (account.connected) {
    const endpoint = inferOpsApiEndpoint(env);
    if (endpoint && workspaceId) return accountClient(env, exports, endpoint, account.accountId, workspaceId);
  } else {
    const stopgap = connectionFromEnv(env);
    if (stopgap && parseHost(host)?.workspace === stopgap.workspaceSlug) {
      return openHttpInferOpsClient(stopgap, inferLabFetch(env));
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

/**
 * The data source for a custom-table binding, refused with `DISABLED` on every call while InferOps
 * or custom tables are off. The mock for the demo host, or a connected person's own authority in
 * `workspaceId`; never the stopgap connection. Anything else reads as a missing table.
 */
function tableClientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  return whileTablesEnabled(env, () => {
    if (host === DEMO_HOST) {
      return openInferOpsClient(exports.MockInferOps, { accountId: account.accountId, host });
    }
    const endpoint = account.connected ? inferOpsApiEndpoint(env) : null;
    if (!endpoint || !workspaceId) throw tableNotFound();
    // Reads only, so every successful answer is fenced against a reconnect or revoke in flight.
    return accountClient(env, exports, endpoint, account.accountId, workspaceId, { fenceSuccess: true });
  });
}

/**
 * The data source for a workspace-members binding, refused with `DISABLED` on every call while
 * InferOps or workspace members are off. The mock for the demo host, or a connected person's own
 * authority in `workspaceId`; never the stopgap connection. Anything else reads as no member list.
 */
function membersClientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  return whileMembersEnabled(env, () => {
    if (host === DEMO_HOST) {
      return openInferOpsClient(exports.MockInferOps, { accountId: account.accountId, host });
    }
    const endpoint = account.connected ? inferOpsApiEndpoint(env) : null;
    if (!endpoint || !workspaceId) throw membersNotFound();
    // Reads only, so every successful answer is fenced against a reconnect or revoke in flight.
    return accountClient(env, exports, endpoint, account.accountId, workspaceId, { fenceSuccess: true });
  });
}

/**
 * The data source for a workflow-policy binding, refused with `DISABLED` on every call while
 * InferOps or workflow policies are off. The mock for the demo host, or a connected person's own
 * authority in `workspaceId`; never the stopgap connection. Anything else reads as no policy.
 */
function workflowPolicyClientFor(
  env: Cloudflare.Env, exports: ExportsWithStores, account: AccountRef, host: string,
  workspaceId?: string,
): InferOpsClient {
  return whileWorkflowPolicyEnabled(env, () => {
    if (host === DEMO_HOST) {
      return openInferOpsClient(exports.MockInferOps, { accountId: account.accountId, host });
    }
    const endpoint = account.connected ? inferOpsApiEndpoint(env) : null;
    if (!endpoint || !workspaceId) throw workflowPolicyNotFound();
    // Reads only, so every successful answer is fenced against a reconnect or revoke in flight.
    return accountClient(env, exports, endpoint, account.accountId, workspaceId, { fenceSuccess: true });
  });
}

/**
 * Who a host-board read may run as: only a connected person, against the configured API, in the
 * workspace the binding resolved. The demo host, the stopgap connection, an account without an
 * identity and a binding without a resolved workspace are `not-connected`; there is no fallback to
 * any of them. A connected binding on a deployment whose API endpoint is missing or malformed
 * (`INFEROPS_BASE_URL`, or the InferLab origin standing in for it) is `unavailable`. Throws
 * nothing: endpoint parsing is inside this boundary.
 */
function hostBoardAuthority(env: Cloudflare.Env, exports: ExportsWithStores, props: ProjectGatekeeperProps):
    { endpoint: InferOpsEndpoint; source: CredentialSource<InferOpsAuthority>; workspaceId: string } |
    "not-connected" | "unavailable" {
  if (!props.connected || props.host === DEMO_HOST || !props.workspaceId) return "not-connected";
  let endpoint: InferOpsEndpoint | null;
  try {
    endpoint = inferOpsApiEndpoint(env);
  } catch {
    // A malformed INFEROPS_BASE_URL: its message names the variable, and is not passed on either.
    return "unavailable";
  }
  if (!endpoint) return "unavailable";
  // Redacted: a failed adjudication RPC is logged as a fixed classification, never its error.
  return { endpoint,
           source: accountSource(exports, props.accountId, props.workspaceId, { redactAccountErrors: true }),
           workspaceId: props.workspaceId };
}

/**
 * The kernel-only read of a board binding's fixed target (`HostBoardReader`, host-board.ts): one
 * `project.board_snapshot` request, built from the props alone, as the connected person. The read
 * of the attempt that actually answered (the retry, after a token InferOps rejected was healed) is
 * the fence; once the answer is in, the account must still hold exactly that connection
 * (`assertConnectionUnchanged`), or the answer is discarded as `stale`. Never throws, never
 * observes, and never falls back to `project.board`, the project list, demo data or another
 * account. A snapshot whose scope or project is not the binding's is a provider failure.
 */
async function readHostBoard(env: Cloudflare.Env, exports: ExportsWithStores,
                             props: ProjectGatekeeperProps): Promise<HostBoardRead> {
  try {
    return await readHostBoardOnce(env, exports, props);
  } catch {
    // The normalization boundary: nothing thrown below leaves as an error or a cause.
    return unavailable("provider");
  }
}

async function readHostBoardOnce(env: Cloudflare.Env, exports: ExportsWithStores,
                                 props: ProjectGatekeeperProps): Promise<HostBoardRead> {
  if (!hostBoardsEnabled(env)) return unavailable("disabled");
  const ref = hostBoardRef(props.host, props.projectKey);
  if (ref === null) return unavailable("invalid-target");
  const authority = hostBoardAuthority(env, exports, props);
  if (authority === "not-connected") return HOST_BOARD_NOT_CONNECTED;
  if (authority === "unavailable") return unavailable("provider");
  const { endpoint, source, workspaceId } = authority;
  let sent: CredentialRead | undefined;
  let answer: BoardSnapshotAnswer;
  try {
    answer = await source.run(async ({ token }, read) => {
      sent = read;
      return fetchBoardSnapshot(endpoint.baseUrl, token, ref, inferLabFetch(env));
    }, { replayable: true });
  } catch (error) {
    if (isCredentialsExpired(error)) return HOST_BOARD_NOT_CONNECTED;
    if (isCredentialsChanged(error)) return HOST_BOARD_STALE;
    // A rejection the account could not adjudicate, or a membership the account no longer holds:
    // nothing of the cause is passed on.
    return unavailable("provider");
  }
  try {
    await assertConnectionUnchanged(source, sent!);
  } catch {
    return HOST_BOARD_STALE;
  }
  if (answer.kind === "refused") return unavailable(answer.reason);
  const { scope, snapshot } = answer;
  if (scope.workspaceId !== workspaceId.toLowerCase() || snapshot.project.identifier !== props.projectKey) {
    return unavailable("provider");
  }
  return {
    status: "ok", scope, snapshot,
    fence: { accountId: props.accountId, identity: sent!.identity, generation: sent!.generation },
  };
}

/**
 * The current fence of a board binding's connection (`HostBoardConnectionFence`), or null when the
 * lane is off, no connected person backs the binding, or the deployment's endpoint is unusable.
 * Throws nothing.
 */
async function hostBoardFence(env: Cloudflare.Env, exports: ExportsWithStores,
                              props: ProjectGatekeeperProps): Promise<HostBoardFence | null> {
  try {
    if (!hostBoardsEnabled(env)) return null;
    const authority = hostBoardAuthority(env, exports, props);
    if (typeof authority === "string") return null;
    const { identity, generation } = await authority.source.read();
    return { accountId: props.accountId, identity, generation };
  } catch {
    return null;
  }
}

/**
 * The resource kinds offered now: coding dispatch, custom tables, members and workflow policies only
 * while each is on.
 */
function supportedResources(env: Cloudflare.Env): SupportedResource[] {
  return [
    PROJECT_BOARD_RESOURCE,
    ...(codingWorkbenchEnabled(env) ? [PROJECT_DISPATCH_RESOURCE] : []),
    KNOWLEDGE_WIKI_RESOURCE,
    ...(tablesEnabled(env) ? [OBJECT_TABLE_RESOURCE] : []),
    ...(membersEnabled(env) ? [PORTAL_MEMBERS_RESOURCE] : []),
    ...(workflowPolicyEnabled(env) ? [PROJECT_WORKFLOW_RESOURCE] : []),
    INFEROPS_ACCOUNT_RESOURCE,
  ];
}

/** The message every refused workflow-policy binding gets, whatever was missing or refused. */
function unavailableWorkflowPolicy(host: string): string {
  return `No InferOps workflow policy is available to you on ${host}.`;
}

/** The message every refused members binding gets, whatever was missing or refused. */
function unavailableMembers(host: string): string {
  return `No InferOps member list is available to you on ${host}.`;
}

/** The message every refused table binding gets, whatever was missing: workspace, host or table. */
function unavailableTable(host: string): string {
  return `No such InferOps custom table is available to you on ${host}.`;
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

  /**
   * Check `key` and store it as the service account for `credentialRef` (FAC-102), replacing any
   * stored before (a rotation). Kernel-only: the Workshop relays an Admin's key once and keeps
   * nothing of it. Before storing, InferOps itself must say the key is a service account in this
   * deployment's company (`auth.me`) with the board host's workspace among its own
   * (`GET /workspaces`). Any refusal is the one fixed `KEY_NOT_ACCEPTED`, never saying why or
   * repeating the key, which is never logged or returned. Boards only.
   */
  async provisionSystemCredential(credentialRef: string, connection: { resourceUrl: string }, key: string): Promise<void> {
    if (!CREDENTIAL_REF.test(credentialRef) || typeof key !== "string" || !key) throw new Error(KEY_NOT_ACCEPTED);
    const endpoint = inferOpsApiEndpoint(this.env);
    const company = deploymentCompany(this.env);
    let host: string;
    try {
      host = parseProjectBoardUrl(connection.resourceUrl).host;
    } catch {
      throw new Error(KEY_NOT_ACCEPTED);
    }
    const labels = parseHost(host);
    if (!endpoint || !company || !labels) throw new Error(KEY_NOT_ACCEPTED);
    let checked: { workspaceId: string; tenantId: string };
    try {
      const fetcher = inferLabFetch(this.env);
      const workspace = (await listWorkspaceSlugs(endpoint.baseUrl, key, fetcher)).find(w => w.slug === labels.workspace);
      if (!workspace) throw new Error("workspace");
      const me = await readCallerPrincipal(endpoint.baseUrl, key, workspace.workspaceId, fetcher);
      if (me.principalType !== "service_account" || !companyAdmits(company, me.tenantId)) throw new Error("principal");
      checked = { workspaceId: workspace.workspaceId, tenantId: me.tenantId };
    } catch {
      logger.warn("system credential not accepted", { event: "system_credential.refused" });
      throw new Error(KEY_NOT_ACCEPTED);
    }
    const stored = await systemCredentialsOf(this.ctx.exports, credentialRef).store({
      key, workspaceId: checked.workspaceId, host, tenantId: checked.tenantId, provisionedAt: Date.now(),
    });
    // The reference was retired while the key was being checked (#375 round 2): nothing was kept.
    if (!stored) {
      logger.warn("system credential not stored for a retired reference", { event: "system_credential.retired" });
      throw new Error(KEY_NOT_ACCEPTED);
    }
  }

  /**
   * Delete the key stored for `credentialRef`, if any, and retire the reference so that no later
   * store lands for it (FAC-102, #375 round 2). Kernel-only.
   */
  async forgetSystemCredential(credentialRef: string): Promise<void> {
    if (!CREDENTIAL_REF.test(credentialRef)) return;
    await systemCredentialsOf(this.ctx.exports, credentialRef).forget();
  }

  /**
   * The class a configured system workflow's run binds through for `credentialRef` (FAC-102): the
   * project-board gatekeeper for `connection.resourceUrl`, acting only as the key stored for the
   * reference. Its props carry the reference, never the key. Boards only; other resources refuse.
   */
  @skipRpcValidation()
  async getSystemGatekeeperClass(credentialRef: string, connection: { resourceUrl: string }):
      Promise<DurableObjectClass<Gatekeeper<any>>> {
    if (!CREDENTIAL_REF.test(credentialRef)) throw new Error(NO_SYSTEM_CREDENTIAL);
    const { host, projectKey } = parseProjectBoardUrl(connection.resourceUrl);
    const props: ProjectGatekeeperProps = {
      accountId: `system:${credentialRef}`, connected: false, systemCredentialRef: credentialRef, host, projectKey,
    };
    return this.ctx.exports.InferOpsProjectGatekeeper({ props }) as unknown as DurableObjectClass<Gatekeeper<any>>;
  }
}

/** The one refusal for a service-account key this gatekeeper won't store (FAC-102). */
const KEY_NOT_ACCEPTED = "The key wasn't accepted.";

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
    if (kind === "account") return this.#accountClassFor(url);
    if (kind === "wiki") return this.#wikiClassFor(url);
    if (kind === "table") return this.#tableClassFor(url);
    if (kind === "members") return this.#membersClassFor(url);
    // Before the board fallthrough below, which would otherwise be the only thing refusing it.
    if (kind === "workflow") return this.#workflowPolicyClassFor(url);
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
   * Bind one account (inferos ADR 0015): the demo data, or the boards and Wikis of a connected
   * person's own workspaces in the URL's organization. Nothing is resolved now: each reference is
   * checked when it is opened. The stopgap connection is refused, since no person stands behind it.
   */
  async #accountClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    const { tenant } = parseAccountUrl(url);
    const { accountId, connected } = this.ctx.props;
    if (tenant !== DEMO_HOST && !(connected && inferOpsApiEndpoint(this.env))) {
      throw new Error(`No InferOps account is available to you in ${tenant}.`);
    }
    const props: AccountGatekeeperProps = { accountId, connected, tenant };
    return {
      class: this.ctx.exports.InferOpsAccountGatekeeper({ props }), resource: INFEROPS_ACCOUNT_RESOURCE,
      mock: tenant === DEMO_HOST,
    };
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

  /**
   * Bind one custom table: custom tables must be on; the URL's workspace slug must be one of the
   * person's InferOps workspaces; and the table must answer one read through InferOps' scoped
   * `object.embed` for the URL's whole `<tenant>.<workspace>`, which InferOps checks. A workspace
   * the person lacks, an account with no sign-in, a tenant label that is not theirs and a missing or
   * unreadable table are all refused with one message. The probe returns nothing to anyone.
   */
  async #tableClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    assertTablesEnabled(this.env);
    const { host, tableId } = parseTableUrl(url);
    const { accountId, connected } = this.ctx.props;
    const workspaceId = host === DEMO_HOST ? undefined : await this.#workspaceFor(host);
    if (workspaceId === null) throw new Error(unavailableTable(host));
    try {
      await tableClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId)
        .readTable(host, tableId, { limit: 1 });
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") throw new Error(unavailableTable(host), { cause: error });
      throw error;
    }
    const props: TableGatekeeperProps = { accountId, connected, host, tableId, workspaceId };
    return {
      class: this.ctx.exports.InferOpsTableGatekeeper({ props }), resource: OBJECT_TABLE_RESOURCE,
      mock: host === DEMO_HOST,
    };
  }

  /**
   * Bind one workspace's member list: workspace members must be on; the URL's workspace slug must
   * be one of the person's InferOps workspaces; and InferOps' `member.list` must answer one read for
   * that person there, under their own `member:read`. A workspace the person lacks (or an InferMind
   * one), an account with no sign-in, the stopgap connection, and a list that is missing or not
   * readable are all refused with one message. The probe returns nothing to anyone.
   */
  async #membersClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    assertMembersEnabled(this.env);
    const { host } = parseMembersUrl(url);
    const { accountId, connected } = this.ctx.props;
    const workspaceId = host === DEMO_HOST ? undefined : await this.#workspaceFor(host);
    if (workspaceId === null) throw new Error(unavailableMembers(host));
    try {
      await membersClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId)
        .listWorkspaceMembers(workspaceId);
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") throw new Error(unavailableMembers(host), { cause: error });
      throw error;
    }
    const props: MembersGatekeeperProps = { accountId, connected, host, workspaceId };
    return {
      class: this.ctx.exports.InferOpsMembersGatekeeper({ props }), resource: PORTAL_MEMBERS_RESOURCE,
      mock: host === DEMO_HOST,
    };
  }

  /**
   * Bind one project's workflow policy: workflow policies must be on (checked first); the URL's
   * workspace slug must be one of the person's InferOps workspaces; and one read must answer for
   * that person there: the key in that workspace's project list, then that project's
   * `workflow.get`, parsed strictly, under their own `project:read`. A workspace the person lacks
   * (or an InferMind one), an account with no sign-in, the stopgap connection, and a project or
   * policy that is missing or not readable are all refused with one message. The probe returns
   * nothing to anyone and is not an observation.
   */
  async #workflowPolicyClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
    mock: boolean;
  }> {
    assertWorkflowPolicyEnabled(this.env);
    const { host, projectKey } = parseProjectWorkflowUrl(url);
    const { accountId, connected } = this.ctx.props;
    const workspaceId = host === DEMO_HOST ? undefined : await this.#workspaceFor(host);
    if (workspaceId === null) throw new Error(unavailableWorkflowPolicy(host));
    try {
      await workflowPolicyClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId)
        .readWorkflowPolicy(projectKey);
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") {
        throw new Error(unavailableWorkflowPolicy(host), { cause: error });
      }
      throw error;
    }
    const props: WorkflowPolicyGatekeeperProps = { accountId, connected, host, projectKey, workspaceId };
    return {
      class: this.ctx.exports.InferOpsWorkflowPolicyGatekeeper({ props }), resource: PROJECT_WORKFLOW_RESOURCE,
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
        : resourceUrlPattern === OBJECT_TABLE_RESOURCE.urlPattern && tablesEnabled(this.env)
          ? TABLE_CONFIGURATOR_HTML
          : resourceUrlPattern === PORTAL_MEMBERS_RESOURCE.urlPattern && membersEnabled(this.env)
            ? MEMBERS_CONFIGURATOR_HTML
            : resourceUrlPattern === PROJECT_WORKFLOW_RESOURCE.urlPattern && workflowPolicyEnabled(this.env)
              ? WORKFLOW_CONFIGURATOR_HTML
              : resourceUrlPattern === INFEROPS_ACCOUNT_RESOURCE.urlPattern
                ? ACCOUNT_CONFIGURATOR_HTML
                : wiki ? WIKI_CONFIGURATOR_HTML : null;
    if (!iframeHtml) {
      throw new Error(`Unsupported InferOps resource configurator type: ${resourceUrlPattern}`);
    }
    const store = this.ctx.props.connected ? this.#credentials() : null;
    const stopgap = store ? null : connectionFromEnv(this.env);
    return {
      iframeHtml,
      ui: new RpcStub(new InferOpsProjectConfiguratorUI({
        // Demo data needs no organization or workspace; every other account must name both. An
        // account binding never uses the stopgap, so without a sign-in it is the demo's.
        defaultHost: store || (stopgap && resourceUrlPattern !== INFEROPS_ACCOUNT_RESOURCE.urlPattern)
          ? null : DEMO_HOST,
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
        tables: async host => {
          if (!tablesEnabled(this.env)) return [];
          const workspaceId = host === DEMO_HOST ? undefined : await this.#workspaceFor(host);
          if (workspaceId === null) return [];
          const { accountId, connected } = this.ctx.props;
          try {
            return await tableClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId)
              .listTables();
          } catch (error) {
            if (inferOpsErrorCode(error) === "NOT_FOUND" || inferOpsErrorCode(error) === "FORBIDDEN") return [];
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

  /**
   * Whether the connected person may `build` or `publish` configuration other people use in this
   * InferOS: InferOps' `configuration:<action>` (only an Admin's grant holds it, and a grant deny
   * removes it), asked with their own token in each of their workspaces until one says yes. The
   * answer is about one company only, the session's own (`scope`, its tenant id): a connection's
   * workspaces are all in its session's company, and a session in a company other than the one
   * `INFEROPS_COMPANY` names answers for nothing here. The Workshop refuses a person whose
   * connections answer for more than one company. An account without a connected person (demo
   * data, a sign-in) answers for nothing. A workspace InferOps refuses the question in is a no;
   * any other failure, or a malformed `INFEROPS_COMPANY`, throws, so the Workshop refuses rather
   * than guessing. Workspaces granted since the person connected count after they reconnect.
   */
  async holdsSharedConfiguration(action: SharedConfigurationAction): Promise<SharedConfigurationAnswer> {
    if (action !== "build" && action !== "publish") return { holds: false, scope: null };
    return this.#holdsInCompany(`configuration:${action}`);
  }

  /**
   * Whether the connected person may ask a configured system workflow to run against the board
   * `resourceUrl` names: InferOps' `workflow:invoke` (FAC-102; a person's `member`, `admin` or
   * `owner` grant holds it, a grant deny removes it, a service account never does), asked in that
   * board's own InferOps workspace only (the manager, 2026-11-05). The workspace is the board host's,
   * among the person's own InferOps memberships: an InferMind workspace, another workspace, a host
   * that isn't theirs or a reference that isn't a board answers no, asking nothing. The company
   * scope and its refusals are `holdsSharedConfiguration`'s; unlike it, no other workspace's grant
   * counts.
   */
  async holdsWorkflowInvoke(resourceUrl: string): Promise<SharedConfigurationAnswer> {
    const endpoint = inferOpsApiEndpoint(this.env);
    if (!this.ctx.props.connected || !endpoint) return { holds: false, scope: null };
    const company = deploymentCompany(this.env);
    if (!company) throw new InferOpsError("UNAVAILABLE", COMPANY_MISCONFIGURED);
    const identity = await this.#credentials().identity();
    if (!identity?.tenantId || !companyAdmits(company, identity.tenantId)) return { holds: false, scope: null };
    const scope = identity.tenantId.toLowerCase();
    let host: string;
    try {
      host = parseProjectBoardUrl(resourceUrl).host;
    } catch {
      return { holds: false, scope };
    }
    const labels = parseHost(host);
    const workspaceId = labels ? await this.#credentials().resolveWorkspace(labels.workspace, "inferops") : null;
    if (!workspaceId) return { holds: false, scope };
    const client = whileInferOpsEnabled(this.env, () =>
      accountClient(this.env, this.ctx.exports, endpoint, this.ctx.props.accountId, workspaceId));
    return { holds: await client.holdsPermission("workflow:invoke"), scope };
  }

  // The person's own answer to one InferOps permission, in this deployment's company (see
  // holdsSharedConfiguration). `permission` is one of the fixed names above, never a caller's.
  async #holdsInCompany(permission: "configuration:build" | "configuration:publish"):
      Promise<SharedConfigurationAnswer> {
    const nothing = { holds: false, scope: null };
    const endpoint = inferOpsApiEndpoint(this.env);
    if (!this.ctx.props.connected || !endpoint) return nothing;
    const company = deploymentCompany(this.env);
    if (!company) throw new InferOpsError("UNAVAILABLE", COMPANY_MISCONFIGURED);
    const identity = await this.#credentials().identity();
    if (!identity?.tenantId || !companyAdmits(company, identity.tenantId)) return nothing;
    const scope = identity.tenantId.toLowerCase();
    for (const { workspaceId } of identity.workspaces) {
      const client = whileInferOpsEnabled(this.env, () =>
        accountClient(this.env, this.ctx.exports, endpoint, this.ctx.props.accountId, workspaceId));
      if (await client.holdsPermission(permission)) return { holds: true, scope };
    }
    return { holds: false, scope };
  }

  /**
   * The company the connected person works in here (FAC-88): their session's tenant id, as
   * `holdsSharedConfiguration` scopes its answer, read from the identity stored at connect without
   * asking InferOps anything. Null for an account without a connected person (demo data, a
   * sign-in) and for a session in a company `INFEROPS_COMPANY` doesn't admit; a malformed
   * `INFEROPS_COMPANY` throws, so the Workshop refuses rather than guessing.
   */
  async presentationCompany(): Promise<string | null> {
    if (!this.ctx.props.connected) return null;
    const company = deploymentCompany(this.env);
    if (!company) throw new InferOpsError("UNAVAILABLE", COMPANY_MISCONFIGURED);
    const identity = await this.#credentials().identity();
    if (!identity?.tenantId || !companyAdmits(company, identity.tenantId)) return null;
    return identity.tenantId.toLowerCase();
  }

  /**
   * The workspaces in which the connected person may list widgets for their company: each of their
   * workspaces where InferOps' `configuration:publish` holds, asked with their own token, in the
   * order their identity lists them (FAC-11). Nothing for an account without a connected person, or
   * a session in another company than `INFEROPS_COMPANY` names, as `holdsSharedConfiguration`.
   */
  async widgetIndexWorkspaces(): Promise<WidgetIndexWorkspace[]> {
    const identity = await this.#widgetIndexIdentity();
    if (!identity) return [];
    const found: WidgetIndexWorkspace[] = [];
    for (const { workspaceId, workspaceName } of identity.workspaces) {
      if (await this.#widgetIndexClient(identity.endpoint, workspaceId).holdsPermission("configuration:publish")) {
        found.push({ workspaceId, name: workspaceName });
      }
    }
    return found;
  }

  /**
   * The widgets the connected person may use that match `query` (FAC-13): InferOps' `widget.search`
   * asked in each of their workspaces, with their own credentials, and merged (mergeWidgetSearches).
   * `unavailable` with `reconnect` for an account without a connected person of the deployment's
   * company (the stopgap bearer, demo data, a sign-in to renew), and with `no-workspace` when InferOps
   * gives them none. A workspace where InferOps refuses for a missing `knowledge:read` is `denied`:
   * asked, it adds nothing. Any other failure in a workspace is `unsearched`, and if every workspace
   * failed so, the last failure is thrown.
   */
  async searchWidgets(query: string, k: number): Promise<WidgetSearchAnswer> {
    const identity = await this.#widgetIndexIdentity();
    if (!identity) return { status: "unavailable", reason: "reconnect" };
    if (identity.workspaces.length === 0) return { status: "unavailable", reason: "no-workspace" };
    const found: WidgetSearchResult[] = [];
    let denied = 0;
    let unsearched = 0;
    let lastFailure: unknown;
    for (const { workspaceId } of identity.workspaces) {
      try {
        found.push(await this.#widgetIndexClient(identity.endpoint, workspaceId).searchWidgets(query, k));
      } catch (error) {
        if (error instanceof InferOpsError && error.code === "FORBIDDEN" && error.detail === WIDGET_SEARCH_DENIED) {
          denied++;
          continue;
        }
        lastFailure = error;
        unsearched++;
      }
    }
    if (found.length === 0 && denied === 0) throw lastFailure;
    return mergeWidgetSearches(found, k, { denied, unsearched });
  }

  /** Lists one widget version in the person's own workspace `workspaceId`: `widget.publish`. */
  async registerWidget(workspaceId: string, entry: WidgetIndexEntry): Promise<WidgetIndexOutcome> {
    return this.#widgetIndexWrite(workspaceId, async client => {
      await client.publishWidgetDefinition(entry);
      return { status: "applied" };
    });
  }

  /** Removes one widget version's listing from the person's own workspace: `widget.withdraw`. */
  async withdrawWidget(workspaceId: string, sourceId: string, sourceVersion: number): Promise<WidgetIndexOutcome> {
    return this.#widgetIndexWrite(workspaceId, async client => ({
      status: "applied", removed: await client.withdrawWidgetDefinition(sourceId, sourceVersion),
    }));
  }

  // The connected person's identity and the API endpoint, when this account can write the widget
  // index at all: a connected person (never the stopgap bearer, a demo account or a sign-in) of the
  // deployment's company.
  async #widgetIndexIdentity() {
    const endpoint = inferOpsApiEndpoint(this.env);
    if (!this.ctx.props.connected || !endpoint) return null;
    const company = deploymentCompany(this.env);
    if (!company) throw new InferOpsError("UNAVAILABLE", COMPANY_MISCONFIGURED);
    const identity = await this.#credentials().identity();
    if (!identity?.tenantId || !companyAdmits(company, identity.tenantId)) return null;
    return { endpoint, workspaces: identity.workspaces };
  }

  #widgetIndexClient(endpoint: NonNullable<ReturnType<typeof inferOpsApiEndpoint>>, workspaceId: string) {
    return whileInferOpsEnabled(this.env, () =>
      accountClient(this.env, this.ctx.exports, endpoint, this.ctx.props.accountId, workspaceId));
  }

  // One widget index write as the connected person in `workspaceId`, which must be one of theirs,
  // answered as InferOps answered: a refusal in the gatekeeper's own words for it, never a success.
  async #widgetIndexWrite(workspaceId: string,
      write: (client: InferOpsClient) => Promise<WidgetIndexOutcome>): Promise<WidgetIndexOutcome> {
    const identity = await this.#widgetIndexIdentity();
    if (!identity) return { status: "refused", reason: WIDGET_INDEX_NO_SIGN_IN };
    if (!identity.workspaces.some(w => w.workspaceId === workspaceId)) {
      return { status: "refused", reason: "That InferOps workspace isn't one of yours." };
    }
    try {
      return await write(this.#widgetIndexClient(identity.endpoint, workspaceId));
    } catch (error) {
      const code = inferOpsErrorCode(error);
      const reason = error instanceof InferOpsError ? error.detail : "InferOps couldn't be reached.";
      if (code === "FORBIDDEN" || code === "INVALID_REQUEST" || code === "NOT_FOUND" || code === "UNAUTHORIZED") {
        return { status: "refused", reason };
      }
      return { status: "unavailable", reason };
    }
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

/** Why an account lists no widget: only a person's own InferOps sign-in may (FAC-11). */
const WIDGET_INDEX_NO_SIGN_IN = "Sign in to InferOps as yourself to list this console's widgets for your company.";

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
  /** The custom tables this account can open on `host`; empty while tables are off. */
  tables(host: string): Promise<{ id: string; label: string }[]>;
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

  async listTables(query: string, host: string): Promise<ConfiguratorUIOption[]> {
    if (host !== DEMO_HOST && !parseHost(host)) {
      throw new Error("Enter your organization and choose a workspace first.");
    }
    const needle = query.trim().toLowerCase();
    return (await this.#source().tables(host))
      .filter(t => !needle || t.label.toLowerCase().includes(needle) || t.id.includes(needle))
      .slice(0, OPTION_LIMIT)
      .map(t => ({ value: t.id, title: t.label, subtitle: t.id }));
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
const PRIVATE_SERVICE_QUERY = "private:service-query";
const NEXT_ACTION_KEY = "nextActionId";
const INSTANCE_KEY = "instanceId";

/**
 * Where one binding's action records live: its facet's storage, each record under `prefix` plus its
 * action id. A board, dispatch or Wiki facet serves one binding and keeps its records under
 * `action:`, as it always has. The id counter and the instance id stay facet-wide, so ids and
 * idempotency keys never repeat within a facet whatever its stores.
 */
class ActionStore {
  constructor(readonly kv: SyncKvStorage, readonly prefix: string = ACTION_PREFIX) {}

  /** A recorded action; a record from before creates and updates reads as a transition. */
  get(actionId: number): ActionRecord | undefined {
    return readAction(this.kv.get(this.prefix + actionId));
  }

  put(record: ActionRecord): void {
    this.kv.put(this.prefix + record.actionId, record);
  }

  delete(actionId: number): void {
    this.kv.delete(this.prefix + actionId);
  }

  /** Every record of this store, in key order. */
  *records(): Generator<ActionRecord> {
    for (const [, raw] of this.kv.list({ prefix: this.prefix })) {
      const record = readAction(raw);
      if (record) yield record;
    }
  }
}

/** The collaborators a facet admitted, by id, from its own storage. */
function admittedObservers(kv: SyncKvStorage): string[] {
  return Array.from(kv.list({ prefix: OBSERVER_PREFIX }), ([key]) => key.slice(OBSERVER_PREFIX.length));
}

/** What a binding is made of, besides its target. */
type BindingParts = {
  /**
   * For a board or Wiki opened through an account binding: the resolved target its actions record
   * and are fingerprinted within, and how approvals name it (the binding itself no longer does).
   */
  account?: { scope: ActionScope; label: string };
  /** Where its action records live. */
  store: ActionStore;
  /** Its data source, as the person (or the demo) in its workspace. */
  client: InferOpsClient;
  /**
   * The collaborators it currently serves, by id: excluded from reads that reveal more than their
   * admission covered (a board search, a page's composed text) and blocking owner-only decisions.
   */
  observers: () => string[];
  /** Authorizes one observation; the approval queue's own, unchanged, unless given. */
  observe?: (queue: RpcStub<ApprovalQueue>, description: ObservationDescription) => Promise<void>;
  /**
   * Authorizes an observation no collaborator's admission covers (a board search, a page's
   * composed text). Unless given: excluding every current collaborator, through `observe`.
   */
  withhold?: (queue: RpcStub<ApprovalQueue>, description: ObservationDescription) => Promise<void>;
  /**
   * A Wiki's search throttle: null when a search may run, else the seconds until one may. Per
   * connected account, across all its bindings (`InferOpsCredentials.admitWikiSearch`).
   */
  admitSearch?: () => Promise<number | null>;
};

/**
 * A binding's action store and data source: the parts every kind of binding shares. `scope` keys
 * the fingerprints: the bound project's key, or `knowledge/wiki`, or for a board or Wiki opened
 * through an account binding its resolved target, which every record then carries.
 */
class ActionBinding {
  readonly store: ActionStore;
  readonly client: InferOpsClient;
  readonly observers: () => string[];
  readonly scope: FingerprintScope;
  /** How an approval names the target, for an account binding's board or Wiki; else undefined. */
  readonly targetLabel: string | undefined;
  readonly #observe: BindingParts["observe"];
  readonly #withhold: BindingParts["withhold"];

  constructor(parts: BindingParts, facetScope: string) {
    this.store = parts.store;
    this.client = parts.client;
    this.observers = parts.observers;
    this.scope = parts.account?.scope ?? facetScope;
    this.targetLabel = parts.account?.label;
    this.#observe = parts.observe;
    this.#withhold = parts.withhold;
  }

  /**
   * An approval description introduced by `intro`, naming the target first when the binding does
   * not name it itself (a board or Wiki opened through an account binding).
   */
  description(intro: string): ReturnType<typeof buildDescription> {
    const builder = buildDescription(intro);
    return this.targetLabel === undefined ? builder : builder.inline("Target", this.targetLabel);
  }

  get kv(): SyncKvStorage {
    return this.store.kv;
  }

  /** Authorize an observation of this binding's data before it is returned. */
  observe(queue: RpcStub<ApprovalQueue>, description: ObservationDescription): Promise<void> {
    return this.#observe ? this.#observe(queue, description) : queue.authorizeObservation(description);
  }

  /**
   * Authorize an observation that reveals more than any collaborator was admitted for: by default
   * excluding every current one, or as the binding's `withhold` part decides.
   */
  observeWithheld(queue: RpcStub<ApprovalQueue>, description: ObservationDescription): Promise<void> {
    if (this.#withhold) return this.#withhold(queue, description);
    const observers = this.observers();
    return this.observe(queue, observers.length > 0 ? { ...description, excludeObservers: observers } : description);
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
    return this.store.get(actionId);
  }

  putAction(record: ActionRecord): void {
    this.store.put(record);
  }

  deleteAction(actionId: number): void {
    this.store.delete(actionId);
  }

  /**
   * Record a pending action, with the fingerprint of the request it will send, before it is
   * submitted, so an immediate apply can find it.
   */
  async stage(staged: StagedAction, guard?: () => void, onStaged?: (id: number) => void): Promise<number> {
    return (await this.stageOnce(staged, false, guard, onStaged)).actionId;
  }

  /**
   * Like `stage`, but when `join` is set, a pending action whose request has the same fingerprint
   * is returned instead (`joined`), and nothing new is staged. The lookup and the write happen in
   * one synchronous step after the fingerprint is computed, so two concurrent proposals of one
   * request (two tabs) cannot both stage it. `guard`, when given, runs in that same synchronous
   * step, before anything is written, so a check of other pending actions (one edit per target)
   * cannot be overtaken by a concurrent proposal; it throws to refuse.
   */
  async stageOnce(staged: StagedAction, join = true, guard?: () => void,
      onStaged?: (id: number) => void): Promise<{ actionId: number; joined: boolean }> {
    const fingerprint = await fingerprintOf(this.scope, staged);
    guard?.();
    if (join) {
      for (const record of this.store.records()) {
        if (record.status === "pending" && record.fingerprint === fingerprint) {
          return { actionId: record.actionId, joined: true };
        }
      }
    }
    const actionId = this.kv.get<number>(NEXT_ACTION_KEY) ?? 1;
    this.kv.put(NEXT_ACTION_KEY, actionId + 1);
    const scope = typeof this.scope === "string" ? {} : { scope: this.scope };
    this.putAction({ ...staged, ...scope, actionId, status: "pending", fingerprint, attempts: {} } as ActionRecord);
    onStaged?.(actionId);
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
  }): Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
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
    return { applied: { result: appliedResult(applied) } };
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
      ? error instanceof CheckRefused ? error.reason : applyFailureMessage(record, code, detailOf(error))
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

  /**
   * Submit a staged action and return its receipt (FAC-97), which the write hands to its caller;
   * if it was not submitted, forget it so it is no longer simulated.
   */
  async submit(queue: RpcStub<ApprovalQueue>, actionId: number,
               description: Parameters<ApprovalQueue["submitAction"]>[1]): Promise<Receipt> {
    try {
      return await queue.submitAction(actionId, description);
    } catch (error) {
      // Not submitted (unless an auto-approval already applied it), so stop simulating it.
      if (this.action(actionId)?.status === "pending") this.deleteAction(actionId);
      throw error;
    }
  }
}

/** A write's receipt as the approval queue returns it over RPC, handed on to the caller. */
type Receipt = Awaited<ReturnType<RpcStub<ApprovalQueue>["submitAction"]>>;

/** One InferOps workspace `findBoards` searches: its host and a data source in it. */
type DiscoverySource = { host: string; client: InferOpsClient };

/**
 * A project binding (board or coding dispatch): the bound project and its simulated board. `target`
 * is its scope, which no session method takes as an argument: for a facet, the props the Workshop
 * minted it with.
 */
class ProjectBinding extends ActionBinding {
  /**
   * `otherWorkspaces` lists the person's other InferOps workspaces for `findBoards`, each with a
   * data source as the same person; omitted where there is no person to list them for.
   */
  constructor(readonly target: ProjectGatekeeperProps, parts: BindingParts,
              readonly otherWorkspaces: () => Promise<DiscoverySource[]> = async () => []) {
    super(parts, target.projectKey);
  }

  get projectKey(): string {
    return this.target.projectKey;
  }

  pending(): Pending {
    const changes: Pending["changes"][number][] = [];
    const creates: CreateAction[] = [];
    for (const record of this.store.records()) {
      if (record.status !== "pending") continue;
      if (isIssueChange(record)) changes.push(record);
      else if (record.kind === "create") creates.push(record);
    }
    return { changes, creates };
  }

  /** The pending actions of a coding-dispatch binding. */
  codingPending(): { dispatches: DispatchAction[]; cancels: CancelRunAction[] } {
    const dispatches: DispatchAction[] = [];
    const cancels: CancelRunAction[] = [];
    for (const record of this.store.records()) {
      if (record.status !== "pending") continue;
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
    implements Gatekeeper<InferOpsProjectSession>, HostBoardReader, HostBoardConnectionFence {
  #binding(): ProjectBinding {
    const { accountId, connected, systemCredentialRef, host, workspaceId } = this.ctx.props;
    const kv = this.ctx.storage.kv;
    return new ProjectBinding(this.ctx.props, {
      store: new ActionStore(kv),
      // A system workflow's binding (FAC-102) keeps its reference, so it acts only as that account.
      client: clientFor(this.env, this.ctx.exports, { accountId, connected, systemCredentialRef }, host, workspaceId),
      observers: () => admittedObservers(kv),
    }, () => otherWorkspacesOf(this.env, this.ctx.exports, this.ctx.props));
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

  /** Kernel-only projection of the supported transition, from the facet's immutable action. */
  async getApprovalProposal(action: number): Promise<ApprovalProposal> {
    const binding = this.#binding();
    const record = binding.action(action);
    if (record?.kind !== "transition" || !record.fingerprint) throw new Error("Unsupported approval");
    await assertFingerprint(binding.projectKey, record, {}, {required: true});
    return {
      scope: projectBoardUrl(this.ctx.props), args: {toStateId: record.toStateId},
      expectedRevision: record.expectedRevision, fingerprint: record.fingerprint,
      idempotencyKey: binding.idempotencyKey(action),
      simulation: {issueId: record.issueId, fromStateId: record.fromStateId, toStateId: record.toStateId},
    };
  }

  /** An edit stages a fresh transition; the previous proposal can never be applied afterwards. */
  async editApprovalProposal(action: number, args: ApprovalEdit) {
    const binding = this.#binding();
    const old = binding.action(action);
    if (old?.kind !== "transition") throw new Error("Unsupported approval");
    const result = async (id: number) => {
      const proposal = await this.getApprovalProposal(id);
      return {action: id, proposal, description: {
        title: sanitizeTitle(`Move ${old.identifier} to another state`),
        ...buildDescription("Explicit edited board transition, applied only at the expected revision.")
          .inline("Issue", old.identifier).inline("From", proposal.simulation.fromStateId)
          .inline("To", proposal.args.toStateId).inline("Expected revision", proposal.expectedRevision).finish(),
        implementsRevert: true,
      }};
    };
    if (old.replacement !== undefined) {
      const next = binding.action(old.replacement);
      if (next?.kind !== "transition" || next.toStateId !== args.toStateId) throw new Error("Conflicting edit");
      return result(next.actionId);
    }
    if (old.status !== "pending" || old.attempts?.dispatchedAt || old.attempts === undefined) {
      throw new Error("Action cannot be edited after an apply attempt");
    }
    await assertFingerprint(binding.projectKey, old, {}, {required: true});
    const snapshot = await binding.client.readProject(binding.projectKey);
    const issue = snapshot.issues.find(value => value.id === old.issueId);
    const target = snapshot.states.find(value => value.id === args.toStateId);
    if (!issue || issue.revision !== old.expectedRevision || !target ||
        target.workflow !== issue.workflow || issue.stateId === target.id) throw new Error("[INVALID_APPROVAL_EDIT] Invalid or stale edit");
    const actionId = await binding.stage({kind: "transition", issueId: old.issueId,
      identifier: old.identifier, fromStateId: issue.stateId, toStateId: target.id,
      toStateName: target.name, expectedRevision: issue.revision}, () => {
      const current = binding.action(action);
      if (current?.status !== "pending" || current.replacement !== undefined) throw new Error("Conflicting edit");
    }, id => binding.putAction({...old, status: "reverted", replacement: id}));
    return result(actionId);
  }

  /**
   * Kernel-only (`HostBoardReader`): the binding's own board as a bounded snapshot, with its scope
   * and the fence of the attempt that answered. A facet method rather than a session method, so
   * only the facet's holder, the overseer, can call it: sessions, agents and widgets hold
   * `ProjectSessionImpl`, and the agent types do not name it. Off unless `INFEROPS_HOST_BOARDS`.
   */
  async readHostBoardSnapshot(): Promise<HostBoardRead> {
    return readHostBoard(this.env, this.ctx.exports, this.ctx.props);
  }

  /** Kernel-only (`HostBoardConnectionFence`): the binding's connection fence, read now. */
  async connectionIdentity(): Promise<HostBoardFence | null> {
    return hostBoardFence(this.env, this.ctx.exports, this.ctx.props);
  }

  /**
   * Strategy B: the binding is one project, so admit an observer who can open that project. The
   * observer is remembered only so `findBoards` can exclude them: its results name other projects,
   * which admitting them for this one does not cover.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const assertShareable = () => {
      if (this.ctx.storage.kv.get(PRIVATE_SERVICE_QUERY)) {
        throw new Error("This connection has read joined company records and is private to its owner.");
      }
    };
    assertShareable();
    await admitProjectObserver(this.ctx.props, user);
    assertShareable();
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
      Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
    return applyBoardAction(this.#binding(), actionId);
  }

  /** Forget the pending action; reads stop simulating it at once, so no restart is needed. */
  async rejectAction(actionId: number): Promise<void> {
    rejectPending(this.#binding(), actionId);
  }

  /** See `revertBoardAction`. */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return revertBoardAction(this.#binding(), actionId);
  }
}

/**
 * A connected person's other InferOps workspaces, for `findBoards` on a binding of `target`: those
 * InferLab reported at connect time with a slug, each read with the person's own token in that
 * workspace (the credentials object refuses any workspace that is not theirs). The tenant label is
 * the binding's, since a person's workspaces share one tenant. The stopgap connection and the demo
 * serve one workspace, so they search only the binding's.
 */
async function otherWorkspacesOf(env: Cloudflare.Env, exports: ExportsWithStores,
                                 target: ProjectGatekeeperProps): Promise<DiscoverySource[]> {
  const { accountId, connected, host, workspaceId } = target;
  const tenant = parseHost(host)?.tenant;
  if (!connected || host === DEMO_HOST || !tenant) return [];
  const identity = await credentialsOf(exports, accountId).identity();
  return (identity?.workspaces ?? []).flatMap(workspace => {
    if (workspace.product === "infermind" || !workspace.workspaceSlug ||
        workspace.workspaceId === workspaceId) {
      return [];
    }
    const other = `${tenant}.${workspace.workspaceSlug}`;
    if (!parseHost(other)) return [];
    return [{
      host: other,
      client: clientFor(env, exports, { accountId, connected }, other, workspace.workspaceId),
    }];
  });
}

/** Forget a pending action of `binding`; reads stop simulating it at once. */
function rejectPending(binding: ActionBinding, actionId: number): void {
  if (binding.action(actionId)?.status === "pending") binding.deleteAction(actionId);
}

/**
 * Send a board action's recorded request under the action's idempotency key, so a repeated apply
 * (or one whose response was lost) is answered by InferOps without writing twice. The fingerprint
 * staged with the action must still match the request, and `check`, when given, must pass, or
 * nothing is sent. A failure is returned with what it proves (apply-attempts.ts): a first attempt
 * InferOps refused, or one that failed before sending, is known not applied, and a refusal that will
 * stand ends the action `failed` and no longer simulated; anything after an attempt that may have
 * reached InferOps is unknown.
 */
async function applyBoardAction(binding: ProjectBinding, actionId: number,
                                check?: () => Promise<void>): Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
  const record = binding.action(actionId);
  if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
  if (record.status === "applied") return { applied: { result: appliedResult(record) } };
  if (record.status === "reverted") throw new Error(`InferOps action ${actionId} was reverted.`);
  if (isCodingAction(record) || isWikiAction(record)) {
    throw new Error(`InferOps action ${actionId} is not a board action.`);
  }
  const fields = { projectKey: binding.projectKey, action: actionId };
  const key = binding.idempotencyKey(actionId);
  return binding.applyOnce(record, {
    policy: BOARD_WRITES, fields,
    check: async () => {
      await assertFingerprint(binding.scope, record, fields);
      await check?.();
    },
    async send(marked) {
      switch (record.kind) {
        case "transition":
        {
          const moved = await binding.client.transition(
            binding.projectKey, record.issueId, record.toStateId, record.expectedRevision, key);
          return { ...marked, status: "applied", appliedRevision: moved.revision } as ActionRecord;
        }
        case "create": {
          const created = await binding.client.createIssue(binding.projectKey, record.issue, key);
          return { ...marked, status: "applied", createdIdentifier: created.identifier } as ActionRecord;
        }
        case "comment":
          await binding.client.commentIssue(binding.projectKey, record.issueId, record.body, record.expectedRevision, key);
          return { ...marked, status: "applied" };
        case "update": {
          const updated = await binding.client.updateIssue(
            binding.projectKey, record.issueId, record.changes, record.expectedRevision, key);
          return { ...marked, status: "applied", appliedRevision: updated.revision } as ActionRecord;
        }
      }
    },
  });
}

/**
 * Undo an applied move or title/priority update, provided nothing has changed the issue since.
 * The data source checks the current revision again, so a concurrent change makes this fail
 * rather than clobber. Creates, and updates that changed the description, are submitted as not
 * revertible.
 */
async function revertBoardAction(binding: ProjectBinding, actionId: number):
    Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const record = binding.action(actionId);
  if (!record || record.status !== "applied") {
    return { message: "This change was never applied, so there is nothing to revert." };
  }
  if (isCodingAction(record) || isWikiAction(record)) return { message: "This is not a board action." };
  if (record.kind === "comment") return { message: "Comments cannot be undone here." };
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
    case "comment":
      return `The comment on ${record.identifier}`;
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
    case "proposal-approve":
      return `The approval of Wiki proposal "${plainInline(record.targetTitle, 60)}" (revision ${record.revision})`;
  }
}

/** A data-source failure's own detail, past its code; undefined for any other error. */
function detailOf(error: unknown): string | undefined {
  return error instanceof InferOpsError ? error.detail : undefined;
}

/**
 * Refuse, unsent, an apply whose request no longer matches the fingerprint staged with it. A
 * legacy record without one passes, unless `required`.
 */
async function assertFingerprint(scope: FingerprintScope, record: ActionRecord, fields: Partial<LogFields>,
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

function applyFailureMessage(record: ActionRecord, code: string | null, detail?: string): string {
  const what = actionLabel(record);
  if (isCodingAction(record)) {
    const coding = codingFailureMessage(record, what, code);
    if (coding) return coding;
  }
  if (record.kind === "proposal-approve") return proposalFailureMessage(what, code, detail);
  if (isWikiEdit(record)) return wikiFailureMessage(record, what, code);
  const noun = {
    transition: "move", create: "issue", update: "update", comment: "comment", dispatch: "dispatch", cancel: "cancel",
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

/**
 * Why an approval of a Wiki proposal was not applied: InferOps' refusal as the data source states
 * it (`PROPOSAL_APPROVE_REFUSED`), which tells a self-approval from a decided proposal although both
 * are CONFLICT, else the shared Wiki messages.
 */
function proposalFailureMessage(what: string, code: string | null, detail: string | undefined): string {
  switch (code) {
    case "STALE_REVISION":
    case "CONFLICT":
    case "FORBIDDEN":
    case "INVALID_REQUEST":
    case "NOT_FOUND":
      if (detail) return `${what} was not applied: ${detail}`;
      break;
    case "IDEMPOTENCY_CONFLICT":
      return `${what} was not applied: the stored request no longer matches the one proposed. ` +
        `Discard it and propose it again.`;
  }
  switch (code) {
    case "UNAUTHORIZED":
      if (detail === SYSTEM_KEY_REFUSED) return `${what} was not applied: ${detail}`;
      return `${what} was not applied: InferOps rejected this connection's credential. Reconnect InferOps.`;
    case "DISABLED":
      return `${what} was not applied: InferOps is turned off for this deployment. It can be ` +
        `applied once InferOps is turned back on.`;
    case null:
    case "UNAVAILABLE":
      return `${what} could not be applied. Try again later.`;
    default:
      return `${what} was not applied: InferOps refused it (${code}).`;
  }
}

/** Why a Wiki section or page body edit was not applied. */
function wikiFailureMessage(record: WikiEditAction, what: string, code: string | null): string {
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

/** A board search's query, trimmed, or INVALID_REQUEST when empty or too long. */
function boardQuery(query: string): string {
  const text = query.trim();
  if (text.length === 0 || text.length > MAX_DISCOVERY_QUERY_LENGTH) {
    fail("INVALID_REQUEST", `A board search must be 1-${MAX_DISCOVERY_QUERY_LENGTH} characters.`);
  }
  return text;
}

/**
 * Ranks the projects each source's own token lists (see `rankBoards`). Only bindable keys are
 * candidates, and the issue titles read for matching never leave the gatekeeper. A source InferOps
 * refuses (FORBIDDEN or NOT_FOUND: a membership removed since connect) is left out when
 * `skippable(index)` says so, and fails the search otherwise.
 */
async function searchBoards(text: string, sources: DiscoverySource[], skippable: (index: number) => boolean):
    Promise<{ candidates: BoardCandidate[]; workspaces: DiscoveryWorkspace[]; count: number }> {
  const listed = await Promise.all(sources.map(async (source, index) => {
    try {
      return { source, projects: await source.client.listProjects() };
    } catch (error) {
      const code = inferOpsErrorCode(error);
      if (skippable(index) && (code === "FORBIDDEN" || code === "NOT_FOUND")) return null;
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
  const count = workspaces.reduce((sum, workspace) => sum + workspace.projects.length, 0);
  return { candidates: rankBoards(text, workspaces), workspaces, count };
}

/** What a board search's observation says it matched against. */
function searchedText(count: number, workspaces: DiscoveryWorkspace[], candidates: BoardCandidate[]): string {
  return `Matched a search against the ${count} projects listed on ` +
    `${workspaces.map(workspace => `${workspace.scope.tenant}.${workspace.scope.workspace}`).join(", ")}: ` +
    `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}.`;
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

  async readServiceQuery(name: ServiceQueryName, options?: ServiceQueryOptions): Promise<ServiceQueryPage> {
    // Latch before awaiting: a concurrently admitted or later observer must not inherit joined data.
    // Account bindings use their existing prepareWithheld tracker instead.
    if (typeof this.#binding.scope === "string") this.#binding.kv.put(PRIVATE_SERVICE_QUERY, true);
    const page = await this.#binding.client.readServiceQuery(this.#binding.projectKey, name, options);
    // Board observer grants do not cover joined company tables. Withhold this observation from all observers.
    await this.#binding.observeWithheld(this.#queue, {
      title: "Read service dashboard",
      description: `Read ${page.rows.length} rows from published query ${page.name}, version 1.`,
    });
    return page;
  }

  async readBoard(): Promise<Board> {
    const board = await this.#binding.board();
    const issues = board.columns.reduce((sum, column) => sum + column.issues.length, 0);
    await this.#binding.observe(this.#queue, {
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
    const text = boardQuery(query);
    const binding = this.#binding;
    const { host } = binding.target;
    if (host !== DEMO_HOST && !parseHost(host)) {
      fail("INVALID_REQUEST", "This connection's workspace cannot be searched.");
    }
    const sources = [{ host, client: binding.client }, ...await binding.otherWorkspaces()];
    const { candidates, workspaces, count } = await searchBoards(text, sources, index => index > 0);
    const others = workspaces.length - 1;
    const where = others > 0
      ? `${host} and ${others} other workspace${others === 1 ? "" : "s"}` : host;
    await binding.observeWithheld(this.#queue, {
      title: `Searched InferOps boards on ${where}`,
      description: searchedText(count, workspaces, candidates),
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
  async createIssue(issue: NewIssue): Promise<Receipt | null> {
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
      ...(state.workflow !== "software" ? { workflow: state.workflow } : {}),
    };
    // One intent, one create: the same proposal again (another tab, a retried submit) while the
    // first is pending joins it rather than queueing a second issue. Edits and moves need no
    // such step, since a pending change to an issue already refuses another (`refuseIfPending`).
    const { actionId, joined } = await binding.stageOnce({ kind: "create", issue: request, stateName: state.name });
    if (joined) return null;
    const description = binding.description(
      `Create an issue in InferOps project ${binding.projectKey}.`)
      .inline("Project", binding.projectKey)
      .inline("Title", title)
      .inline("State", state.name)
      .inline("Workflow", state.workflow)
      .inline("Priority", request.priority ?? "none");
    if (request.description) description.verbatim("Description", request.description);
    return binding.submit(this.#queue, actionId, {
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
    await this.#binding.observe(this.#queue, {
      title: `Read InferOps issue ${issue.identifier}`,
      description: `Read issue ${issue.identifier} of project ${this.#binding.projectKey}.`,
    });
    return issue;
  }

  /** Queue a comment against the exact issue revision; approval performs the native write. */
  async comment(body: string, expectedRevision: Revision): Promise<void> {
    if (!body.trim() || body.length > 20_000 || !REVISION.test(expectedRevision)) {
      fail("INVALID_REQUEST", "A comment of 1–20000 characters and an exact revision are required.");
    }
    const binding = this.#binding;
    const issue = await binding.client.readIssue(binding.projectKey, this.#issueId).catch(hideIssueExistence);
    if (issue.revision !== expectedRevision) fail("STALE_REVISION", "This issue changed; read it again.");
    const { actionId, joined } = await binding.stageOnce({ kind: "comment", issueId: this.#issueId,
      identifier: issue.identifier, body, expectedRevision });
    if (joined) return;
    await binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Comment on ${issue.identifier}`),
      ...binding.description(`Add a comment to ${issue.identifier}.`).verbatim("Comment", body).finish(),
      implementsRevert: false,
    });
  }

  /**
   * The issue's recorded activity, through the connection's own InferOps access (`issue.history`):
   * an issue it cannot read fails exactly as `read()` does, and InferOps' own refusal (FORBIDDEN)
   * is passed on. One observation names the issue and how much was read.
   */
  async activity(): Promise<IssueActivity> {
    const binding = this.#binding;
    const issue = await binding.issue(this.#issueId).catch(hideIssueExistence);
    const activity = await binding.client.readIssueActivity(binding.projectKey, this.#issueId)
      .catch(hideIssueExistence);
    const shown = activity.entries.length;
    await binding.observe(this.#queue, {
      title: `Read activity of InferOps issue ${issue.identifier}`,
      description: `Read ${shown} activity ${shown === 1 ? "entry" : "entries"} of issue ` +
        `${issue.identifier} in project ${binding.projectKey}` +
        (activity.omitted > 0 ? `, the most recent of ${shown + activity.omitted}.` : "."),
    });
    return activity;
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

  async transition(toStateId: string, expectedRevision: Revision): Promise<Receipt | null> {
    const binding = this.#binding;
    const { snapshot, issue, refuseIfPending } = await this.#current(expectedRevision);
    const target = snapshot.states.find(s => s.id === toStateId);
    if (!target) fail("INVALID_STATE", `The target state is not part of project ${binding.projectKey}.`);
    if (target.workflow !== issue.workflow) {
      fail("WORKFLOW_MISMATCH",
        `${issue.identifier} is a ${issue.workflow} issue; "${target.name}" is a ${target.workflow} state.`);
    }
    if (issue.stateId === toStateId) return null;
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
    const rendered = binding.description(
      `Move an issue of InferOps project ${binding.projectKey} to another workflow state. It is ` +
      `applied only if the issue is still at the revision below when approved.`)
      .inline("Issue", issue.identifier)
      .inline("Title", issue.title)
      .inline("From", from?.name ?? issue.stateId)
      .inline("To", target.name)
      .inline("Expected revision", expectedRevision)
      .finish();
    return binding.submit(this.#queue, actionId, {
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
  async update(changes: IssueChanges, expectedRevision: Revision): Promise<Receipt | null> {
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
    if (named.length === 0) return null;
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
    const description = binding.description(
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
    return binding.submit(this.#queue, actionId, {
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
    const kv = this.ctx.storage.kv;
    return new ProjectBinding(this.ctx.props, {
      store: new ActionStore(kv),
      client: codingClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId),
      observers: () => admittedObservers(kv),
    });
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
      Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
    const binding = this.#binding();
    const record = binding.action(actionId);
    if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
    if (record.status === "applied") return { applied: { result: appliedResult(record) } };
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
    await this.#binding.observe(this.#queue, {
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
    await this.#binding.observe(this.#queue, {
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
    await this.#binding.observe(this.#queue, {
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
  async dispatch(issueKey: string, target: DispatchTarget, expectedRevision: Revision): Promise<Receipt | null> {
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
    return binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Dispatch ${issue.identifier} to ${repo.slug}`),
      ...description,
      implementsRevert: false,
      actionKind: { tag: "inferops.code-dispatch", label: "Dispatch a coding task" },
    });
  }

  /** A cancel already pending for the run makes this a no-op. */
  async cancel(runId: string): Promise<Receipt | null> {
    if (runId.startsWith(PROVISIONAL_RUN)) fail("NOT_FOUND", "No such run in this project.");
    const binding = this.#binding;
    const run = await binding.client.readRun(binding.projectKey, runId).catch(hideRunExistence);
    if (!ACTIVE_RUN.has(run.status)) fail("CONFLICT", `The run of ${run.issueIdentifier} is already ${run.status}.`);
    if (binding.codingPending().cancels.some(c => c.runId === run.id)) return null;

    const actionId = await binding.stage({ kind: "cancel", runId: run.id, identifier: run.issueIdentifier });
    const description = buildDescription(
      `Stop a coding run of InferOps project ${binding.projectKey}. A queued run ends cancelled; a ` +
      `running one ends unknown, because its work may be partly done, and InferOps holds the issue ` +
      `for a person to recover.`)
      .inline("Issue", run.issueIdentifier)
      .inline("Run", run.id)
      .inline("Status", run.status)
      .finish();
    return binding.submit(this.#queue, actionId, {
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

/**
 * A Wiki binding: its action store, data source and the edits still waiting for a decision.
 * `target` is its scope, as for a project binding.
 */
class WikiBinding extends ActionBinding {
  readonly #admitSearch: BindingParts["admitSearch"];

  constructor(readonly target: WikiGatekeeperProps, parts: BindingParts) {
    super(parts, WIKI_SCOPE);
    this.#admitSearch = parts.admitSearch;
  }

  /**
   * Refuse a search this binding may not run: on the deployment's shared connection, which is no
   * one's own sign-in (FORBIDDEN), or past the account's throttle (UNAVAILABLE, saying when to
   * retry, distinct from an outage).
   */
  async admitSearch(): Promise<void> {
    if (!this.target.connected && this.host !== DEMO_HOST) {
      throw new InferOpsError("FORBIDDEN", SEARCH_NEEDS_OWN_SIGN_IN);
    }
    const retryAfter = await this.#admitSearch?.();
    if (retryAfter != null) {
      throw new InferOpsError("UNAVAILABLE",
        `Too many Wiki searches on this connection: at most ${WIKI_SEARCHES_PER_MINUTE} a minute. ` +
        `Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`);
    }
  }

  get host(): string {
    return this.target.host;
  }

  /** Pending section and page body edits, oldest first. */
  pendingEdits(): WikiEditAction[] {
    const edits: WikiEditAction[] = [];
    for (const record of this.store.records()) {
      if (record.status === "pending" && isWikiEdit(record)) edits.push(record);
    }
    return edits.toSorted((a, b) => a.actionId - b.actionId);
  }

  /** Pending proposal approvals, oldest first. */
  pendingApprovals(): ProposalApproveAction[] {
    const approvals: ProposalApproveAction[] = [];
    for (const record of this.store.records()) {
      if (record.status === "pending" && record.kind === "proposal-approve") approvals.push(record);
    }
    return approvals.toSorted((a, b) => a.actionId - b.actionId);
  }

  /**
   * Why only this binding's own account holder may not decide an approval of a proposal now, or
   * null when they alone can: an admitted collaborator could decide it while the apply sends the
   * owner's sign-in, and the stopgap connection is a shared credential with no person behind it.
   * InferOps records the sender as the approver and refuses self-approval against them, so the
   * person approving here must be that sender.
   */
  approvalRefusal(): string | null {
    if (!this.target.connected && this.host !== DEMO_HOST) return APPROVE_NEEDS_OWN_SIGN_IN;
    if (this.observers().length > 0) return APPROVE_NOT_SHARED;
    return null;
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

/** Why a shared Wiki gadget cannot approve a proposal (see `WikiBinding.approvalRefusal`). */
const APPROVE_NOT_SHARED =
  "A shared gadget cannot approve Wiki proposals: the approval would be sent with the gadget " +
  "owner's InferOps sign-in. Approve from an unshared gadget.";

/** Why the stopgap connection cannot approve a proposal (see `WikiBinding.approvalRefusal`). */
/** Why the deployment's shared connection never searches a Wiki (contract: per-person identity). */
const SEARCH_NEEDS_OWN_SIGN_IN =
  "Searching the InferMind Wiki needs your own InferLab sign-in: this connection is shared.";

const APPROVE_NEEDS_OWN_SIGN_IN =
  "Approving a Wiki proposal needs your own InferLab sign-in: this connection is shared and " +
  "approves as no one.";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const PROPOSAL_STATES: readonly WikiProposalState[] =
  ["in_review", "approved", "publishing", "published", "rejected", "superseded", "stale", "blocked"];

const failApprovalConflict = (title: string): never =>
  fail("CONFLICT",
    `Wiki proposal "${plainInline(title, 60)}" already has another approval waiting for a decision. ` +
    `Wait for it, then read the proposal again.`);

/** One message for a proposal that is unknown, not an id, or behind publishing turned off. */
const PROPOSAL_NOT_FOUND = "No such proposal in this Wiki, or Wiki publishing is off in InferOps.";

/** Rethrow a data-source "not found" for a proposal with the one proposal message. */
function hideProposalExistence(error: unknown): never {
  if (inferOpsErrorCode(error) === "NOT_FOUND") fail("NOT_FOUND", PROPOSAL_NOT_FOUND);
  throw error;
}

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
    const kv = this.ctx.storage.kv;
    return new WikiBinding(this.ctx.props, {
      store: new ActionStore(kv),
      client: clientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId),
      observers: () => admittedObservers(kv),
      admitSearch: () => credentialsOf(this.ctx.exports, accountId).admitWikiSearch(),
    });
  }

  async describe(): Promise<ResourceDescription> {
    const { host } = this.ctx.props;
    return {
      url: wikiUrl({ host }),
      title: `InferMind Wiki ${host}`,
      snippet: `The InferMind Wiki of ${host}: read its pages and propose edits to their sections, ` +
        `and read drafted page proposals and ask to approve one for publication.`,
      suggestedBindingName: "INFEROPS_WIKI",
      tsType: "InferOpsWikiSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Every section edit, page body edit and proposal approval waits for review; none is
   * auto-approvable. An approval of a proposal is of the exact bytes staged: this facet offers no
   * edit-before-approve path for it.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsWikiSession> {
    return new WikiSessionImpl(this.#binding(), approvalQueue.dup());
  }

  /**
   * Strategy B: the binding is one workspace's Wiki, so admit an observer who can read it. The
   * observer is remembered only so `readDocumentText` can exclude them: InferOps' page text carries
   * documentation coverage and live widget state, which admitting them for the Wiki does not cover.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const { host, workspaceId } = this.ctx.props;
    const verifier = user as unknown as Fetcher<InferOpsVerifierApi>;
    if (!(await verifier.hasWikiAccess(host, workspaceId))) {
      throw new Error(
        `This collaborator cannot read the InferMind Wiki of ${host}, so they cannot observe data ` +
        `the Gadget read from it.`);
    }
    this.ctx.storage.kv.put(OBSERVER_PREFIX + id, true);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(OBSERVER_PREFIX + id);
  }

  /** See `applyWikiAction`. */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
    return applyWikiAction(this.#binding(), actionId);
  }

  /** Forget the pending edit; reads stop showing it at once. */
  async rejectAction(actionId: number): Promise<void> {
    rejectPending(this.#binding(), actionId);
  }

  /** See `revertWikiAction`. */
  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return revertWikiAction(this.#binding(), actionId);
  }
}

/**
 * Apply a section edit or a page body edit; see `sendSectionEdit` and `sendBodyEdit`. The
 * fingerprint is required: every Wiki record has one. Both are reconcile-only
 * (apply-attempts.ts): a failure before sending is known not applied, any other failure leaves
 * the outcome unknown, and once an attempt may have reached InferOps no later apply sends it
 * again, even when the page now shows the edit. A proposal approval is replayable instead; see
 * `applyApproval`.
 */
async function applyWikiAction(binding: WikiBinding, actionId: number, check?: () => Promise<void>):
    Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
  const record = binding.action(actionId);
  if (!record) throw new Error(`Unknown InferOps action ${actionId}.`);
  if (record.status === "applied") return { applied: { result: appliedResult(record) } };
  if (record.status === "reverted") throw new Error(`InferOps action ${actionId} was reverted.`);
  if (!isWikiAction(record)) throw new Error(`InferOps action ${actionId} is not a Wiki action.`);
  const fields = { host: binding.host, action: actionId };
  if (record.kind === "proposal-approve") return applyApproval(binding, record, fields, check);
  return binding.applyOnce(record, {
    policy: RECONCILE_ONLY, fields,
    check: async () => {
      await assertFingerprint(binding.scope, record, fields, { required: true });
      await check?.();
    },
    send: marked => record.kind === "document-update"
      ? sendBodyEdit(binding, marked as DocumentUpdateAction)
      : sendSectionEdit(binding, marked as SectionUpdateAction),
  });
}

/**
 * Apply an approval of a proposal: replayable (`PROPOSAL_APPROVE`), since InferOps' refusals roll
 * back and a same-principal, same-hash resend answers the decided proposal. Checked first, inside
 * `applyOnce` so nothing is marked dispatched before it passes: that only the binding's own
 * account holder could have decided it (a collaborator may have been admitted since it was
 * staged), refused unsent and left pending as a FORBIDDEN a later apply can pass; then the
 * fingerprint. Sent under `<instance>:<action>`. Applied means approved and queued, with the
 * state InferOps answered; publication is InferOps' later job, read through `readProposal`.
 */
async function applyApproval(binding: WikiBinding, record: ProposalApproveAction, fields: Partial<LogFields>,
                             check?: () => Promise<void>):
    Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
  return binding.applyOnce(record, {
    policy: PROPOSAL_APPROVE, fields,
    check: async () => {
      const refusal = binding.approvalRefusal();
      if (refusal !== null) {
        logger.warn("proposal approval refused before sending", {
          event: "proposal-approve.apply.not_owner_only", ...fields, code: "FORBIDDEN",
        });
        throw new CheckRefused("FORBIDDEN", refusal);
      }
      await assertFingerprint(binding.scope, record, fields, { required: true });
      await check?.();
    },
    send: async marked => {
      const approved = await binding.client.approveProposal(
        record.proposalId, { proposalHash: record.proposalHash, sources: record.sources },
        binding.idempotencyKey(record.actionId));
      return { ...(marked as ProposalApproveAction), status: "applied", approvedState: approved.state };
    },
  });
}

/**
 * A page body edit is sent as it was approved: the body, the version it was proposed at, and a
 * key fixed per action (`<instance>:<action>`). InferOps compares the version itself, so the page
 * is not read first, and its text decides nothing: a page already holding this body at a later
 * version fails STALE_REVISION like any other change, since matching text does not show this
 * action wrote it. Returns the record with the version reported.
 */
async function sendBodyEdit(binding: WikiBinding, record: DocumentUpdateAction): Promise<ActionRecord> {
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
async function sendSectionEdit(binding: WikiBinding, record: SectionUpdateAction): Promise<ActionRecord> {
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

/**
 * Restore the body an applied edit replaced, provided the section or page is still exactly what
 * the edit left; otherwise explain instead of clobbering a later edit. A section is checked by
 * reading it (its version and body); a page by InferOps' compare-and-swap, sent expecting the
 * version the edit produced under `<instance>:<action>:revert`, so a page changed since in any way
 * fails STALE_REVISION and keeps its content, and a retried revert whose response was lost is
 * replayed under its key.
 */
async function revertWikiAction(binding: WikiBinding, actionId: number):
    Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const record = binding.action(actionId);
  if (record?.kind === "proposal-approve") {
    return { message: "An approval cannot be undone here. If the page was published, edit it in InferMind." };
  }
  if (!record || record.status !== "applied") {
    return { message: "This change was never applied, so there is nothing to revert." };
  }
  if (!isWikiEdit(record)) return { message: "This is not a Wiki action." };
  if (record.kind === "document-update") return revertBodyEdit(binding, record);
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

async function revertBodyEdit(binding: WikiBinding, record: DocumentUpdateAction):
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

/** A page as the session shows it: its pending edits overlaid, and a Master's structure if read. */
type ShownPage = {
  head: WikiDocumentHead; body: string; pendingBody: boolean; structure: WikiStructureRecord | null;
  sections: WikiSection[];
};

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
    await this.#binding.observe(this.#queue, {
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
    await this.#binding.observe(this.#queue, {
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
  async #page(slugOrId: string, withStructure: boolean): Promise<ShownPage> {
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
    await this.#binding.observe(this.#queue, {
      title: `Read Wiki page ${plainInline(head.slug, 80)}`,
      description: `Read page "${plainInline(head.title, 120)}" of the InferMind Wiki of ` +
        `${this.#binding.host}: ${body.trim() ? "its body, " : ""}${sections.length} sections, ` +
        `${page.references.length} embedded references.`,
    });
    return page;
  }

  /**
   * The page as InferOps composes its text for this account (`document.text`), so the caller reads
   * what a person and an InferOps agent read: a Master's documentation coverage (computed with the
   * account's own access) and embedded widgets as live text included. While this connection has an
   * edit of the page waiting for a decision, the page is composed here instead with the edit
   * overlaid (InferOps' page contract, wiki.ts), so the caller reads back what it proposed; that text
   * leaves embeds as links and has no coverage block. Nothing on the page readable: NOT_FOUND.
   *
   * InferOps' text carries data the Wiki grant does not cover (coverage of an operations
   * workspace, live widget state), so a collaborator admitted for the Wiki is excluded from it.
   */
  async readDocumentText(slugOrId: string): Promise<string> {
    const binding = this.#binding;
    const documentId = await this.#documentId(slugOrId);
    if (binding.pendingEdits().length > 0) {
      const page = await this.#page(documentId, true);
      if (page.pendingBody || page.sections.some(section => section.pending)) {
        return this.#composedText(page);
      }
    }
    const text = await binding.client.readDocumentText(documentId).catch(hideDocumentExistence);
    if (text === null) fail("NOT_FOUND", "Nothing on this page is readable.");
    const title = /^# (.*)/.exec(text)?.[1] ?? "";
    await binding.observeWithheld(this.#queue, {
      title: `Read Wiki page ${plainInline(slugOrId, 80)} as text`,
      description: `Read page "${plainInline(title, 120)}" of the InferMind Wiki of ${binding.host} ` +
        "as text, as InferOps composes it for this connection: its content, and for a Master its " +
        "structure and documentation coverage, with embedded widgets as their live text.",
    });
    return text;
  }

  /**
   * `knowledge.search` for this Wiki's workspace, as this connection's own sign-in: only `query`
   * and `limit` are sent, so no argument can widen the scope, and InferOps applies the person's row
   * rules and lens before choosing candidates. Hits are passed on without `score`, a section with
   * an edit pending here marked `pending: "update"` (its snippet still the committed text). A
   * search that could not run is UNAVAILABLE, never an empty list.
   *
   * The answer reflects the owner's lens, which admitting a collaborator for the Wiki does not
   * cover, so every collaborator is excluded from it. The observation keeps the query's first 100
   * characters and the hits' page and section references, never their snippets (decision 8).
   */
  async searchWiki(query: string, options?: { limit?: number }): Promise<WikiSearchHit[]> {
    const trimmed = typeof query === "string" ? query.trim() : "";
    if (!trimmed || [...trimmed].length > 500) {
      fail("INVALID_REQUEST", "query must be 1 to 500 characters after trimming.");
    }
    const limit = options?.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      fail("INVALID_REQUEST", "limit must be a whole number from 1 to 50.");
    }
    const binding = this.#binding;
    await binding.admitSearch();
    const records = await binding.client.searchWiki(trimmed, limit);
    const pending = new Set(binding.pendingEdits().flatMap(e => e.kind === "section-update" ? [e.sectionId] : []));
    const hits: WikiSearchHit[] = records.map(hit => pending.has(hit.sectionId) ? { ...hit, pending: "update" } : hit);
    const asked = [...trimmed].length > 100 ? `${[...trimmed].slice(0, 100).join("")}…` : trimmed;
    const found = hits.map(hit => `${plainInline(hit.tag, 80)} in ${plainInline(hit.documentSlug, 80)}`);
    await binding.observeWithheld(this.#queue, {
      title: "Searched the InferMind Wiki",
      description: `Searched the InferMind Wiki of ${binding.host} for "${plainInline(asked, 120)}": ` +
        (found.length === 0 ? "no readable match." :
          `${found.length} section${found.length === 1 ? "" : "s"}: ${found.join(", ")}.`),
    });
    return hits;
  }

  /** The page shown, with its pending edits, as InferOps' page contract composes it (wiki.ts). */
  async #composedText(page: ShownPage): Promise<string> {
    const { head, body, sections, structure } = page;
    const text = composeDocumentText(head.title, {
      body, visibleSections: sections.map(s => s.body),
      generated: structure ? masterStructureText(head, structure) : null,
    });
    if (text === null) fail("NOT_FOUND", "Nothing on this page is readable.");
    await this.#binding.observe(this.#queue, {
      title: `Read Wiki page ${plainInline(head.slug, 80)} as text`,
      description: `Read page "${plainInline(head.title, 120)}" of the InferMind Wiki of ` +
        `${this.#binding.host} as text, with its pending edits: ` +
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
  async updateDocumentBody(slugOrId: string, body: string, expectedVersion: number): Promise<Receipt | null> {
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
    if ((live?.body ?? head.body) === body) return null;
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
    if (actionId === null) return null;
    const description = binding.description(
      `Replace the body of one page of the InferMind Wiki of ${binding.host}. InferOps applies it ` +
      `only if the page is still at the version below when approved. Its sections are not changed.`)
      .inline("Page", head.title)
      .inline("Expected version", String(expectedVersion))
      .verbatim("Current text", head.body)
      .verbatim("New text", body)
      .finish();
    return binding.submit(this.#queue, actionId, {
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
  async updateSection(sectionId: string, body: string, expectedVersion: number): Promise<Receipt | null> {
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
    if ((live?.body ?? stored.body) === body) return null;
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
    if (actionId === null) return null;
    const description = binding.description(
      `Replace the markdown of one section of the InferMind Wiki of ${binding.host}. It is applied ` +
      `only if the section is still at the version below when approved.`)
      .inline("Page", head.title)
      .inline("Section", stored.tag)
      .inline("Expected version", String(expectedVersion))
      .verbatim("Current text", stored.body)
      .verbatim("New text", body)
      .finish();
    return binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Edit Wiki section ${stored.tag} of ${head.title}`),
      ...description,
      implementsRevert: true,
      actionKind: { tag: "inferops.wiki-section-update", label: "Edit a Wiki section" },
    });
  }

  /** A proposal as the caller sees it: InferOps' record, marked while an approval of it waits here. */
  #shownProposal(record: WikiProposalRecord, approvals: readonly ProposalApproveAction[]): WikiProposal {
    return approvals.some(a => a.proposalId === record.id) ? { ...record, pending: "approve" } : { ...record };
  }

  async listProposals(state?: WikiProposalState): Promise<WikiProposal[]> {
    if (state !== undefined && !PROPOSAL_STATES.includes(state)) {
      fail("INVALID_REQUEST", `state must be one of ${PROPOSAL_STATES.join(", ")}.`);
    }
    const binding = this.#binding;
    const records = await binding.client.listProposals(state).catch(hideProposalExistence);
    const approvals = binding.pendingApprovals();
    await this.#binding.observe(this.#queue, {
      title: "List InferMind Wiki proposals",
      description: `Listed the ${records.length} ${state === undefined ? "" : `${state} `}page proposals ` +
        `of the InferMind Wiki of ${binding.host}, with their content.`,
    });
    return records.map(record => this.#shownProposal(record, approvals));
  }

  async readProposal(proposalId: string): Promise<WikiProposalDetail> {
    if (!UUID.test(proposalId)) fail("NOT_FOUND", PROPOSAL_NOT_FOUND);
    const binding = this.#binding;
    const { proposal, freshness } = await this.#readProposal(proposalId);
    await this.#binding.observe(this.#queue, {
      title: `Read Wiki proposal ${plainInline(proposal.targetSlug, 80)}`,
      description: `Read proposal "${plainInline(proposal.title, 120)}" (revision ${proposal.revision}) of the ` +
        `InferMind Wiki of ${binding.host}: ${proposal.state}, ` +
        `${freshness.stale ? "its target or a cited section has changed" : "its target and cited sections unchanged"}, ` +
        `${proposal.sources.length} cited sections, with its content.`,
    });
    return { proposal: this.#shownProposal(proposal, binding.pendingApprovals()), freshness };
  }

  #readProposal(proposalId: string): Promise<WikiProposalRead> {
    return this.#binding.client.readProposal(proposalId.toLowerCase()).catch(hideProposalExistence);
  }

  /**
   * Checked before anything is staged: that only this binding's account holder can decide it (not
   * shared, not the stopgap connection), then against the proposal as InferOps has it now: in
   * review (a superseded one is STALE_REVISION), at this hash, not stale for this reader, and a new
   * page with a parent. The approval card must show the whole proposal, or nothing is staged. Not
   * an observation: the approval shows what was read. Self-approval is InferOps' to refuse, at
   * apply, against the account holder who sends it.
   */
  async approveProposal(proposalId: string, proposalHash: string): Promise<Receipt | null> {
    if (!UUID.test(proposalId)) fail("NOT_FOUND", PROPOSAL_NOT_FOUND);
    if (!SHA256_HEX.test(proposalHash)) {
      fail("INVALID_REQUEST", "proposalHash must be the proposalHash readProposal() returned.");
    }
    const binding = this.#binding;
    const refusal = binding.approvalRefusal();
    if (refusal !== null) throw new InferOpsError("FORBIDDEN", refusal);
    const { proposal, freshness } = await this.#readProposal(proposalId);
    const name = `Wiki proposal "${plainInline(proposal.title, 60)}"`;
    if (proposal.state === "superseded") {
      fail("STALE_REVISION", `${name} has a newer revision. Read the proposals again.`);
    }
    if (proposal.state !== "in_review") fail("CONFLICT", `${name} is ${proposal.state}, not in review.`);
    if (proposal.proposalHash !== proposalHash) {
      fail("STALE_REVISION", `${name} changed since it was read (its hash differs). Read it again.`);
    }
    if (freshness.stale) {
      fail("STALE_REVISION",
        `${name} is stale: its target page or a cited section changed (or is not visible to you). Draft it again.`);
    }
    const isNewPage = proposal.targetDocumentId === null;
    if (isNewPage && proposal.parentId === null) {
      fail("INVALID_REQUEST", `${name} is a new page that needs a parent; set it in InferMind.`);
    }
    const description = await this.#approvalCard(proposal, isNewPage);
    if (!description.descriptionIsComplete) {
      fail("INVALID_REQUEST",
        "This proposal is too long to show in full on an approval card; approve it in InferOps directly " +
        "(proposal.approve).");
    }
    const actionId = await binding.stage({
      kind: "proposal-approve", proposalId: proposal.id, proposalHash, sources: sortedSources(proposal.sources),
      targetTitle: proposal.title, targetSlug: proposal.targetSlug, isNewPage, revision: proposal.revision,
    }, () => {
      // Re-checked with the write, after the reads above: sharing or a concurrent proposal may have changed since.
      const now = binding.approvalRefusal();
      if (now !== null) throw new InferOpsError("FORBIDDEN", now);
      const waiting = binding.pendingApprovals().filter(a => a.proposalId === proposal.id);
      if (waiting.some(a => a.proposalHash === proposalHash)) throw new AlreadyProposed();
      if (waiting.length > 0) failApprovalConflict(proposal.title);
    }).catch(error => {
      if (error instanceof AlreadyProposed) return null;
      throw error;
    });
    if (actionId === null) return null;
    return binding.submit(this.#queue, actionId, {
      title: sanitizeTitle(`Approve Wiki proposal: ${proposal.title}`),
      ...description,
      implementsRevert: false,
      actionKind: { tag: "inferops.wiki-proposal-approve", label: "Approve a Wiki proposal for publication" },
    });
  }

  /**
   * The approval card: what approving does and does not do, then the fields that identify the
   * proposal (page, for a new page its pillar, revision, hash, summary, sources, the contradictions
   * the draft recorded), then its content verbatim. Every field is InferOps' own record of what the
   * hash binds, shown as data; none of it changes what is approved.
   */
  async #approvalCard(proposal: WikiProposalRecord, isNewPage: boolean) {
    const binding = this.#binding;
    let page = proposal.title;
    if (isNewPage) {
      const parent = await binding.client.readDocument(proposal.parentId!).catch(error => {
        if (inferOpsErrorCode(error) === "NOT_FOUND") return null;
        throw error;
      });
      page = `New page "${proposal.title}" (${proposal.targetSlug}) under ` +
        `${parent ? `"${parent.title}"` : `page ${proposal.parentId}`}`;
    }
    const builder = binding.description(
      `Approve one drafted page of the InferMind Wiki of ${binding.host} for publication. Approving ` +
      `queues its publication and publishes nothing itself. InferOps publishes it later, as you, only ` +
      `if you still hold knowledge:publish, can see every cited section, every heading is grounded in ` +
      `them, and neither the page nor its sources changed; otherwise the proposal ends stale or ` +
      `blocked, and reading it shows which. An approval cannot be undone here.`)
      .inline("Page", page);
    // A new page is filed in its pillar on publication; an edit keeps its pillars, so none is shown.
    if (isNewPage) builder.inline("Pillar", proposal.pathwayType ?? "none");
    builder
      .inline("Revision", String(proposal.revision))
      .inline("Proposal hash", proposal.proposalHash);
    if (proposal.summary) builder.verbatim("Summary", proposal.summary);
    builder.inline("Sources", `${proposal.sources.length} cited section${proposal.sources.length === 1 ? "" : "s"}`);
    if (proposal.contradictions.length > 0) builder.list("Contradictions", proposal.contradictions);
    else builder.inline("Contradictions", "none");
    return builder.verbatim("Content", proposal.content).finish();
  }
}

// ---------------------------------------------------------------------------
// Account gatekeeper (a facet of the Overseer, one per account binding; inferos ADR 0015)

/** Where an account facet indexes each action id to the scope whose store holds it. */
const ACTION_SCOPE_PREFIX = "actionScope:";
/** Where an account facet's observer tracker keeps the boards and Wikis read through it. */
const OBSERVED_SET_PREFIX = "observedSet:";

/** One message for every refused `openBoard`, whatever was wrong, so a reference cannot probe. */
const NO_SUCH_BOARD = "No such InferOps board is available to this connection.";
/** One message for every refused `openWiki`, as `NO_SUCH_BOARD`. */
const NO_SUCH_WIKI = "No such InferMind Wiki is available to this connection.";

/**
 * The key of a resolved board or Wiki: its records' store, its action index entry and its observed
 * data set. Built from the resolved workspace id, so a slug that later names another workspace is
 * another key.
 */
function scopeKey(scope: ActionScope): string {
  return scope.kind === "board"
    ? `board:${scope.host}:${scope.workspaceId ?? ""}:${scope.projectKey}`
    : `wiki:${scope.host}:${scope.workspaceId ?? ""}`;
}

/** The scope a `scopeKey` names; null for anything else. */
function scopeOfKey(key: string): ActionScope | null {
  const [kind, host, workspaceId, projectKey] = key.split(":");
  if (!host) return null;
  const workspace = workspaceId ? { workspaceId } : {};
  if (kind === "board" && projectKey) return { kind, host, ...workspace, projectKey };
  if (kind === "wiki" && projectKey === undefined) return { kind, host, ...workspace };
  return null;
}

/** How an approval names a resolved board or Wiki. */
function scopeLabel(scope: ActionScope): string {
  return scope.kind === "board" ? `Board ${scope.projectKey} on ${scope.host}` : `Wiki of ${scope.host}`;
}

/**
 * The records of one board or Wiki of an account binding, kept apart from every other target's so
 * one board's pending moves never show on another, and each indexed by action id so the overseer's
 * apply, reject and revert (which name the id only) reach the right one.
 */
class ScopedActionStore extends ActionStore {
  constructor(kv: SyncKvStorage, readonly key: string) {
    super(kv, `scope:${key}/${ACTION_PREFIX}`);
  }

  override put(record: ActionRecord): void {
    super.put(record);
    this.kv.put(ACTION_SCOPE_PREFIX + record.actionId, this.key);
  }

  override delete(actionId: number): void {
    super.delete(actionId);
    this.kv.delete(ACTION_SCOPE_PREFIX + actionId);
  }
}

/**
 * The recorded action an account facet's action id names, with its resolved scope and the key of
 * the store it is in; or undefined.
 */
function indexedAction(kv: SyncKvStorage, actionId: number):
    { record: ActionRecord & { scope: ActionScope }; key: string } | undefined {
  const key = kv.get<string>(ACTION_SCOPE_PREFIX + actionId);
  if (key === undefined) return undefined;
  const record = new ScopedActionStore(kv, key).get(actionId);
  return record?.scope ? { record: record as ActionRecord & { scope: ActionScope }, key } : undefined;
}

/** Whether a verifier's account can open one data set an account binding has read. */
async function setAccess(verifier: InferOpsVerifierApi, key: string): Promise<boolean> {
  const scope = scopeOfKey(key);
  if (!scope) return false;
  return scope.kind === "board"
    ? verifier.hasProjectAccess(scope.host, scope.projectKey, scope.workspaceId)
    : verifier.hasWikiAccess(scope.host, scope.workspaceId);
}

/**
 * One account binding: `inferops://<tenant>/account`. Its props hold the account and the tenant
 * label and nothing else; each board or Wiki is named when it is opened (`openBoard`, `openWiki`),
 * checked then against the person's own workspaces, and fixed into the session it opens and into
 * every action proposed through it. Applying an action resolves its workspace again and refuses
 * one that changed. Observers are strategy C: one tracked set per board and per Wiki read.
 */
@validateRpc()
export class InferOpsAccountGatekeeper
    extends DurableObject<Cloudflare.Env, AccountGatekeeperProps>
    implements Gatekeeper<InferOpsAccountSession> {
  #observerTracker?: ObserverTracker<InferOpsVerifierApi>;

  /** The binding's collaborators and the sets they were checked against (one tracker per facet). */
  get #tracker(): ObserverTracker<InferOpsVerifierApi> {
    this.#observerTracker ??= new ObserverTracker<InferOpsVerifierApi>({
      kv: this.ctx.storage.kv,
      collectionPrefix: OBSERVED_SET_PREFIX,
      vendorId: VENDOR_ID,
      hasCollectionAccess: (verifier, keys) => Promise.all(keys.map(key => setAccess(verifier, key))),
      denyMessage: () =>
        "This collaborator cannot open every InferOps board and Wiki the Gadget read through this " +
        "connection, so they cannot observe it.",
    });
    return this.#observerTracker;
  }

  #account(): AccountRef {
    const { accountId, connected } = this.ctx.props;
    return { accountId, connected };
  }

  /**
   * The person's own workspace of `product` a reference's host names, or null when the host is not
   * of this binding's organization, the person holds no such workspace, or nobody connected backs
   * a non-demo binding. Undefined for the demo data, which has no workspace.
   */
  async #workspaceOf(host: string, product: WorkspaceProduct): Promise<string | null | undefined> {
    if (!hostInTenant(host, this.ctx.props.tenant)) return null;
    if (host === DEMO_HOST) return undefined;
    const labels = parseHost(host);
    if (!labels || !this.ctx.props.connected) return null;
    return credentialsOf(this.ctx.exports, this.ctx.props.accountId).resolveWorkspace(labels.workspace, product);
  }

  /** Authorize one observation of `key`'s data set: strategy C's forward check, then the queue. */
  async #observeSet(queue: RpcStub<ApprovalQueue>, key: string, description: ObservationDescription) {
    const check = await this.#tracker.prepareObservation([key]);
    const excluded = [...new Set([...description.excludeObservers ?? [], ...check.excludeObservers ?? []])];
    const { excludeObservers: _, ...rest } = description;
    try {
      await queue.authorizeObservation(excluded.length > 0 ? { ...rest, excludeObservers: excluded } : rest);
    } catch (error) {
      if (isObservationRefused(error)) check.discard?.();
      else check.abandon?.();
      throw error;
    }
    check.commit();
  }

  /**
   * Authorize an observation no collaborator was admitted for (the workspace list, a board search,
   * a page's composed text): every current collaborator is excluded, and once it is recorded the
   * binding is owner-only for good (gatekeeper-kit's withhold latch), since a set-less read gives a
   * later collaborator nothing to be verified against.
   */
  async #observeWithheld(queue: RpcStub<ApprovalQueue>, description: ObservationDescription) {
    const check = this.#tracker.prepareWithheld();
    const excluded = check.excludeObservers ?? [];
    try {
      await queue.authorizeObservation(excluded.length > 0 ? { ...description, excludeObservers: excluded } : description);
    } catch (error) {
      if (isObservationRefused(error)) check.discard?.();
      else check.abandon?.();
      throw error;
    }
    check.commit();
  }

  /**
   * `key` is the store the records live in: the scope's own, except when routing an action id,
   * which uses the store its index names, so a record whose stored target was changed is refused
   * by its fingerprint rather than looked up elsewhere.
   */
  #parts(scope: ActionScope, key = scopeKey(scope)): BindingParts {
    return {
      store: new ScopedActionStore(this.ctx.storage.kv, key),
      client: clientFor(this.env, this.ctx.exports, this.#account(), scope.host, scope.workspaceId),
      observers: () => this.#tracker.observerIds(),
      observe: (queue, description) => this.#observeSet(queue, key, description),
      withhold: (queue, description) => this.#observeWithheld(queue, description),
      admitSearch: () => credentialsOf(this.ctx.exports, this.#account().accountId).admitWikiSearch(),
      account: { scope, label: scopeLabel(scope) },
    };
  }

  #boardBinding(scope: Extract<ActionScope, { kind: "board" }>, key?: string): ProjectBinding {
    const target: ProjectGatekeeperProps = {
      ...this.#account(), host: scope.host, projectKey: scope.projectKey, workspaceId: scope.workspaceId,
    };
    return new ProjectBinding(target, this.#parts(scope, key),
      () => otherWorkspacesOf(this.env, this.ctx.exports, target));
  }

  #wikiBinding(scope: Extract<ActionScope, { kind: "wiki" }>, key?: string): WikiBinding {
    return new WikiBinding({ ...this.#account(), host: scope.host, workspaceId: scope.workspaceId },
      this.#parts(scope, key));
  }

  /**
   * Narrow to one board: the reference parses as a board (so a dispatch, workflow, table, members or
   * page reference is refused), is of this organization, names one of the person's own InferOps
   * workspaces, and the project exists there for their own token. Every refusal is NOT_FOUND with
   * one message. Not an observation: the board session's reads are.
   */
  async #openBoard(boardRef: string): Promise<ProjectBinding> {
    let ref: ProjectBoardRef;
    try {
      ref = parseProjectBoardUrl(boardRef);
    } catch {
      fail("NOT_FOUND", NO_SUCH_BOARD);
    }
    const workspaceId = await this.#workspaceOf(ref.host, "inferops");
    if (workspaceId === null) fail("NOT_FOUND", NO_SUCH_BOARD);
    const binding = this.#boardBinding({
      kind: "board", host: ref.host, projectKey: ref.projectKey, ...(workspaceId ? { workspaceId } : {}),
    });
    try {
      if (!(await binding.client.hasProject(ref.projectKey))) fail("NOT_FOUND", NO_SUCH_BOARD);
    } catch (error) {
      const code = inferOpsErrorCode(error);
      if (code === "NOT_FOUND" || code === "FORBIDDEN") fail("NOT_FOUND", NO_SUCH_BOARD);
      throw error;
    }
    return binding;
  }

  /**
   * Narrow to one Wiki, as `openBoard` narrows to a board: the reference parses as a Wiki, is of
   * this organization, names one of the person's own InferMind workspaces (an InferOps one has no
   * Wiki), and the Wiki answers their own token.
   */
  async #openWiki(wikiRef: string): Promise<WikiBinding> {
    let ref: WikiRef;
    try {
      ref = parseWikiUrl(wikiRef);
    } catch {
      fail("NOT_FOUND", NO_SUCH_WIKI);
    }
    const workspaceId = await this.#workspaceOf(ref.host, "infermind");
    if (workspaceId === null) fail("NOT_FOUND", NO_SUCH_WIKI);
    const binding = this.#wikiBinding({ kind: "wiki", host: ref.host, ...(workspaceId ? { workspaceId } : {}) });
    try {
      await binding.client.listDocuments();
    } catch (error) {
      const code = inferOpsErrorCode(error);
      if (code === "NOT_FOUND" || code === "FORBIDDEN") fail("NOT_FOUND", NO_SUCH_WIKI);
      throw error;
    }
    return binding;
  }

  /**
   * The person's workspaces in this organization, each with its slug: the demo's one workspace for
   * the demo data. Withheld from every collaborator, and the binding is owner-only from then on.
   */
  async #listWorkspaces(queue: RpcStub<ApprovalQueue>): Promise<AccountWorkspace[]> {
    const { tenant } = this.ctx.props;
    const workspaces: AccountWorkspace[] = tenant === DEMO_HOST
      ? [{ slug: "local", name: "Demo data", product: "inferops" },
         { slug: "local", name: "Demo data", product: "infermind" }]
      : ((await credentialsOf(this.ctx.exports, this.ctx.props.accountId).identity())?.workspaces ?? [])
        .flatMap(w => w.workspaceSlug && parseHost(`${tenant}.${w.workspaceSlug}`)
          ? [{ slug: w.workspaceSlug, name: w.workspaceName, product: w.product ?? "inferops" }] : []);
    await this.#observeWithheld(queue, {
      title: `Listed your InferOps workspaces in ${tenant}`,
      description: `Listed the ${workspaces.length} InferOps and InferMind workspaces you hold in ${tenant}.`,
    });
    return workspaces;
  }

  /**
   * Rank the boards of every InferOps workspace the person holds in this organization (or the
   * demo's), as a board binding's `findBoards` does; a workspace InferOps now refuses is left out.
   * Withheld from every collaborator, and the binding is owner-only from then on, since none was
   * admitted for boards not yet read.
   */
  async #findBoards(queue: RpcStub<ApprovalQueue>, query: string): Promise<BoardCandidate[]> {
    const text = boardQuery(query);
    const { tenant } = this.ctx.props;
    const account = this.#account();
    const sources: DiscoverySource[] = tenant === DEMO_HOST
      ? [{ host: DEMO_HOST, client: clientFor(this.env, this.ctx.exports, account, DEMO_HOST) }]
      : ((await credentialsOf(this.ctx.exports, account.accountId).identity())?.workspaces ?? [])
        .flatMap(w => {
          const host = `${tenant}.${w.workspaceSlug}`;
          if (w.product === "infermind" || !w.workspaceSlug || !parseHost(host)) return [];
          return [{ host, client: clientFor(this.env, this.ctx.exports, account, host, w.workspaceId) }];
        });
    const { candidates, workspaces, count } = await searchBoards(text, sources, () => true);
    await this.#observeWithheld(queue, {
      title: `Searched InferOps boards in ${tenant}`,
      description: searchedText(count, workspaces, candidates),
    });
    return candidates;
  }

  async describe(): Promise<ResourceDescription> {
    const { tenant } = this.ctx.props;
    return {
      url: accountUrl({ tenant }),
      title: `InferOps account ${tenant}`,
      snippet: `Every InferOps board and InferMind Wiki your own account can open in ${tenant}: list ` +
        `your workspaces, find boards, and open a board or a Wiki by its reference.`,
      suggestedBindingName: "INFEROPS",
      tsType: "InferOpsAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every write waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsAccountSession> {
    return new AccountSessionImpl({
      openBoard: ref => this.#openBoard(ref),
      openWiki: ref => this.#openWiki(ref),
      listWorkspaces: queue => this.#listWorkspaces(queue),
      findBoards: (queue, query) => this.#findBoards(queue, query),
    }, approvalQueue.dup());
  }

  /**
   * Strategy C: admit a collaborator whose own account can open every board and Wiki read through
   * this binding so far; each one read later is checked again for every collaborator then.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#tracker.addObserver(id, asVerifier<InferOpsVerifierApi>(user));
  }

  async removeObserver(id: string): Promise<void> {
    this.#tracker.removeObserver(id);
  }

  /**
   * The binding of the board or Wiki an action was proposed on, and a check that its workspace
   * still resolves to the one recorded: the person may have lost it, or its slug may name another
   * workspace now. Undefined for an id this facet never staged.
   */
  #routed(actionId: number) {
    const indexed = indexedAction(this.ctx.storage.kv, actionId);
    if (!indexed) return undefined;
    const { record, key } = indexed;
    const { scope } = record;
    const check = async () => {
      const now = await this.#workspaceOf(scope.host, scope.kind === "board" ? "inferops" : "infermind");
      if (now !== scope.workspaceId) {
        logger.warn("action refused: its workspace no longer resolves", {
          event: "account.apply.workspace_changed", host: scope.host, action: actionId, code: "NOT_FOUND",
        });
        throw new CheckRefused("NOT_FOUND", `${actionLabel(record)} was not applied: ` +
          `${scopeLabel(scope)} is no longer one of your workspaces.`);
      }
    };
    return scope.kind === "board"
      ? { kind: "board" as const, binding: this.#boardBinding(scope, key), check, record }
      : { kind: "wiki" as const, binding: this.#wikiBinding(scope, key), check, record };
  }

  /**
   * Apply as the board or Wiki facet would, after the fingerprint (which covers the resolved
   * target) and the workspace check of `#routed`.
   */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure } | ActionApplied> {
    const routed = this.#routed(actionId);
    if (!routed) throw new Error(`Unknown InferOps action ${actionId}.`);
    return routed.kind === "board"
      ? applyBoardAction(routed.binding, actionId, routed.check)
      : applyWikiAction(routed.binding, actionId, routed.check);
  }

  async rejectAction(actionId: number): Promise<void> {
    const routed = this.#routed(actionId);
    if (routed) rejectPending(routed.binding, actionId);
  }

  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const routed = this.#routed(actionId);
    if (!routed) return { message: "This change was never applied, so there is nothing to revert." };
    // As at apply: a workspace the person no longer holds (or a slug now naming another) is not written.
    try {
      if (routed.record.status === "applied") await routed.check();
    } catch (error) {
      if (error instanceof CheckRefused) {
        return { message: error.reason.replace(" was not applied: ", " was not reverted: ") };
      }
      throw error;
    }
    return routed.kind === "board"
      ? revertBoardAction(routed.binding, actionId)
      : revertWikiAction(routed.binding, actionId);
  }
}

/** What an account session asks of its facet; private to both, so neither's RPC surface has it. */
type AccountScopes = {
  openBoard(boardRef: string): Promise<ProjectBinding>;
  openWiki(wikiRef: string): Promise<WikiBinding>;
  listWorkspaces(queue: RpcStub<ApprovalQueue>): Promise<AccountWorkspace[]>;
  findBoards(queue: RpcStub<ApprovalQueue>, query: string): Promise<BoardCandidate[]>;
};

@validateRpc()
class AccountSessionImpl extends RpcTarget implements InferOpsAccountSession {
  #scopes: AccountScopes;
  #queue: RpcStub<ApprovalQueue>;

  constructor(scopes: AccountScopes, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#scopes = scopes;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async listWorkspaces(): Promise<AccountWorkspace[]> {
    return this.#scopes.listWorkspaces(this.#queue);
  }

  async findBoards(query: string): Promise<BoardCandidate[]> {
    return this.#scopes.findBoards(this.#queue, query);
  }

  /** The board session holds its own queue, so it outlives this session. */
  async openBoard(boardRef: string): Promise<InferOpsProjectSession> {
    return new ProjectSessionImpl(await this.#scopes.openBoard(boardRef), this.#queue.dup());
  }

  /** The Wiki session holds its own queue, so it outlives this session. */
  async openWiki(wikiRef: string): Promise<InferOpsWikiSession> {
    return new WikiSessionImpl(await this.#scopes.openWiki(wikiRef), this.#queue.dup());
  }
}

// ---------------------------------------------------------------------------
// Custom-table gatekeeper (a facet of the Overseer, one per binding)

/** Why every action call on a table binding is refused: it never submits one. */
const TABLE_READ_ONLY = "An InferOps custom table binding is read-only and has no actions.";

@validateRpc()
export class InferOpsTableGatekeeper
    extends DurableObject<Cloudflare.Env, TableGatekeeperProps>
    implements Gatekeeper<InferOpsTableSession> {
  async describe(): Promise<ResourceDescription> {
    const { host, tableId } = this.ctx.props;
    return {
      url: tableUrl({ host, tableId }),
      title: `InferOps custom table on ${host}`,
      snippet: `One InferOps custom table on ${host}: read its rows, without personal columns.`,
      suggestedBindingName: "INFEROPS_TABLE",
      tsType: "InferOpsTableSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsTableSession> {
    const { accountId, connected, host, tableId, workspaceId } = this.ctx.props;
    const client = tableClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId);
    return new TableSessionImpl({ client, host, tableId }, approvalQueue.dup());
  }

  /**
   * Strategy A, private only: no collaborator is admitted to a gadget that holds this binding, so
   * sharing a workspace whose gadget uses it is refused. The account's verifier is not consulted.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "An InferOps custom table binding is private to the person who connected it, so this " +
      "gadget cannot be shared.");
  }

  /** Nothing is tracked: no observer is ever admitted. */
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error(TABLE_READ_ONLY);
  }

  async rejectAction(_actionId: number): Promise<void> {
    throw new Error(TABLE_READ_ONLY);
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error(TABLE_READ_ONLY);
  }
}

/** Run a governed-request check, its refusal becoming the session's own INVALID_REQUEST (FAC-9). */
function governedRequest<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof GovernedRequestError) {
      throw new InferOpsError("INVALID_REQUEST",
          error.code === "INVALID_REQUEST" ? error.message : `${error.code}: ${error.message}`);
    }
    throw error;
  }
}

/** What a table session reads with: its data source and the bound host and table. */
type TableScope = { client: InferOpsClient; host: string; tableId: string };

@validateRpc()
class TableSessionImpl extends RpcTarget implements InferOpsTableSession {
  #scope: TableScope;
  #queue: RpcStub<ApprovalQueue>;

  constructor(scope: TableScope, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#scope = scope;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  /** The bound table, read once; a read of another table is never possible from here. */
  #read(limit: number, relatedTo?: string): Promise<TableRead> {
    const { client, host, tableId } = this.#scope;
    return client.readTable(host, tableId, relatedTo === undefined ? { limit } : { relatedTo, limit });
  }

  async describeTable(): Promise<TableDescription> {
    const table = describeTable(await this.#read(1));
    await this.#queue.authorizeObservation({
      title: "Describe InferOps custom table",
      description: `Read the definition of the custom table ${plainInline(table.label)} on ` +
        `${this.#scope.host}: ${table.columns.length} columns and ${table.relations.length} relations.`,
    });
    return table;
  }

  async listRecords(options?: ListRecordsOptions): Promise<{ table: TableDescription; records: TableRecord[] }> {
    const { relatedTo, limit } = tableReadOptions(options);
    const result = projectRows(await this.#read(limit, relatedTo));
    await this.#queue.authorizeObservation({
      title: "List InferOps custom table rows",
      // The relatedTo reference is caller input: it is not repeated into the log.
      description: `Read ${result.records.length} rows of the custom table ` +
        `${plainInline(result.table.label)} on ${this.#scope.host}` +
        `${relatedTo === undefined ? "" : ", linked to one endpoint"}.`,
    });
    return result;
  }

  // The table as a governed resource (FAC-9), from one read's own definition: its visible columns
  // (describeTable never includes a personal one), each filterable and sortable, and no commands.
  #governed(read: TableRead): GovernedDescription {
    return {
      resource: "object/table",
      fields: describeTable(read).columns.map(column => ({
        name: column.name, label: column.label,
        type: column.type === "integer" || column.type === "number" ? "number"
          : column.type === "timestamp" || column.type === "date" ? "date" : column.type,
        filterable: true, sortable: true,
      })),
      commands: [],
    };
  }

  /** The bound table's definition alone, with no rows (`readTableDefinition`). */
  async #definition(): Promise<TableRead> {
    const { client, host, tableId } = this.#scope;
    return { table: await client.readTableDefinition(host, tableId), rows: [] };
  }

  async describe(): Promise<GovernedDescription> {
    const definition = await this.#definition();
    const description = this.#governed(definition);
    await this.#queue.authorizeObservation({
      title: "Describe InferOps custom table",
      description: `Read the definition of the custom table ${plainInline(describeTable(definition).label)} on ` +
        `${this.#scope.host}: ${description.fields.length} fields.`,
    });
    return description;
  }

  async list(query?: GovernedListQuery): Promise<GovernedListResult> {
    // Checked before any row is read: the request's shape, then its fields and types against the
    // table's definition alone, so an unknown, a personal and a wrong-typed field are each refused
    // at the same step, reading no row and logging nothing.
    governedRequest(() => parseGovernedListRequest(query ?? {}, null));
    const definition = await this.#definition();
    governedRequest(() => parseGovernedListRequest(query ?? {}, this.#governed(definition)));
    const read = await this.#read(MAX_TABLE_ROWS);
    // And again against the definition the rows came with: a column that turned personal between
    // the two reads is refused here, before anything is returned or logged.
    const request = governedRequest(() => parseGovernedListRequest(query ?? {}, this.#governed(read)));
    const { table, records } = projectRows(read);
    const result = listGoverned(records.map(record => ({ id: record.id, values: record.values })), request);
    await this.#queue.authorizeObservation({
      title: "List InferOps custom table rows",
      // Filter values are caller input: only how many there were is logged.
      description: `Read ${result.rows.length} of ${result.total} matching rows of the custom table ` +
        `${plainInline(table.label)} on ${this.#scope.host}` +
        `${request.filters.length ? `, with ${request.filters.length} filter(s)` : ""}.`,
    });
    return {
      rows: result.rows as GovernedListResult["rows"], nextCursor: result.nextCursor, total: result.total,
      // One read returns at most MAX_TABLE_ROWS rows: a full read may have left newer-than-oldest rows out.
      truncated: result.truncated || read.rows.length >= MAX_TABLE_ROWS,
    };
  }

  async get(id: string): Promise<GovernedRow | null> {
    try {
      const { record } = await this.getRecord(id);
      return { id: record.id, values: record.values };
    } catch (error) {
      if (inferOpsErrorCode(error) === "NOT_FOUND") return null;
      throw error;
    }
  }

  async getRecord(id: string): Promise<{ table: TableDescription; record: TableRecord }> {
    const { client, host, tableId } = this.#scope;
    if (!UUID.test(id)) throw tableNotFound();
    const read = await client.readTableRow(host, id);
    // A row of another table of the same workspace reads exactly as a missing one.
    if (read.table.id !== tableId) throw tableNotFound();
    const { table, records } = projectRows(read);
    const record = records[0];
    if (!record) throw tableNotFound();
    await this.#queue.authorizeObservation({
      title: "Read InferOps custom table row",
      description: `Read one row of the custom table ${plainInline(table.label)} on ${host}.`,
    });
    return { table, record };
  }
}

// ---------------------------------------------------------------------------
// Workspace-members gatekeeper (a facet of the Overseer, one per binding)

/** Why every action call on a members binding is refused: it never submits one. */
const MEMBERS_READ_ONLY = "An InferOps workspace members binding is read-only and has no actions.";

@validateRpc()
export class InferOpsMembersGatekeeper
    extends DurableObject<Cloudflare.Env, MembersGatekeeperProps>
    implements Gatekeeper<InferOpsMembersSession> {
  async describe(): Promise<ResourceDescription> {
    const { host } = this.ctx.props;
    return {
      url: membersUrl({ host }),
      title: `InferOps workspace members on ${host}`,
      snippet: `Who has access to the InferOps workspace on ${host}: their role and explicit denies, without email.`,
      suggestedBindingName: "INFEROPS_MEMBERS",
      tsType: "InferOpsMembersSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsMembersSession> {
    const { accountId, connected, host, workspaceId } = this.ctx.props;
    const client = membersClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId);
    return new MembersSessionImpl({ client, host, workspaceId }, approvalQueue.dup());
  }

  /**
   * Private only, as a table binding is: no collaborator is admitted to a gadget that holds this
   * binding, so sharing a workspace whose gadget uses it is refused.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "An InferOps workspace members binding is private to the person who connected it, so this " +
      "gadget cannot be shared.");
  }

  /** Nothing is tracked: no observer is ever admitted. */
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error(MEMBERS_READ_ONLY);
  }

  async rejectAction(_actionId: number): Promise<void> {
    throw new Error(MEMBERS_READ_ONLY);
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error(MEMBERS_READ_ONLY);
  }
}

/** What a members session reads with: its data source, the bound host and workspace. */
type MembersScope = { client: InferOpsClient; host: string; workspaceId?: string };

@validateRpc()
class MembersSessionImpl extends RpcTarget implements InferOpsMembersSession {
  #scope: MembersScope;
  #queue: RpcStub<ApprovalQueue>;

  constructor(scope: MembersScope, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#scope = scope;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async listMembers(): Promise<WorkspaceMembers> {
    const { client, host, workspaceId } = this.#scope;
    const result = projectMembers(await client.listWorkspaceMembers(workspaceId));
    await this.#queue.authorizeObservation({
      title: "List InferOps workspace members",
      // A count and the workspace, never a member's name, id or email.
      description: `Read ${result.members.length} members of the workspace ` +
        `${plainInline(result.workspace.workspaceName)} on ${host}.`,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Workflow-policy gatekeeper (a facet of the Overseer, one per binding)

/** Why every action call on a workflow-policy binding is refused: it never submits one. */
const WORKFLOW_POLICY_READ_ONLY = "An InferOps workflow policy binding is read-only and has no actions.";

@validateRpc()
export class InferOpsWorkflowPolicyGatekeeper
    extends DurableObject<Cloudflare.Env, WorkflowPolicyGatekeeperProps>
    implements Gatekeeper<InferOpsWorkflowPolicySession> {
  async describe(): Promise<ResourceDescription> {
    const { host, projectKey } = this.ctx.props;
    return {
      url: projectWorkflowUrl({ host, projectKey }),
      title: `InferOps workflow policy for ${projectKey} on ${host}`,
      snippet: `The published content-workflow policy of ${projectKey} on ${host}: lanes, rules, ` +
        "guards and transitions, without rule reasons.",
      suggestedBindingName: "INFEROPS_WORKFLOW_POLICY",
      tsType: "InferOpsWorkflowPolicySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<InferOpsWorkflowPolicySession> {
    const { accountId, connected, host, projectKey, workspaceId } = this.ctx.props;
    const client = workflowPolicyClientFor(this.env, this.ctx.exports, { accountId, connected }, host, workspaceId);
    return new WorkflowPolicySessionImpl({ client, host, projectKey }, approvalQueue.dup());
  }

  /**
   * Private only, as a members binding is: no collaborator is admitted to a gadget that holds this
   * binding, so sharing a workspace whose gadget uses it is refused.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "An InferOps workflow policy binding is private to the person who connected it, so this " +
      "gadget cannot be shared.");
  }

  /** Nothing is tracked: no observer is ever admitted. */
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(_actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    throw new Error(WORKFLOW_POLICY_READ_ONLY);
  }

  async rejectAction(_actionId: number): Promise<void> {
    throw new Error(WORKFLOW_POLICY_READ_ONLY);
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error(WORKFLOW_POLICY_READ_ONLY);
  }
}

/** What a workflow-policy session reads with: its data source, the bound host and project key. */
type WorkflowPolicyScope = { client: InferOpsClient; host: string; projectKey: string };

@validateRpc()
class WorkflowPolicySessionImpl extends RpcTarget implements InferOpsWorkflowPolicySession {
  #scope: WorkflowPolicyScope;
  #queue: RpcStub<ApprovalQueue>;

  constructor(scope: WorkflowPolicyScope, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#scope = scope;
    this.#queue = queue;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  async readWorkflowPolicy(): Promise<WorkflowPolicyHead> {
    const { client, host, projectKey } = this.#scope;
    // Fresh on every call: nothing is cached, so `revision` says which publication was read.
    const result = projectWorkflowHead(await client.readWorkflowPolicy(projectKey));
    await this.#queue.authorizeObservation({
      title: "Read InferOps workflow policy",
      // The project, host, revision and whether it is configured; never a subject, id, rule,
      // reason or lane name.
      description: `Read the ${result.configured ? "configured" : "unconfigured"} workflow policy of ` +
        `${projectKey} on ${host} at revision ${result.revision}.`,
    });
    return result;
  }
}

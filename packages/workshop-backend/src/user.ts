import { MAX_READ_GENERATION, isLegacyReadSelector, newReadRunSelectors, parseReadRunSelectors, parseReadSelector } from "@gadgets/workshop-shared/operate-read-run";
import { RpcStub } from "capnweb";
import { openAiCommand } from './openai-plugin.js';
import { isOpenAiPluginEnabled, modelsSchema, stateSchema } from '@gadgets/assistant-plugin-openai/protocol';
import { localApiModels } from './local-api-models.js';
import { modelNotOfferedMessage } from './model-allowlist.js';
import { isCloudflareLimitsEnabled } from './ai-gateway-billing/config.js';
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, RedactedAiModelConfig, SUGGESTED_MODELS, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, GatekeeperVendorInfo, BlueprintOutput, OutputSummary, WorkpieceId, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, ConnectFlowStart, validateCommitEmail, OperateSessionUpdate, OPERATE_SESSION_ERROR_CODES, createOperateSessionError, getOperateSessionErrorCode, WorkspaceKind, createPublicationError, PUBLICATION_ERROR_CODES, PublicationDestination, PublicationRecord } from '@gadgets/workshop-shared/api';
import {
  WIDGET_STATE_ERROR_CODES, WidgetStateError, applyWidgetTransition, recoverWidgetState, widgetEventsFrom,
  type WidgetStateMachine, type WidgetStateSnapshot, widgetStateKeyPlacement,
} from '@gadgets/workshop-shared/widget-state';
import {
  WIDGET_PLACEMENT_ERROR_CODES, WIDGET_PLACEMENT_LIMITS, WidgetPlacementError, orderWidgetPlacements, parseWidgetPlacementInput,
  sameWidgetPlacementRef, type WidgetPlacement, type WidgetPlacementInput, type WidgetPlacements,
} from '@gadgets/workshop-shared/widget-placements';
import { applyOperateEvent, INITIAL_OPERATE_PAGE, OperateEventError, operateEventSubject, type OperateEvent, type OperateEventActor, type OperateEventRecord, type OperateHandover, type OperateSessionSnapshot, type RunNavigationOutcome, type RunNavigationRequest } from '@gadgets/workshop-shared/operate-session';
import { Gatekeeper, GatekeeperSubject, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback, ConnectHandoff, SupportedResource, ResourceConfiguratorFrame, AppUiContext, GatekeeperUiFrame, SharedConfigurationAction, SharedConfigurationAnswer, WidgetIndexEntry, WidgetIndexOutcome, WidgetIndexWorkspace, WidgetSearchAnswer, WidgetSearchUnavailableReason, mergeWidgetSearches } from "@gadgets/workshop-shared/gatekeeper";
import { shouldAutoProvisionAccount, ambientGatekeeperMode } from "./provisioning-policy.js";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { subjectAccountName, type SubjectBinding } from "./account-subject";

/** Why a bound account refuses an email-keyed sign-in (ADR 0019 decision 4). Safe to show. */
export const SIGNS_IN_THROUGH_SUBJECT = "This account signs in with InferOps. Use InferOps sign-in.";
/** A subject's sign-in reached an account bound to another (never expected; the directory decides). */
const SUBJECT_MISMATCH = "This account belongs to another sign-in.";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { recordAnalytics } from "./analytics";
import { createWorkshopLogger } from "./observability";
import { getAiGatewayConfig, type AiGatewayConfig } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { blueprintVersionKeys, isReservedBlueprintKey, readBlueprintContent, readBlueprintKvRecord } from "./blueprint-archive.js";
import { assertPublicationFlagOn, byRequestedDesc, PUBLICATION_AUDIENCES, readPublicationSnapshot, withPublicationStatus, type StoredPublicationRecord } from "./publication.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import { getSharedConfigurationGatekeeper } from "./auth/config.js";
import { CONNECT_FLOW_LIFETIME_MS, handoffTargetOrigin, hashPresentedSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from "./connect-handoff.js";

const logger = createWorkshopLogger("workshop.user");

// When a person's connected accounts answer for more than one scope (for InferOps, a company).
const SHARED_CONFIGURATION_AMBIGUOUS =
  "Your connected accounts belong to more than one organization, so it isn't clear which one " +
  "decides who may change shared configuration here. Disconnect the others, then try again.";

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
  // True if the Workshop created this account automatically via GatekeeperVendor.createAccount()
  // (no OAuth flow), rather than the user connecting it. Such accounts are protected from manual
  // disconnect, since deleting one permanently destroys the user's data in that gatekeeper.
  autoProvisioned?: boolean;
  // Account provenance for host boards (see hostBoardAccount): `incarnation` is fresh whenever the
  // record starts pointing at a new account stub (a connect, or a same-id replacement), and `epoch`
  // rises on every authoritative mutation (that, an expiry, a reconnect). Records written before
  // either existed read as incarnation "initial" at epoch 0 until their next mutation.
  incarnation?: string;
  epoch?: number;
};

/**
 * A connected account's provenance, as the host-board kernel path compares it: the account, its
 * vendor, the incarnation of its account stub and the epoch of its last authoritative mutation.
 */
export type HostBoardAccount = { accountId: number; vendorId: string; incarnation: string; epoch: number };

type AccountStorage = Pick<ReturnType<typeof makeUserStorage>, "connectedAccounts" | "accountEpoch">;

/**
 * Writes a connected-account record, stamping its provenance: a new epoch always, and a new
 * incarnation when the record now points at a different account stub (`"replaced"`). Every write
 * that changes an account goes through here.
 */
export function putAccount(storage: AccountStorage, record: ConnectedAccountRecord, change: "replaced" | "mutated"): void {
  let epoch = storage.accountEpoch.get() + 1;
  storage.accountEpoch.put(epoch);
  record.epoch = epoch;
  if (change === "replaced") record.incarnation = crypto.randomUUID();
  storage.connectedAccounts.put(record);
}

/** Connected account `accountId`'s provenance now, or null when it does not exist. */
export function accountProvenance(storage: Pick<AccountStorage, "connectedAccounts">, accountId: number)
    : HostBoardAccount | null {
  let record = storage.connectedAccounts.get(accountId);
  if (!record) return null;
  return { accountId, vendorId: record.vendorId, incarnation: record.incarnation ?? "initial", epoch: record.epoch ?? 0 };
}

// A connect ("connect") or reconnect/ensureResources ("restore") flow that a gatekeeper has finished
// but the user's browser has not yet confirmed (see connect-handoff.ts). Keyed by the SHA-256 of the
// ticket; single-use, and swept by alarm() once `expiresAt` passes.
type PendingHandoffRecord = {
  ticketHash: string;
  kind: "connect" | "restore";
  accountId: number;
  expiresAt: Date;
  credentialExpiresAt?: Date;
  // The staged account, present for `kind: "connect"` only; becomes the ConnectedAccountRecord.
  connect?: Pick<ConnectedAccountRecord, "account" | "description" | "vendorId">;
  // The gatekeeper's id for the staged credentials, present for `kind: "restore"` only; passed back
  // in commitReconnect() so this ticket can activate no other stage's credentials.
  stageId?: string;
};

// A started connect / reconnect / ensure-resources flow, keyed by the hash of the nonce the Workshop
// tab gave the popup (see ConnectFlowStart); completeConnectHandoff requires the ticket's record and
// the nonce's flow to name the same account. Single-use, and swept by alarm() once `expiresAt` passes.
type PendingConnectFlow = {
  nonceHash: string;
  accountId: number;
  expiresAt: Date;
};

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
};

// The singleton/UI methods (createAccount on GatekeeperVendor; getSingletonGatekeeperClass /
// startAppUi on GatekeeperUser) are optional on their interfaces. We don't need to probe whether a
// method is present — we already know from the declaration flags (autoProvisionsAccount /
// description.singleton / .providesUi) that we gated on — but TypeScript still can't call an optional
// method on the mapped stub type directly, so we view the stub through a plain shape that marks the
// needed method required. These are derived from the source interfaces (Pick + Required) rather than
// re-declared, so they can't drift. They are intentionally NOT wrapped in Service/Fetcher: a plain
// shape keeps the methods' declared return types (e.g. createAccount's Fetcher<GatekeeperUser>)
// usable directly, the way the runtime stub actually behaves.
type AccountCreatorStub = Required<Pick<GatekeeperVendor, "createAccount">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser, "getSingletonGatekeeperClass" | "startAppUi">>;
// Called only on accounts of the vendor SHARED_CONFIGURATION_GATEKEEPER names; see the note above.
type SharedConfigurationAccountStub = Required<Pick<GatekeeperUser, "holdsSharedConfiguration" | "holdsWorkflowInvoke">>;

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

/**
 * Whether `vendorId` says the person may `action` shared configuration here, asking each of their
 * connected accounts of that vendor with live credentials. Every answer must be about one scope
 * (`SharedConfigurationAnswer.scope`, for InferOps the company): accounts answering for different
 * scopes are refused as ambiguous, since nothing says which one this deployment belongs to, and an
 * account answering for none counts as no. Within the one scope, a yes from any account is a yes.
 * Only a literal `holds: true` with a scope counts. An account that can't answer fails the whole
 * check, since its scope is unknown too.
 */
export async function holdsSharedConfiguration(
    records: Iterable<ConnectedAccountRecord>, vendorId: string, action: SharedConfigurationAction,
): Promise<boolean> {
  return holdsDeploymentAuthority(records, vendorId, account => account.holdsSharedConfiguration(action),
      "Couldn't check whether you may change shared configuration. Try again.");
}

/**
 * Whether `vendorId` says the person may ask a configured system workflow to run against the
 * resource `resourceUrl` (FAC-102, InferOps' `workflow:invoke`, in that resource's own workspace
 * only), combined as `holdsSharedConfiguration` is: live accounts of that vendor, one scope, a yes
 * from any of them about that resource, and a failed answer refuses.
 */
export async function holdsWorkflowInvoke(
    records: Iterable<ConnectedAccountRecord>, vendorId: string, resourceUrl: string): Promise<boolean> {
  return (await workflowInvokeAnswer(records, vendorId, resourceUrl)).holds;
}

/**
 * `holdsWorkflowInvoke`'s answer with the company it was given in (FAC-111): the one scope the
 * person's live accounts of `vendorId` answered in, or null when none answered with a scope. A run
 * admitted on a yes records that company as its scope.
 */
export async function workflowInvokeAnswer(
    records: Iterable<ConnectedAccountRecord>, vendorId: string, resourceUrl: string,
): Promise<{ holds: boolean; company: string | null }> {
  return deploymentAuthority(records, vendorId, account => account.holdsWorkflowInvoke(resourceUrl),
      "Couldn't check whether you may run workflows. Try again.");
}

// The shared combiner for the two questions above: each live account of `vendorId` is asked once.
async function holdsDeploymentAuthority(
    records: Iterable<ConnectedAccountRecord>, vendorId: string,
    ask: (account: SharedConfigurationAccountStub) => Promise<SharedConfigurationAnswer>,
    failure: string,
): Promise<boolean> {
  return (await deploymentAuthority(records, vendorId, ask, failure)).holds;
}

// The combiner with the one scope it was answered in; more than one scope refuses, as before.
async function deploymentAuthority(
    records: Iterable<ConnectedAccountRecord>, vendorId: string,
    ask: (account: SharedConfigurationAccountStub) => Promise<SharedConfigurationAnswer>,
    failure: string,
): Promise<{ holds: boolean; company: string | null }> {
  let scopes = new Set<string>();
  let holds = false;
  for (let record of records) {
    if (record.vendorId !== vendorId || !areCredentialsValid(record)) continue;
    let answer: SharedConfigurationAnswer;
    try {
      answer = await ask(record.account as unknown as SharedConfigurationAccountStub);
    } catch (err) {
      logger.warn("deployment authority could not be read", {
        event: "shared.configuration.check.failed", vendorId, accountId: record.id, error: err,
      });
      throw new Error(failure, { cause: err });
    }
    if (typeof answer?.scope !== "string" || answer.scope === "") continue;
    scopes.add(answer.scope);
    if (answer.holds === true) holds = true;
  }
  if (scopes.size > 1) throw new Error(SHARED_CONFIGURATION_AMBIGUOUS);
  let [company] = scopes;
  return { holds, company: company ?? null };
}

// Called only on accounts of the vendor SHARED_CONFIGURATION_GATEKEEPER names; see the note above.
type PresentationCompanyAccountStub = Required<Pick<GatekeeperUser, "presentationCompany">>;

/**
 * The company a person's presentation state belongs to (FAC-88), from their own connected accounts
 * of `vendorId` (the deployment's SHARED_CONFIGURATION_GATEKEEPER), never from a caller. Expired
 * credentials still say which company an account is in, so they count: an expiry must not drop the
 * page. "" when the deployment names no vendor (it then belongs to one company, FAC-160) or no
 * account speaks for one; accounts in several companies are their own partition, the same in any
 * order. Throws when an account can't answer, since the company is then unknown.
 */
export async function presentationCompanyOf(
    records: Iterable<ConnectedAccountRecord>, vendorId: string | null,
): Promise<string> {
  if (!vendorId) return "";
  let companies = new Set<string>();
  for (let record of records) {
    if (record.vendorId !== vendorId) continue;
    let company: string | null;
    try {
      company = await (record.account as unknown as PresentationCompanyAccountStub).presentationCompany();
    } catch (err) {
      logger.warn("presentation company could not be read", {
        event: "presentation.company.read.failed", vendorId, accountId: record.id, error: err,
      });
      throw Object.assign(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.companyUnavailable), { cause: err });
    }
    if (typeof company === "string" && company !== "") companies.add(company);
  }
  // JSON keeps the parts apart whatever they contain, so no set of companies reads as another.
  return companies.size <= 1 ? [...companies].join("") : JSON.stringify([...companies].toSorted());
}

// Called only on accounts of the vendor SHARED_CONFIGURATION_GATEKEEPER names, by a console
// publication (see UserDurableObject.widgetIndexWorkspaces).
type WidgetIndexAccountStub = Required<Pick<GatekeeperUser, "widgetIndexWorkspaces" | "registerWidget" | "withdrawWidget">>;
// Called only on accounts of the vendor SHARED_CONFIGURATION_GATEKEEPER names, for the person's own
// widget search (see UserDurableObject.searchWidgets).
type WidgetSearchAccountStub = Required<Pick<GatekeeperUser, "searchWidgets">>;

/** A workspace in which the person may list widgets, with the account of theirs that may. */
export type PersonWidgetIndexWorkspace = WidgetIndexWorkspace & { accountId: number };

/** Why a widget index write was not sent: the account is not one of the person's own live ones. */
const WIDGET_INDEX_NOT_YOURS = "Your InferOps sign-in for this workspace has expired or was removed. Sign in again.";

/**
 * Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
 * Gateway billing flow is Cloudflare-specific, so several places key off this literal.
 */
export const CLOUDFLARE_VENDOR_ID = "cloudflare";

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

const withholdSecret = (secret: string) => secret === "" ? "" : null;

/** Withholds the non-empty secrets of `config`, for returning it to a client. */
function redactModelConfig(config: AiModelConfig): RedactedAiModelConfig {
  if (config.billing === 'chatgpt-plan') return config;
  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: withholdSecret(apiToken),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name, withholdSecret(value)]))}),
  };
}

/**
 * Fills in the `null` secrets of `config` from `source`, throwing if `source` is absent or doesn't
 * hold them. Secrets only carry over to the endpoint they were configured for: otherwise a client
 * could point the model at its own server and receive them.
 */
function resolveWithheldSecrets(
    config: RedactedAiModelConfig, source?: AiModelConfig): AiModelConfig {
  if (config.billing === 'chatgpt-plan') return config;
  let resolve = (secret: string | null, stored: string | undefined, what: string) => {
    if (secret !== null) return secret;
    if (!source) {
      throw new Error(`A value for ${what} is required.`);
    }
    if (source.provider !== config.provider || (source.apiUrl ?? "") !== (config.apiUrl ?? "")) {
      throw new Error(`Please re-enter ${what}, since the provider or API URL changed.`);
    }
    if (stored === undefined) {
      throw new Error(`There is no stored ${what} to keep.`);
    }
    return stored;
  };

  let storedHeader = (name: string) => source?.extraHeaders && Object.hasOwn(source.extraHeaders, name)
      ? source.extraHeaders[name] : undefined;

  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: resolve(apiToken, source?.apiToken, "the API token"),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) =>
            [name, resolve(value, storedHeader(name), `the value of header "${name}"`)]))}),
  };
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

// Blueprint record stored in the user's `blueprints` collection.
type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  // Source of truth for whether the blueprint is featured deployment-wide.
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

/**
 * One output of a workspace, as pushed into a user's output index by the Overseer that owns it
 * (see `syncWorkspaceOutputs()`). Carries only what the workspace itself knows: its title,
 * activity time and ownership are joined in from the `gadgets` collection on read, so they can't
 * go stale here.
 */
export type WorkspaceOutputEntry = {
  workpieceId: WorkpieceId;
  title: string;
  created: Date;

  /** The format the gadget was built as, if it was instantiated from a blueprint declaring one. */
  output?: BlueprintOutput;
};

type OutputRecord = WorkspaceOutputEntry & {
  // The workspace containing this output (an Overseer DO id).
  workspaceId: string;
};

// AI Gateway billing state for the optional top-up flow: which Cloudflare account to bill and a
// cached credit balance. The OAuth tokens themselves live in the connected Cloudflare *gatekeeper*
// account (vendorId "cloudflare"); billing reads a usable token from there via getUsableAccessToken.
type CloudflareBilling = {
  // Selected account, once chosen (auto-selected when the grant sees exactly one).
  accountId?: string;
  accountName?: string;
  // Cached credit balance (USD) and when it was last fetched (unix ms).
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      pendingHandoffs: collection<PendingHandoffRecord>()({
        primaryKey: "ticketHash",
      }),
      pendingConnectFlows: collection<PendingConnectFlow>()({
        primaryKey: "nonceHash",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
      // This person's publication records, the authoritative copy (see publication.ts).
      // AdminSettings mirrors each one after every change.
      publications: collection<StoredPublicationRecord>()({
        primaryKey: "id",
      }),
      // Outputs of every workspace in `gadgets`, mirrored here by each workspace's Overseer so the
      // Outputs page is one cheap read of the user's own DO. Entries are meaningful only while the
      // corresponding `gadgets` record exists; `syncWorkspaceOutputs()` and the `gadgets` deletion
      // paths keep the two in step.
      outputs: collection<OutputRecord>()({
        primaryKey: record => `${record.workspaceId}:${record.workpieceId}`,
        nonUniqueIndexes: {
          byWorkspace(record: OutputRecord) { return record.workspaceId; },
        },
      }),
      // Closed legacy ledger: existing binds may finish, but no new legacy admission.
      operateReadRuns: collection<{threadId: string; runId: string; chatId?: number}>()({
        primaryKey: "threadId",
        uniqueIndexes: {byRun: (record: {runId: string}) => record.runId},
      }),
      // Only the current generation needs detailed replay records; the boundary rejects all older IDs.
      operateReadGenerationRuns: collection<{threadId: string; runId: string; chatId?: number}>()({
        primaryKey: "threadId",
        uniqueIndexes: {byRun: (record: {runId: string}) => record.runId},
      }),
      // The operate session's event log (see OperateSession). Keyed by the zero-padded sequence
      // number so listing is in log order.
      operateEvents: collection<OperateEventRecord>()({
        primaryKey: record => operateEventKey(record.seq),
      }),
      // This person's running state of each console widget whose states persist per person
      // (FAC-86, widget-state.ts), keyed by widgetStateKey(). Apart from the operate page: nothing
      // here is read or written by dispatchOperateEvent(), nor this by it.
      widgetStates: collection<StoredWidgetState>()({ primaryKey: "key" }),
      // This person's widget placements on the Operate canvas (FAC-13, widget-placements.ts), for
      // the company in presentationCompany: references, layout and filters only. Dropped with the
      // rest of the presentation state when the company changes (#resetPresentationState).
      widgetPlacements: collection<WidgetPlacement>()({ primaryKey: "placementId" }),
      // The requested runs whose result moved this person's page (FAC-116, applyRunNavigation), by
      // invocation and attachment, so a run moves it at most once. Kept across a company change.
      runNavigations: collection<{ key: string; at: number }>()({ primaryKey: "key" }),
      // Operate session workspaces a company change retired (FAC-88, #resetPresentationState):
      // kept, never listed or opened again, for offboarding and retention to find; `revoked` once
      // the workspace itself has revoked what was held on it (#revokeRetiredWorkspaces).
      retiredOperateWorkspaces: collection<RetiredOperateWorkspace>()({ primaryKey: "id" }),
      // Subjects (boards) the person's page showed when a company change dropped it (FAC-88): the
      // person is taken out of each one's live presence (SubjectPresenceDurableObject.leaveAll)
      // before anything else is served, so its roster stops reaching them.
      retiredSubjectPresence: collection<{ boardRef: string; revoked: boolean }>()({ primaryKey: "boardRef" }),
    },
    singletons: {
      operateReadGeneration: "1",
      // AI Gateway billing state (selected account + cached balance) for the optional top-up flow;
      // null until a Cloudflare account is connected and resolved.
      cloudflareBilling: <CloudflareBilling | null>null,

      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      preferredModel: <string | null>null,
      chatGptFallbackModel: <string | null>null,
      onboardingCompleted: false,

      // Set once the user's pre-existing workspaces have been asked to populate the outputs index
      // (see #backfillOutputs()). Workspaces created since push on their own.
      outputsBackfilled: false,

      // How far that catch-up has got: the last workspace id examined. The sweep runs a page at a
      // time and resumes here on the next visit.
      outputsBackfillCursor: "",

      nextAccountId: 0,
      // The last epoch stamped on a connected account (see ConnectedAccountRecord.epoch).
      accountEpoch: 0,
      pinnedBlueprints: <string[]>[],

      // Per-user free-tier daily LLM-call counter (only used when ENABLE_CLOUDFLARE_LIMITS is on).
      // Stores the current UTC day and the calls made that day; a stale `day` implicitly resets the
      // count. Folds the former standalone RateLimitDO into the user object.
      dailyLlmCount: <{ day: string; count: number } | null>null,

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
      // ADR 0019 (FAC-165): the stable subject this account is bound to (`subjectAccountName`), or
      // null. Once set it never changes, and the account then signs in only through that subject.
      boundSubject: <string | null>null,
      // The address the subject's provider last vouched for, for display and finding them by
      // address; null when it vouched none. Never the account's key.
      vouchedEmail: <string | null>null,
      // Current profile revision, bumped every time the user updates their
      // public-facing profile. Currently this is only bumped when the user
      // changes their display name.
      profileRev: 0,
      // Profile revision the deployment-wide user directory last acknowledged
      // (-1 = never, which also lazily backfills users created before the
      // directory existed). See #syncDirectory().
      directoryRev: -1,

      // The owner-only workspace behind this person's operate session, once claimed. Never listed
      // by listGadgets().
      operateSessionWorkspaceId: <string | null>null,

      // The operate session's page as of its latest event, with that event. Always the replay of
      // `operateEvents` (applyOperateEvent), maintained by dispatchOperateEvent().
      operatePage: <OperateSessionUpdate>{ seq: 0, state: INITIAL_OPERATE_PAGE },

      // The company the operate page and widget states belong to (FAC-88; presentationCompanyOf),
      // or null before it was first recorded. #enterPresentationCompany() drops both when it changes.
      presentationCompany: <string | null>null,
      // Raised each time the company changes, so state held outside this object (an operate session
      // connection's session-persisted widget states) can tell it belongs to the former company.
      presentationEpoch: 0,
      // The seq of the latest companyChanged entry: entries before it are the former company's, kept
      // in `operateEvents` but never listed again (listOperateEvents, listOperateSubjectEvents).
      presentationFloorSeq: 0,
      // Raised by one with each change to widgetPlacements, which names it to change them again.
      widgetPlacementsRevision: 0,
    }
  });
}

/** An operate session workspace a company change retired (FAC-88; UserDurableObject storage). */
type RetiredOperateWorkspace = { id: string; retiredAt: number; revoked: boolean };

/** One person's stored state of one console widget (see UserDurableObject.readWidgetState). */
type StoredWidgetState = { key: string; state: string; seq: number; at: number };

/** Most applied run navigations one person keeps (FAC-116); the oldest is dropped past it. */
const MAX_RUN_NAVIGATIONS = 256;
/** How long a run navigation that found no open page waits for that session to reconnect (FAC-116). */
const RUN_NAVIGATION_PENDING_MS = 60_000;

/** Most console widget states one person keeps; the least recently changed is dropped past it. */
const MAX_STORED_WIDGET_STATES = 256;

// A widget state key as widgetStateKey() makes it: bounded, printable, with no path tricks.
function validWidgetStateKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 512 || [...key].some(c => c.charCodeAt(0) < 0x20)) {
    throw new TypeError("Invalid widget state key.");
  }
  return key;
}

function operateEventKey(seq: number): string {
  return String(seq).padStart(15, "0");
}

/** Most entries one OperateSession.listEvents() call returns. */
const MAX_OPERATE_EVENTS_PAGE = 200;

type UserStorage = ReturnType<typeof makeUserStorage>;

function unavailableGatekeeperVendorInfo(id: string): GatekeeperVendorInfo {
  return {
    id,
    unavailable: true,
    description: {
      displayName: id,
      url: "",
      tagline: "Temporarily unavailable",
      description: "This gatekeeper could not be loaded.",
    },
    supportedResources: [],
  };
}

async function checkGatekeeperVendorFilter(
    vendor: Service<GatekeeperVendor> | Service<GatekeeperUser>,
    vendorId: string,
    filter: GatekeeperVendorFilter): Promise<boolean> {
  try {
    if (filter.resourceUrl) {
      let resources = await vendor.getSupportedResources();
      let matched = false;
      for (let resource of resources) {
        if (typeof resource.urlPattern !== "string") {
          // Guard against gatekeepers returning a non-string urlPattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
        }

        if (new URLPattern(resource.urlPattern).test(filter.resourceUrl)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  } catch (err) {
    // This function is called when iterating over several gatekeepers to filter them. If one of
    // them throws we don't want to block the whole list, so instead log the error and assume this
    // gatekeeper should be filtered.
    logger.warn("gatekeeper filter check failed", {
      event: "gatekeeper.filter.check.failed", vendorId, error: err,
    });
    return false;
  }
}

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // Migrate data created prior to the minions -> gadgets rename.
    // TODO(cleanup): Eventually remove this, very few people ever used it as "minions".
    for (let [key, value] of Array.from(ctx.storage.kv.list({prefix: "minions:"}))) {
      let newKey = "gadgets:" + key.slice("minions:".length);
      ctx.storage.kv.put(newKey, value);
      ctx.storage.kv.delete(key);
    }

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.vendors = buildGatekeeperVendorMap(env);
  }

  // Mirrors the profile into the deployment-wide user directory. Best-effort
  // and does not block the caller. The `syncUser` call opens this DO's input
  // gate, so a rename can start a second sync while one is in flight, and the
  // two can reach the directory in either order. Each sync carries its
  // `profileRev` and the directory keeps the highest, so no ordering is needed
  // here. The revision counter only increases, and a failed sync leaves it
  // behind so the next authentication retries.
  #syncDirectory(): void {
    const rev = this.storage.profileRev.get();
    if (rev === this.storage.directoryRev.get()) return;
    const profile = this.storage.profile.get();
    this.ctx.exports.UserDirectoryDurableObject.getByName("")
        .syncUser({ id: profile.id, name: profile.name }, rev)
        .then(() => {
          if (rev > this.storage.directoryRev.get()) this.storage.directoryRev.put(rev);
        }, (error: unknown) => {
          logger.warn("failed to sync user directory record", {
            event: "user.directory.sync.failed",
            error,
          });
        });
  }

  async authenticate(token: string): Promise<void> {
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    this.#syncDirectory();
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    // A bound account signs in only through its subject (ADR 0019 decision 4).
    if (this.storage.boundSubject.get() !== null) throw new Error(SIGNS_IN_THROUGH_SUBJECT);
    const isNew = !this.storage.created.get();
    if (isNew) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    this.#syncDirectory();
    return isNew;
  }

  async #newSessionToken(): Promise<string> {
    let { secret, hash: tokenId } = await newSecretToken();
    this.storage.sessions.put({ tokenId, created: new Date() });
    return secret.toBase64();
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    // Do a little migration here for old data.
    // TODO(soon): Delete this.
    for (let gadget of Array.from(this.storage.gadgets.list())) {
      if (!gadget.created || !gadget.lastActive) {
        if (!gadget.created) {
          gadget.created = new Date("2026-01-01");
        }
        if (!gadget.lastActive) {
          gadget.lastActive = new Date("2026-01-01");;
        }
        this.storage.gadgets.put(gadget);
      }
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    // A bound account signs in only through its subject (ADR 0019 decision 4): an address that now
    // belongs to someone else reaches nothing here.
    if (this.storage.boundSubject.get() !== null) throw new Error(SIGNS_IN_THROUGH_SUBJECT);
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: this.ctx.id.toString(),
        source: "gatekeeper",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: this.ctx.id.toString(),
      source: "gatekeeper",
    });
    return this.#newSessionToken();
  }

  /**
   * Binds this email-keyed account to `subject` (ADR 0019 decision 3), set-if-unset with no await
   * between the check and the write: `bound` when it is (now, or already) bound to `subject`;
   * `bound-elsewhere` when another subject holds it; `password` for a password account, which never
   * binds; `absent` when there is no account here, which this writes nothing for. The caller has
   * already checked the provider vouches for the address this account is named by.
   */
  async bindSubject(subject: string): Promise<SubjectBinding> {
    if (!this.storage.created.get()) return "absent";
    if (this.storage.passwordHashHash.get() !== null) return "password";
    const bound = this.storage.boundSubject.get();
    if (bound === null) {
      this.storage.boundSubject.put(subject);
      return "bound";
    }
    return bound === subject ? "bound" : "bound-elsewhere";
  }

  /** Whether this account is bound to a subject (ADR 0019), and so found only through it. */
  async isSubjectBound(): Promise<boolean> {
    return this.storage.boundSubject.get() !== null;
  }

  /**
   * Signs in through `subject` (ADR 0019), creating the account on first use when `allowCreate`:
   * its profile id is `name`, the account name the directory resolved (the subject's own name, or
   * the address of the email-keyed account it bound), so a profile id still names its account. A
   * new account is bound to `subject` as it is made; an existing one must already be bound to it.
   * `email` is the address the provider vouches for now, or null; it is kept for display only.
   * Returns the session secret, or null when signups are closed and there is no account yet.
   */
  async loginOrCreateViaSubject(name: string, subject: string, email: string | null, allowCreate: boolean)
      : Promise<string | null> {
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.boundSubject.put(subject);
      this.storage.profile.put({ type: "user", name: email ? email.split("@")[0]! : "InferOps user", id: name });
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created", user_id: this.ctx.id.toString(), source: "gatekeeper",
      });
    } else if (this.storage.boundSubject.get() !== subject) {
      throw new Error(SUBJECT_MISMATCH);
    }
    this.storage.vouchedEmail.put(email);
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated", user_id: this.ctx.id.toString(), source: "gatekeeper",
    });
    return this.#newSessionToken();
  }

  /**
   * For the one-off subject pass (ADR 0019 decision 7): the subject this email-keyed account would
   * bind to, read from a connection of `vendorId` it holds, when that connection's vouched email is
   * the account's own address; its bound subject if it already has one; else null. Reads only: the
   * pass checks the directory, then binds with `bindSubject`.
   */
  async subjectFromConnections(vendorId: string): Promise<string | null> {
    if (!this.storage.created.get() || this.storage.passwordHashHash.get() !== null) return null;
    const already = this.storage.boundSubject.get();
    if (already !== null) return already;
    const address = this.storage.profile.get().id;
    if (!address.includes("@")) return null;
    for (let record of Array.from(this.storage.connectedAccounts.list())) {
      if (record.vendorId !== vendorId) continue;
      const account = record.account as unknown as Required<Pick<GatekeeperUser, "getAuthenticatedSubject" | "getAuthenticatedEmail">>;
      let email: string | null, subject: GatekeeperSubject | null;
      try {
        [email, subject] = await Promise.all([account.getAuthenticatedEmail(), account.getAuthenticatedSubject()]);
      } catch (error) {
        logger.warn("connected account could not name its subject", {
          event: "account.subject.read.failed", vendorId, accountId: record.id, error,
        });
        continue;
      }
      if (subject && email?.toLowerCase() === address.toLowerCase()) return subjectAccountName(subject);
    }
    return null;
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  /**
   * Called by the overseer every time a collaborator opens a shared gadget.
   * Creates the record on first open; updates lastActive on subsequent opens.
   *
   * `role` is cached so listings built from this DO can offer the actions it permits without
   * reopening the workspace to ask. Presentation only: every operation is still authorized by the
   * Overseer when attempted.
   */
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this workspace; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      record.role = role;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        created: now,
        lastActive: now,
      });
    }
  }

  /**
   * Updates the presentation-only role cached for a shared workspace listing. Authorization still
   * comes from the Overseer's live sharing graph; this only keeps the listing's available actions
   * accurate after a collaborator is downgraded.
   */
  async updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record?.owner) return;
    record.role = role;
    this.storage.gadgets.put(record);
  }

  /**
   * Forgets a gadget shared with this user: drops it from their workspace listing and its outputs
   * from their Outputs index. Called both when the user dismisses it and when their access is
   * revoked (Overseer.refreshAffectedCollaboratorListings()); it grants and revokes nothing.
   */
  async forgetSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
      this.storage.outputs.byWorkspace.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
    this.storage.profileRev.put(this.storage.profileRev.get() + 1);
    this.#syncDirectory();
  }

  async setOwnCommitEmail(email: string | null): Promise<void> {
    let profile = this.storage.profile.get();
    if (email === null) {
      delete profile.commitEmail;
    } else {
      validateCommitEmail(email);
      profile.commitEmail = email;
    }
    this.storage.profile.put(profile);
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    return this.#listModels(getAiGatewayConfig(this.env));
  }

  #listModels(gwConfig: AiGatewayConfig | null): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = localApiModels(this.env).map(model => model.profile);

    // When AI Gateway mode is active, include the suggested models offered on enabled providers.
    if (gwConfig) {
      result.push(...gwConfig.getModelList());
    }

    // Also include user-configured models, skipping any that a gateway model shadows, including
    // a hidden one (see #resolveModel()).
    for (let model of this.storage.aiModels.list()) {
      if (!gwConfig?.resolveModel(model.profile.id)) {
        result.push(model.profile);
      }
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig,
                 copySecretsFrom?: string): Promise<void> {
    await this.#validatePlanModel(config);
    let source: AiModelConfig | undefined;
    if (copySecretsFrom !== undefined) {
      source = this.#getHandAddedModel(copySecretsFrom).config;
    }
    // A gateway model, hidden or not, would shadow the new model and leave it unreachable.
    if (this.storage.aiModels.get(profile.id) ||
        getAiGatewayConfig(this.env)?.resolveModel(profile.id) || localApiModels(this.env).some(model => model.profile.id === profile.id)) {
      throw new Error(`A model with ID "${profile.id}" already exists.`);
    }
    this.#putModel(profile, resolveWithheldSecrets(config, source));
  }

  async getModelConfig(id: string): Promise<{profile: AiChatAuthorInfo, config: RedactedAiModelConfig}> {
    let {profile, config} = this.#getHandAddedModel(id);
    return {profile, config: redactModelConfig(config)};
  }

  async updateModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig): Promise<void> {
    await this.#validatePlanModel(config);
    let stored = this.#getHandAddedModel(profile.id).config;
    if (config.provider !== stored.provider || config.model !== stored.model ||
        (config.billing ?? 'api-key') !== (stored.billing ?? 'api-key')) {
      throw new Error("A model's provider and model ID can't be changed.");
    }
    this.#putModel(profile, resolveWithheldSecrets(config, stored));
  }

  /** The stored record of a model the user added, throwing for AI Gateway models. */
  #getHandAddedModel(id: string): UserAiModelRecord {
    let record = this.storage.aiModels.get(id);
    // A stored model sharing a gateway model's ID is shadowed by it (see listModels()).
    if (!record || getAiGatewayConfig(this.env)?.resolveModel(id)) {
      throw new Error(`No such hand-added model: ${id}`);
    }
    return record;
  }

  // Finish remote validation before reading model records, so a concurrent add/delete cannot
  // interleave between the existence check and the synchronous storage write.
  async #validatePlanModel(config: RedactedAiModelConfig): Promise<void> {
    if (config.billing === 'chatgpt-plan') {
      const models = await openAiCommand(this.env, this.storage.profile.get().id,
          { operation: 'models', accountId: config.registrationId }, modelsSchema);
      if (!models.some(model => model.slug === config.model)) {
        throw new Error('Choose a model available to this ChatGPT account.');
      }
      if (config.apiToken !== undefined || config.apiUrl !== undefined || config.extraHeaders !== undefined || config.accountId !== undefined) {
        throw new Error('ChatGPT plan models cannot contain API credentials or endpoint overrides.');
      }
    }
  }

  #putModel(profile: AiChatAuthorInfo, config: AiModelConfig) {
    let gwConfig = getAiGatewayConfig(this.env);
    if (config.billing !== 'chatgpt-plan' && gwConfig && !gwConfig.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }
    // A model with no billing runs on the platform gateway (getModelViaGateway) unless the person's
    // own funded gateway pays, which only the Cloudflare limits flow offers and only a turn can tell.
    // Without that flow it can only run on the platform's, so it must be one MODEL_ALLOWLIST offers,
    // and it's refused here rather than saved to fail. With it, it's saved, and the turn gate
    // (checkPlatformTurn) refuses it whenever the platform would pay.
    if (config.billing === undefined && gwConfig && !isCloudflareLimitsEnabled(this.env) &&
        !gwConfig.offersModel(config)) {
      throw new Error(modelNotOfferedMessage(config.model));
    }
    for (let limit of [config.contextWindow, config.outputLimit]) {
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
        throw new Error("Token limits must be positive integers.");
      }
    }

    profile.type = "agent";
    delete profile.managed;
    delete profile.fallbackForModelId;
    if (config.billing === 'chatgpt-plan') profile.billing = 'chatgpt-plan';
    else delete profile.billing;
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
    if (localApiModels(this.env).some(model => model.profile.id === id)) {
      throw new Error('This model is managed by the local API key configuration.');
    }
    // In AI Gateway mode, don't allow deleting built-in suggested models.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
        if (gwConfig.providers.has(provider) && id in models) {
          throw new Error(`Cannot delete built-in model "${models[id].name}".`);
        }
      }
    }

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.#resolveModel(result, getAiGatewayConfig(this.env))) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async getChatGptFallback(): Promise<{ modelId: string | null; models: AiChatAuthorInfo[] }> {
    const models = [...localApiModels(this.env), ...this.storage.aiModels.list()]
      .filter(model => model.config.billing !== 'chatgpt-plan' &&
        (model.config.apiToken || Object.keys(model.config.extraHeaders ?? {}).length > 0));
    const selected = this.storage.chatGptFallbackModel.get();
    return { modelId: models.some(model => model.profile.id === selected) ? selected : null,
      models: models.map(model => model.profile) };
  }

  async setChatGptFallback(modelId: string | null): Promise<void> {
    if (modelId !== null && !(await this.getChatGptFallback()).models.some(model => model.id === modelId)) {
      throw new Error('Choose an existing API-key model.');
    }
    this.storage.chatGptFallbackModel.put(modelId);
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Any model that resolves is accepted, hidden ones included (see getExternalMessageChatContext()).
      if (!this.#resolveModel(id, getAiGatewayConfig(this.env))) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Cloudflare account connection (optional top-up flow).
  // ---------------------------------------------------------------------------------------------

  /**
   * Return the connected Cloudflare *gatekeeper* account stub, if any. The AI Gateway billing flow
   * narrows it to CloudflareGatekeeperUser to obtain a usable access token. Null if the user hasn't
   * connected (or signed in with) Cloudflare.
   */
  async getCloudflareGatekeeperAccount(): Promise<Fetcher<CloudflareGatekeeperUser> | null> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try { rec = this.storage.connectedAccounts.get(id); } catch { continue; }
      if (rec && rec.vendorId === CLOUDFLARE_VENDOR_ID) {
        return rec.account as unknown as Fetcher<CloudflareGatekeeperUser>;
      }
    }
    return null;
  }

  /** The AI Gateway billing state (selected account + cached balance), or null if unset. */
  async getCloudflareBilling(): Promise<CloudflareBilling | null> {
    return this.storage.cloudflareBilling.get();
  }

  /** Update the cached credit balance for the billed account. */
  async updateCloudflareCredits(creditsRemaining: number | null): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.creditsRemaining = creditsRemaining;
    record.creditsUpdatedAt = Date.now();
    this.storage.cloudflareBilling.put(record);
  }

  /**
   * Persist which Cloudflare account to bill. Clears the cached credit balance (it belonged to the
   * old account).
   */
  async setCloudflareAccountSelection(accountId: string, accountName?: string): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.accountId = accountId;
    record.accountName = accountName;
    record.creditsRemaining = undefined;
    record.creditsUpdatedAt = undefined;
    this.storage.cloudflareBilling.put(record);
  }

  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  /** Read the current daily quota state without counting a call. */
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  /**
   * Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
   * pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
   * so a blocked request never counts.
   */
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. Pure read: call sites replay it across DO resets
   * via retryOnDoReset, so it must stay free of writes and side effects. */
  async getChatContext(modelId: string | null): Promise<UserChatContext> {
    return this.#getChatContext(modelId, getAiGatewayConfig(this.env));
  }

  async #getChatContext(modelId: string | null, gwConfig: AiGatewayConfig | null): Promise<UserChatContext> {
    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = this.#resolveModel(modelId, gwConfig);
      if (!result.aiModel) throw new Error(`No such model: ${modelId}`);
      const config = result.aiModel.config;
      const fallbackId = this.storage.chatGptFallbackModel.get();
      if (config.billing === 'chatgpt-plan' && fallbackId) {
        // Only an explicit disconnected state can change billing. Outages, quota and denied
        // permissions keep the plan route and its recovery behavior.
        const state = isOpenAiPluginEnabled(this.env)
          ? await openAiCommand(this.env, result.profile.id, { operation: 'state' }, stateSchema) : null;
        const account = state?.accounts.find(value => value.id === config.registrationId);
        if (!account || account.status === 'signed-out') {
          const fallback = localApiModels(this.env).find(model => model.profile.id === fallbackId)
            ?? this.storage.aiModels.get(fallbackId);
          if (!fallback || fallback.config.billing === 'chatgpt-plan') {
            throw new Error('The selected API-key fallback is unavailable. Choose another model in Settings.');
          }
          result.aiModel = { profile: { ...fallback.profile, fallbackForModelId: modelId },
            config: { ...fallback.config, billing: 'api-key' } };
        }
      }
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (gwConfig) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = gwConfig.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.#resolveModel(quickModelId, gwConfig);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }
    return result;
  }

  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    // An existing chat keeps its model while it still resolves, even once no longer offered. A new
    // conversation takes the user's preferred model only while it is still offered, as the web
    // composer does with its stored choice, and otherwise the first available model.
    let gwConfig = getAiGatewayConfig(this.env);
    let selectedModelId = existingChatModelId;
    if (selectedModelId === null || !this.#resolveModel(selectedModelId, gwConfig)) {
      let models = this.#listModels(gwConfig);
      let preferredModel = this.storage.preferredModel.get();
      selectedModelId = (models.find(model => model.id === preferredModel) ?? models[0])?.id ?? null;
    }

    return this.#getChatContext(selectedModelId, gwConfig);
  }

  /**
   * Resolve a model ID the way chats do: a gateway model, hidden ones included, shadows a stored
   * model with the same ID.
   */
  #resolveModel(id: string, gwConfig: AiGatewayConfig | null): UserAiModelRecord | undefined {
    return gwConfig?.resolveModel(id) ?? localApiModels(this.env).find(model => model.profile.id === id)
      ?? this.storage.aiModels.get(id);
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let result: GadgetMetadataWithTimestamps[] = [];
    let operateSessionWorkspaceId = this.storage.operateSessionWorkspaceId.get();
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget) && gadget.id !== operateSessionWorkspaceId) {
        result.push(gadget);
      }
    }
    return result;
  }

  // --- Operate session (see OperateSession in workshop-shared/api.ts) ---
  //
  // Each method runs synchronously against storage, so concurrent calls (two tabs, or a tab and the
  // agent) are serialized by the Durable Object and never interleave.

  /**
   * Returns the operate session's workspace id, registering `candidateId` (a fresh Overseer id the
   * caller has not opened yet) if there is none, or if the recorded one was deleted. An unused
   * candidate costs nothing.
   */
  async claimOperateSessionWorkspace(candidateId: string): Promise<string> {
    // A company change first retires the former company's workspace (FAC-88).
    await this.#enterPresentationCompany();
    let existing = this.storage.operateSessionWorkspaceId.get();
    if (existing && this.storage.gadgets.get(existing)) return existing;
    this.storage.gadgets.put({ id: candidateId, title: "Operate session", created: new Date() });
    this.storage.operateSessionWorkspaceId.put(candidateId);
    return candidateId;
  }

  /**
   * The operate session's workspace id as recorded, or null when there is none (never claimed, or
   * the recorded one was deleted). Read-only: a console workspace cross-checks the operate session
   * a console tool call names against it.
   */
  async operateSessionWorkspaceId(): Promise<string | null> {
    await this.#enterPresentationCompany();
    let existing = this.storage.operateSessionWorkspaceId.get();
    return existing && this.storage.gadgets.get(existing) ? existing : null;
  }

  // The stored page, with any field added to OperatePageState since it was stored filled in from
  // the initial page, so a session that predates a field reads as if it always had it. A subject
  // stored before it was derived from the board is re-derived the same way. A console opened
  // before consoles were published reads as the published one at no revision, so its next
  // navigation is refused as changed and the person reopens it at the published revision.
  #operatePage(): OperateSessionSnapshot {
    let { seq, state } = this.storage.operatePage.get();
    let filled = { ...INITIAL_OPERATE_PAGE, ...state };
    // Pre-publication runs lack both fields at runtime, whatever the type says.
    let console = filled.console && {
      ...filled.console,
      source: filled.console.source ?? "published", revision: filled.console.revision ?? "",
    };
    return { seq, state: { ...filled, console, subject: filled.board?.boardRef ?? null } };
  }

  /**
   * Reads which company the person works in now (presentationCompanyOf over their own connected
   * accounts). Tests replace it to stand in for those accounts. An instance field, so never
   * callable through a stub: no caller can name the company.
   */
  presentationCompanyReader = (): Promise<string> =>
    presentationCompanyOf(this.#connectedAccountRecords(), getSharedConfigurationGatekeeper(this.env));

  /**
   * Every read or write of the operate page, of a widget state or of the operate session workspace
   * comes through here first (FAC-88). When the person's company differs from the one their
   * presentation state belongs to, that state is dropped before anything reads it (see
   * #resetPresentationState). Switching back restores nothing. State from before any company was
   * recorded can't be shown to belong to the first one read, so it is dropped the same way; a
   * person with none just records the company. Refuses with `companyUnavailable` when the company
   * can't be told, rather than show state that may be another's.
   */
  async #enterPresentationCompany(): Promise<void> {
    for (;;) {
      let company: string;
      try {
        company = await this.presentationCompanyReader();
      } catch (err) {
        if (getOperateSessionErrorCode(err) === OPERATE_SESSION_ERROR_CODES.companyUnavailable) throw err;
        throw Object.assign(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.companyUnavailable), { cause: err });
      }
      // Synchronous from here: no other request interleaves between the comparison and the reset,
      // and, once nothing is left to revoke, the caller's own read or write follows with no await.
      let stored = this.storage.presentationCompany.get();
      if (stored !== company) {
        this.storage.presentationCompany.put(company);
        if (stored !== null || this.#holdsPresentationState()) this.#resetPresentationState();
      }
      let pending = [...this.storage.retiredOperateWorkspaces.list()].filter(retired => !retired.revoked);
      let presence = [...this.storage.retiredSubjectPresence.list()].filter(retired => !retired.revoked);
      if (pending.length === 0 && presence.length === 0) return;
      // A retired workspace's held capabilities and streams, and the former subject's presence,
      // are revoked before anything else is served, then the company is read again, since it may
      // have changed while that was awaited.
      await this.#revokeRetiredWorkspaces(pending);
      await this.#leaveRetiredSubjects(presence);
    }
  }

  // Takes the person out of each former subject's live presence (SubjectPresenceDurableObject
  // .leaveAll), ending every presence stream they hold on it, and records each that is done. One
  // that can't be reached refuses the person's call with `companyUnavailable`, and is tried again.
  async #leaveRetiredSubjects(pending: { boardRef: string; revoked: boolean }[]): Promise<void> {
    let userId = this.storage.profile.get().id;
    for (let retired of pending) {
      try {
        await this.ctx.exports.SubjectPresenceDurableObject.getByName(retired.boardRef).leaveAll(userId);
      } catch (err) {
        logger.warn("former subject's presence could not be left", {
          event: "operate.presence.leave.failed", error: err,
        });
        throw Object.assign(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.companyUnavailable), { cause: err });
      }
      this.storage.retiredSubjectPresence.delete(retired.boardRef);
    }
  }

  // Asks each retired operate session workspace to retire itself (Overseer.retireOperateSession),
  // which revokes every capability held on it, and records each that has. One that can't be told
  // refuses the person's call with `companyUnavailable`, and is asked again on the next.
  async #revokeRetiredWorkspaces(pending: RetiredOperateWorkspace[]): Promise<void> {
    let overseers = this.ctx.exports.OverseerDurableObject;
    let ownerId = this.ctx.id.toString();
    for (let retired of pending) {
      let id;
      try {
        id = overseers.idFromString(retired.id);
      } catch {
        // Not an object id, so no object exists to hold anything.
        this.storage.retiredOperateWorkspaces.put({ ...retired, revoked: true });
        continue;
      }
      try {
        if (!await overseers.get(id).retireOperateSession(ownerId)) {
          logger.warn("retired operate session workspace refused its retirement", {
            event: "operate.workspace.retire.refused", durableObjectId: retired.id,
          });
        }
      } catch (err) {
        logger.warn("retired operate session workspace could not be revoked", {
          event: "operate.workspace.retire.failed", durableObjectId: retired.id, error: err,
        });
        throw Object.assign(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.companyUnavailable), { cause: err });
      }
      let current = this.storage.retiredOperateWorkspaces.get(retired.id);
      if (current) this.storage.retiredOperateWorkspaces.put({ ...current, revoked: true });
    }
  }

  // Whether anything a company's presentation state is made of is stored: a page that has moved,
  // a widget state, or a claimed operate session workspace.
  #holdsPresentationState(): boolean {
    return this.storage.operatePage.get().seq > 0 ||
      [...this.storage.widgetStates.list({ limit: 1 })].length > 0 ||
      [...this.storage.widgetPlacements.list({ limit: 1 })].length > 0 ||
      this.storage.operateSessionWorkspaceId.get() !== null;
  }

  // Drops the presentation state of the company the person no longer works in, in one synchronous
  // step: every widget state is deleted; the page returns to its initial state through a
  // `companyChanged` entry, below which the log is never listed again; the epoch rises, so a
  // connection drops its session widget states; and the operate session workspace (the operate
  // chat, its history and its agent's context) is retired, so the next claim starts a fresh one.
  // A retired workspace is kept, never deleted: it is unlisted, and Overseer.open refuses it,
  // since it is no longer this person's recorded operate session.
  #resetPresentationState(): void {
    let formerBoard = this.#operatePage().state.board?.boardRef;
    if (formerBoard) this.storage.retiredSubjectPresence.put({ boardRef: formerBoard, revoked: false });
    // The keys first, so nothing is deleted while the listing is still being read.
    let widgetKeys = Array.from(this.storage.widgetStates.list(), widget => widget.key);
    for (let key of widgetKeys) this.storage.widgetStates.delete(key);
    // The former company's placements too (FAC-13); the revision rises, so a client holding them
    // is refused as a conflict and reads the (empty) placements again.
    let placementIds = Array.from(this.storage.widgetPlacements.list(), placement => placement.placementId);
    for (let placementId of placementIds) this.storage.widgetPlacements.delete(placementId);
    if (placementIds.length > 0) this.storage.widgetPlacementsRevision.put(this.storage.widgetPlacementsRevision.get() + 1);
    let record: OperateEventRecord = {
      seq: this.storage.operatePage.get().seq + 1, event: { type: "companyChanged" }, actor: "person", at: new Date(),
    };
    this.storage.operateEvents.put(record);
    this.storage.presentationFloorSeq.put(record.seq);
    this.storage.presentationEpoch.put(this.storage.presentationEpoch.get() + 1);
    this.storage.operatePage.put({ seq: record.seq, state: INITIAL_OPERATE_PAGE, record });
    let workspaceId = this.storage.operateSessionWorkspaceId.get();
    if (workspaceId !== null) {
      let workspace = this.storage.gadgets.get(workspaceId);
      if (workspace) {
        this.storage.retiredOperateWorkspaces.put({ id: workspaceId, retiredAt: Date.now(), revoked: false });
        this.storage.gadgets.delete(workspaceId);
      }
      this.storage.operateSessionWorkspaceId.put(null);
    }
  }

  /**
   * The company the person's presentation state belongs to now, after moving to it (see
   * #enterPresentationCompany): "" for a deployment with one partition. Only the kernel compares
   * it, as a handover does; it is never sent to a client.
   */
  async currentPresentationCompany(): Promise<string> {
    await this.#enterPresentationCompany();
    return this.storage.presentationCompany.get() ?? "";
  }

  /**
   * A number that rises each time the person's company changes, after moving to the current one
   * (see #enterPresentationCompany). Presentation state kept outside this object, such as an
   * operate session connection's session-persisted widget states, is the former company's once it
   * differs.
   */
  async presentationEpoch(): Promise<number> {
    await this.#enterPresentationCompany();
    return this.storage.presentationEpoch.get();
  }

  /** The session's current page. */
  async getOperatePage(): Promise<OperateSessionSnapshot> {
    await this.#enterPresentationCompany();
    return this.#operatePage();
  }

  #readGeneration(): bigint {
    const value = this.storage.operateReadGeneration.get();
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > MAX_READ_GENERATION ||
        [...this.storage.operateReadRuns.list({limit: 257})].length > 256) {
      throw new Error("READ_RUN_STORAGE_REFUSED");
    }
    return BigInt(value);
  }

  /** Prepare fresh selectors; rotate only a full generation, atomically with all row/index deletion. */
  async prepareOperateReadRun(): Promise<{threadId: string; runId: string}> {
    return this.storage.transaction(() => {
      let generation = this.#readGeneration();
      const rows = [...this.storage.operateReadGenerationRuns.list({limit: 257})];
      if (rows.length > 256) throw new Error("READ_RUN_STORAGE_REFUSED");
      if (rows.length === 256) {
        if (generation === MAX_READ_GENERATION) throw new Error("READ_RUN_STORAGE_REFUSED");
        ++generation;
        for (const row of rows) this.storage.operateReadGenerationRuns.delete(row.threadId);
      }
      this.storage.operateReadGeneration.put(generation.toString());
      return newReadRunSelectors(generation);
    });
  }

  /** Reserve before work. Deleting retired detail never re-enables its generation's identities. */
  async reserveOperateReadRun(threadId: string, runId: string): Promise<void> {
    const requested = parseReadRunSelectors(threadId, runId);
    this.storage.transaction(() => {
      const current = this.#readGeneration();
      if (requested < current) throw new Error("RUN_GENERATION_RETIRED");
      if (requested > current) throw new Error("RUN_GENERATION_INVALID");
      const runs = this.storage.operateReadGenerationRuns;
      if (runs.get(threadId) || runs.byRun.get(runId)) throw new Error("RUN_ALREADY_RESERVED");
      if ([...runs.list({limit: 256})].length >= 256) throw new Error("RUN_CAPACITY_EXHAUSTED");
      runs.put({threadId, runId});
    });
  }

  /** Bind only a reservation; retired late binds must neither resurrect rows nor fail created chats. */
  async bindOperateReadRun(threadId: string, chatId: number): Promise<void> {
    this.storage.transaction(() => {
      const legacy = isLegacyReadSelector(threadId);
      if (!legacy) {
        const requested = parseReadSelector(threadId, "t");
        const current = this.#readGeneration();
        if (requested < current) return;
        if (requested > current) throw new Error("RUN_GENERATION_INVALID");
      }
      const runs = legacy ? this.storage.operateReadRuns : this.storage.operateReadGenerationRuns;
      const record = runs.get(threadId);
      if (!record || record.chatId !== undefined) throw new Error("RUN_ALREADY_RESERVED");
      runs.put({...record, chatId});
    });
  }

  /**
   * This person's state of the console widget `key` names, following `machine` (its published
   * declaration, which the caller read through the person's own access): the stored state when the
   * machine still declares it, else its initial state. Reads nothing of the operate page.
   */
  async readWidgetState(key: string, machine: WidgetStateMachine): Promise<WidgetStateSnapshot> {
    await this.#enterPresentationCompany();
    return this.#widgetState(key, machine);
  }

  #widgetState(key: string, machine: WidgetStateMachine): WidgetStateSnapshot {
    let stored = this.storage.widgetStates.get(validWidgetStateKey(key));
    let state = recoverWidgetState(machine, stored?.state);
    return { state, seq: stored?.seq ?? 0, events: widgetEventsFrom(machine, state) };
  }

  /**
   * Moves this person's state of console widget `key` by `event`, if `expectedSeq` is current and
   * `machine` permits it; see OperateSession.transitionWidget(). It never touches the operate page:
   * a widget's state changes only itself (FAC-86 criterion 1).
   */
  async transitionWidgetState(key: string, machine: WidgetStateMachine, event: string,
                              expectedSeq: number): Promise<WidgetStateSnapshot> {
    await this.#enterPresentationCompany();
    // One synchronous read, check and write: no await, so no other request interleaves.
    let current = this.#widgetState(key, machine);
    if (expectedSeq !== current.seq) {
      throw new WidgetStateError(WIDGET_STATE_ERROR_CODES.conflict, "The widget's state changed. Read it again.");
    }
    let state = applyWidgetTransition(machine, current.state, event);
    let next: StoredWidgetState = { key, state, seq: current.seq + 1, at: Date.now() };
    this.storage.widgetStates.put(next);
    this.#pruneWidgetStates();
    return { state, seq: next.seq, events: widgetEventsFrom(machine, state) };
  }

  /**
   * This person's widget placements on the Operate canvas (FAC-13), for the company they work in
   * now, in canvas order, with the revision a change must name. References only: opening what a
   * placement shows is authorized on its own path, every time.
   */
  async listWidgetPlacements(): Promise<WidgetPlacements> {
    await this.#enterPresentationCompany();
    return this.#widgetPlacements();
  }

  #widgetPlacements(): WidgetPlacements {
    return { revision: this.storage.widgetPlacementsRevision.get(),
      placements: orderWidgetPlacements(this.storage.widgetPlacements.list()) };
  }

  /**
   * Saves one placement if `expectedRevision` is current: a new one (the kernel mints its id) when
   * `input` names none, else a change to that placement's layout and filters, which may not change
   * the widget it shows. Refused, changing nothing, with WIDGET_PLACEMENTS_CONFLICT,
   * WIDGET_PLACEMENT_NOT_FOUND, WIDGET_PLACEMENT_REF_CHANGED, WIDGET_PLACEMENTS_FULL or
   * WIDGET_PLACEMENT_INVALID.
   */
  async saveWidgetPlacement(input: WidgetPlacementInput, expectedRevision: number): Promise<WidgetPlacements> {
    let parsed = parseWidgetPlacementInput(input);
    await this.#enterPresentationCompany();
    // One synchronous check and write: no await, so no other change interleaves.
    this.#requirePlacementsRevision(expectedRevision);
    let placementId: string;
    if (parsed.placementId !== undefined) {
      let current = this.storage.widgetPlacements.get(parsed.placementId);
      if (!current) throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.notFound, "That placement is no longer on your canvas.");
      if (!sameWidgetPlacementRef(current.ref, parsed.ref)) {
        throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.refChanged, "A placement keeps the widget it shows; place the other one instead.");
      }
      placementId = parsed.placementId;
    } else {
      if ([...this.storage.widgetPlacements.list()].length >= WIDGET_PLACEMENT_LIMITS.placements) {
        throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.tooMany,
          `Your canvas holds at most ${WIDGET_PLACEMENT_LIMITS.placements} widgets; remove one first.`);
      }
      placementId = crypto.randomUUID();
    }
    this.storage.widgetPlacements.put({ placementId, ref: parsed.ref, layout: parsed.layout, filters: parsed.filters ?? {},
      updatedAt: Date.now() });
    this.storage.widgetPlacementsRevision.put(expectedRevision + 1);
    return this.#widgetPlacements();
  }

  /**
   * Removes one placement if `expectedRevision` is current, with the widget states kept for it
   * (see widgetStateKey). Refused with WIDGET_PLACEMENTS_CONFLICT or WIDGET_PLACEMENT_NOT_FOUND.
   */
  async removeWidgetPlacement(placementId: string, expectedRevision: number): Promise<WidgetPlacements> {
    if (typeof placementId !== "string") throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.invalid, "Name the placement.");
    await this.#enterPresentationCompany();
    this.#requirePlacementsRevision(expectedRevision);
    if (!this.storage.widgetPlacements.get(placementId)) {
      throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.notFound, "That placement is no longer on your canvas.");
    }
    this.storage.widgetPlacements.delete(placementId);
    let stateKeys = Array.from(this.storage.widgetStates.list(), state => state.key)
      .filter(key => widgetStateKeyPlacement(key) === placementId);
    for (let key of stateKeys) this.storage.widgetStates.delete(key);
    this.storage.widgetPlacementsRevision.put(expectedRevision + 1);
    return this.#widgetPlacements();
  }

  #requirePlacementsRevision(expectedRevision: number): void {
    if (expectedRevision !== this.storage.widgetPlacementsRevision.get()) {
      throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.conflict, "Your canvas changed. Read it again.");
    }
  }

  // Keeps the newest MAX_STORED_WIDGET_STATES; an older widget then starts again at its initial state.
  #pruneWidgetStates(): void {
    let all = [...this.storage.widgetStates.list()];
    if (all.length <= MAX_STORED_WIDGET_STATES) return;
    for (let old of all.toSorted((a, b) => a.at - b.at).slice(0, all.length - MAX_STORED_WIDGET_STATES)) {
      this.storage.widgetStates.delete(old.key);
    }
  }

  /**
   * Appends an operate event if `expectedSeq` is current; see OperateSession.dispatch(). A null
   * `expectedSeq` applies it to whatever page is current: the operate agent acts on the latest page
   * rather than on one it watched.
   */
  async dispatchOperateEvent(event: OperateEvent, expectedSeq: number | null,
                             actor: OperateEventActor): Promise<OperateSessionSnapshot> {
    // An agent has no authority to start a flow. Every path an event takes, the person's checked
    // one (OperateSessionImpl.dispatch) and the operate agent's (Overseer.operatePage), arrives
    // here, so none can record an agent's start. Granting agents one would replace this refusal
    // with the person path's check of the flow against an authoritative definition.
    if (actor === "agent" && event.type === "startFlow") {
      throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
    // Nor to move between a flow's named pages (FAC-87): only the person path re-checks each
    // destination page against what the caller may open (OperateSessionImpl.#checkFlowNavigation),
    // so an agent's navigation is refused here until it gets that check too.
    if (actor === "agent" &&
        (event.type === "navigateFlow" || event.type === "backFlow" || event.type === "setFlowPageState")) {
      throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
    // Only the kernel resets a page for a company change (#enterPresentationCompany), and only
    // receiveHandover() records a received handover, after checking its company; whoever asks.
    if (event.type === "companyChanged" || event.type === "handoverReceived") {
      throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
    // A write lands only on the current company's page: a client holding the former company's
    // page writes at a seq that is no longer current, and is refused as a conflict.
    await this.#enterPresentationCompany();
    return this.#appendOperateEvent(event, expectedSeq, actor);
  }

  /**
   * Records a handover from a person who works in `senderCompany` (FAC-88; the sender's
   * currentPresentationCompany, which OperateSessionImpl.handOver reads). This person's own company
   * is resolved first, then compared and the handover appended in one synchronous step, so a switch
   * between the sender's check and the append can't land it in another company's page: on a
   * mismatch it is refused with `recipientUnavailable` and nothing is appended. A company that can't
   * be told refuses with `companyUnavailable`, which the sender sees as `recipientUnavailable`.
   */
  async receiveHandover(handover: OperateHandover, senderCompany: string): Promise<OperateSessionSnapshot> {
    await this.#enterPresentationCompany();
    if ((this.storage.presentationCompany.get() ?? "") !== senderCompany) {
      throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.recipientUnavailable);
    }
    return this.#appendOperateEvent({ type: "handoverReceived", handover }, null, "person");
  }

  // Applies and appends one event, synchronously: the seq check, the reducer, the log entry and the
  // page snapshot happen with no await, so nothing interleaves with them or with the caller's
  // checks just before.
  #appendOperateEvent(event: OperateEvent, expectedSeq: number | null,
                      actor: OperateEventActor): OperateSessionSnapshot {
    let current = this.#operatePage();
    if (expectedSeq !== null && expectedSeq !== current.seq) {
      throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.conflict);
    }
    let state;
    try {
      state = applyOperateEvent(current.state, event);
    } catch (err) {
      if (err instanceof OperateEventError) {
        throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.invalidEvent);
      }
      throw err;
    }
    let record: OperateEventRecord = { seq: current.seq + 1, event, actor, at: new Date() };
    let subject = operateEventSubject(event, current.state, state);
    if (subject !== null) record.subject = subject;
    this.storage.operateEvents.put(record);
    this.storage.operatePage.put({ seq: record.seq, state, record });
    return { seq: record.seq, state };
  }

  /**
   * Moves this person's open page as a requested run's settled result asks (FAC-116), after its
   * workspace checked the run, the person and the page. Applied only to a page that's open (a live
   * subscribeOperateSession()), still at `pageSeq`, showing that published console and revision
   * with no flow running, and only once per invocation and attachment; recorded with the actor
   * `workflow-run`. A page that isn't open keeps the request only in memory, for
   * `RUN_NAVIGATION_PENDING_MS`, and a reconnect of the same session in that time applies it once
   * its workspace re-checks the requester, under the same checks; once this object restarts, or the
   * page moved, it never applies.
   */
  async applyRunNavigation(request: RunNavigationRequest): Promise<RunNavigationOutcome> {
    await this.#enterPresentationCompany();
    return this.#applyRunNavigation(request, true);
  }

  // The run navigations waiting for their page to reconnect, by marker key (see applyRunNavigation).
  #pendingRunNavigations = new Map<string, { request: RunNavigationRequest; at: number }>();

  #applyPendingRunNavigations(): void {
    let now = Date.now();
    for (let [key, { request, at }] of this.#pendingRunNavigations) {
      this.#pendingRunNavigations.delete(key);
      if (now - at < RUN_NAVIGATION_PENDING_MS) void this.#recheckRunNavigation(request);
    }
  }

  // A waiting move applies only once the run's workspace re-checks it, now: the requester still
  // may run the trigger and still holds a role there (OverseerImpl.recheckRunNavigation). Then the
  // same checks as a live one, against the page as it is after that answer.
  async #recheckRunNavigation(request: RunNavigationRequest): Promise<void> {
    try {
      let overseers = this.ctx.exports.OverseerDurableObject;
      let workspace = overseers.get(overseers.idFromString(request.workspaceId));
      if (await workspace.recheckRunNavigation(request.profileId, request.invocationId)) this.#applyRunNavigation(request, false);
    } catch (error) {
      logger.warn("a run's waiting navigation could not be re-checked", { event: "operate.run_navigation.recheck_failed", error });
    }
  }

  // Checks and applies one run navigation in one synchronous step (see applyRunNavigation).
  #applyRunNavigation(request: RunNavigationRequest, keep: boolean): RunNavigationOutcome {
    let key = `${request.invocationId}\n${request.attachmentId}`;
    if (this.storage.runNavigations.get(key)) return "already";
    if (request.move.type !== "showScreen" && request.move.type !== "openView") return "refused";
    if (this.#operateSubscribers.size === 0) {
      if (keep) {
        this.#pendingRunNavigations.set(key, { request, at: Date.now() });
        // Bounded: a person rarely has more than a few runs settling while their page is closed.
        while (this.#pendingRunNavigations.size > 16) this.#pendingRunNavigations.delete(this.#pendingRunNavigations.keys().next().value!);
      }
      return "not-open";
    }
    let page = this.#operatePage();
    let run = page.state.console;
    if (page.seq !== request.pageSeq || page.state.flow || run?.source !== "published" ||
        run.workspaceId !== request.workspaceId || run.consoleId !== request.consoleId || run.revision !== request.revision) {
      return "refused";
    }
    try {
      this.#appendOperateEvent(request.move, request.pageSeq, "workflow-run");
    } catch {
      return "refused";
    }
    this.storage.runNavigations.put({ key, at: Date.now() });
    let applied = [...this.storage.runNavigations.list()];
    if (applied.length > MAX_RUN_NAVIGATIONS) {
      for (let old of applied.toSorted((a, b) => a.at - b.at).slice(0, applied.length - MAX_RUN_NAVIGATIONS)) {
        this.storage.runNavigations.delete(old.key);
      }
    }
    return "shown";
  }

  // The live subscribeOperateSession() subscribers, which noticeConsoleRevision() also reaches.
  #operateSubscribers = new Set<{ update(update: OperateSessionUpdate): void }>();

  /**
   * Called by a console's workspace when it publishes or deletes console `consoleId`: if the page
   * has that console open at a revision older than `revision`, or `revision` is null (deleted),
   * every subscriber is sent the unchanged snapshot with `consoleRevision` set (see
   * OperateSessionUpdate). Nothing is logged or stored, and nothing else is sent.
   *
   * Revisions are decimal strings that only rise, compared as numbers: two publishes fan out
   * independently, so an earlier one's notice may arrive after the session reopened at the later
   * revision, and must not supersede it. (A run from before revisions were recorded has "", read
   * as 0.)
   */
  async noticeConsoleRevision(workspaceId: string, consoleId: string, revision: string | null): Promise<void> {
    let current = this.#operatePage();
    let run = current.state.console;
    if (run?.workspaceId !== workspaceId || run.consoleId !== consoleId) return;
    if (revision !== null && BigInt(run.revision || "0") >= BigInt(revision)) return;
    for (let subscriber of this.#operateSubscribers) {
      subscriber.update({ ...current, consoleRevision: { workspaceId, consoleId, revision } });
    }
  }

  /** See OperateSession.subscribe(). */
  async subscribeOperateSession(subscriber: RpcStub<(update: OperateSessionUpdate) => void>)
      : Promise<RpcStub<{}>> {
    await this.#enterPresentationCompany();
    subscriber = subscriber.dup();  // keep stub after return
    let page = this.storage.operatePage;
    let disposed = false;
    let pageSubscriber = {
      update(update: OperateSessionUpdate) {
        subscriber(update).catch(unsubscribe);
      }
    };
    let unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      page.unsubscribe(pageSubscriber);
      this.#operateSubscribers.delete(pageSubscriber);
      subscriber[Symbol.dispose]();
    };

    // Snapshot and subscribe with no await between, so no event can fall in the gap.
    subscriber(this.#operatePage()).catch(unsubscribe);
    page.subscribe(pageSubscriber);
    this.#operateSubscribers.add(pageSubscriber);
    // A run's navigation that found the page closed moments ago applies now, if nothing moved it.
    this.#applyPendingRunNavigations();

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    });
  }

  /** See OperateSession.listEvents(). */
  async listOperateEvents(afterSeq: number, limit: number): Promise<OperateEventRecord[]> {
    await this.#enterPresentationCompany();
    let count = Math.max(0, Math.min(Math.floor(limit), MAX_OPERATE_EVENTS_PAGE));
    if (count === 0) return [];
    // Never below the current company's first entry (presentationFloorSeq).
    let floor = this.storage.presentationFloorSeq.get();
    return [...this.storage.operateEvents.list({
      startAfter: operateEventKey(Math.max(0, Math.floor(afterSeq), floor - 1)),
      limit: count,
    })];
  }

  /**
   * One page of the per-subject audit's session half (see OperateSession.listSubjectAudit): the
   * events recorded about `subject` among the up to 200 entries before `beforeSeq` (or the newest
   * when null), newest first, and the seq to continue below, or null at the start of the log. A
   * page may hold no matches while older entries remain.
   */
  async listOperateSubjectEvents(subject: string, beforeSeq: number | null)
      : Promise<{ events: OperateEventRecord[]; nextBeforeSeq: number | null }> {
    await this.#enterPresentationCompany();
    // Never below the current company's first entry (presentationFloorSeq).
    let floor = this.storage.presentationFloorSeq.get();
    let scanned = [...this.storage.operateEvents.list({
      start: operateEventKey(floor),
      end: beforeSeq === null ? undefined : operateEventKey(Math.max(0, Math.floor(beforeSeq))),
      reverse: true,
      limit: MAX_OPERATE_EVENTS_PAGE + 1,
    })];
    let more = scanned.length > MAX_OPERATE_EVENTS_PAGE;
    if (more) scanned.pop();
    return {
      events: scanned.filter(record => record.subject === subject),
      nextBeforeSeq: more ? scanned.at(-1)!.seq : null,
    };
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
  }

  async updateKind(gadgetId: string, kind: WorkspaceKind) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.kind = kind;
    this.storage.gadgets.put(record);
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
  }

  async ensureGadgetRegistered(id: string, title: string): Promise<void> {
    if (this.storage.gadgets.get(id)) return;
    await this.newGadget(id, title);
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
    this.storage.outputs.byWorkspace.delete(id);
  }

  /**
   * Replace the set of outputs recorded for one workspace. Called by that workspace's Overseer
   * whenever its gadget registry changes and whenever it is opened.
   *
   * A workspace the user no longer tracks (deleted, or a shared one they dismissed) has its
   * entries dropped.
   */
  syncWorkspaceOutputs(workspaceId: string, entries: WorkspaceOutputEntry[]): void {
    this.storage.outputs.byWorkspace.delete(workspaceId);
    if (!this.storage.gadgets.get(workspaceId)) return;
    for (let entry of entries) {
      this.storage.outputs.put({...entry, workspaceId});
    }
  }

  async listOutputs(): Promise<ListOutputsResult> {
    let catchingUp = await this.#backfillOutputs();
    return {outputs: this.#readOutputs(), catchingUp};
  }

  // Ask the user's pre-existing workspaces to populate the outputs index, once. Workspaces push as
  // they change and when opened, so only those predating the index need this.
  //
  // Sweeps one bounded page and reports whether more remains, rather than sweeping everything: a
  // first Outputs load must not wait on every workspace the user has ever created. The caller
  // drains the rest, so the list fills in while the page is open.
  async #backfillOutputs(): Promise<boolean> {
    if (this.storage.outputsBackfilled.get()) return false;

    let startAfter = this.storage.outputsBackfillCursor.get() || undefined;
    let cursor = startAfter ?? "";
    let targets: string[] = [];
    let examined = 0;
    for (let gadget of this.storage.gadgets.list({startAfter, limit: OUTPUTS_BACKFILL_PAGE})) {
      ++examined;
      cursor = gadget.id;
      // A shared workspace is mirrored on open, not swept; a half-created one has nothing yet.
      if (!gadget.owner && isFullyCreated(gadget)) targets.push(gadget.id);
    }
    let done = examined < OUTPUTS_BACKFILL_PAGE;

    let ownerId = this.ctx.id.toString();
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(targets.map(id =>
        overseers.get(overseers.idFromString(id)).getOutputsForOwnerBackfill(ownerId)));

    let failureCount = 0;
    let firstError: unknown;
    for (let [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (result.value) this.syncWorkspaceOutputs(targets[index], result.value);
      } else {
        if (failureCount === 0) firstError = result.reason;
        ++failureCount;
      }
    }

    if (failureCount > 0) {
      logger.warn("failed to backfill outputs for some workspaces", {
        event: "outputs.backfill.partial",
        failureCount,
        error: firstError,
      });
    }

    // Advance past workspaces that failed, rather than retrying them. The index is self-healing,
    // so one missed here reappears the moment it is touched, whereas holding the cursor lets a
    // single unwakeable workspace stall the sweep forever.
    if (done) {
      this.storage.outputsBackfilled.put(true);
    } else {
      this.storage.outputsBackfillCursor.put(cursor);
    }

    // A page where everything failed looks systemic, so stop draining and let the next visit pick
    // up from the next page: draining on would be a burst of doomed calls during an outage.
    if (failureCount > 0 && failureCount === targets.length) return false;
    return !done;
  }

  #readOutputs(): OutputSummary[] {
    let result: OutputSummary[] = [];
    for (let output of this.storage.outputs.list()) {
      let workspace = this.storage.gadgets.get(output.workspaceId);
      if (!workspace || !isFullyCreated(workspace)) continue;
      result.push({
        workspaceId: output.workspaceId,
        workpieceId: output.workpieceId,
        ...(output.output ? {output: output.output} : {}),
        title: output.title,
        workspaceTitle: workspace.title,
        created: output.created,
        lastActive: workspace.lastActive,
        ...(workspace.owner ? {owner: workspace.owner} : {}),
        ...(workspace.role ? {role: workspace.role} : {}),
      });
    }
    result.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return result;
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    if (existing) {
      existing.metadata = kvRecord.metadata;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.ownerId !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      for (let v = 1; v <= kvRecord.metadata.version; v++) {
        await this.env.BLUEPRINT_CONTENT.delete(blueprintVersionKeys(id, v));
      }
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.libraryBlueprints.list()) {
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }

  // --- Publication records (see publication.ts). This DO holds the authoritative copy. ---

  /**
   * Append a requested record pinning the current version of one of this person's published
   * blueprints. Asking again for the same version and destination while a request or approval
   * stands returns that record rather than another one.
   */
  async requestPublication(blueprintId: string, destination: PublicationDestination)
      : Promise<PublicationRecord> {
    let kvRecord = this.storage.blueprints.get(blueprintId)
        ? await readBlueprintKvRecord(this.env, blueprintId) : null;
    if (!kvRecord) throw new Error("No such blueprint.");
    let version = kvRecord.metadata.version;
    let content = await readBlueprintContent(this.env, blueprintId, version);
    if (!content) throw new Error(`Blueprint version ${version} not found.`);
    assertPublicationFlagOn(this.env, content.kind);

    let record = [...this.storage.publications.list()].find(existing =>
        existing.artifact.blueprintId === blueprintId && existing.artifact.version === version &&
        existing.destination === destination && !existing.withdrawnAt);
    if (!record) {
      let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content.code));
      record = {
        id: crypto.randomUUID(),
        artifact: {
          blueprintId, version, digest: `sha256:${digest.toHex()}`, kind: content.kind,
          title: kvRecord.metadata.title,
        },
        destination,
        audience: PUBLICATION_AUDIENCES[destination],
        publishedBy: this.storage.profile.get().id,
        requestedAt: new Date(),
      };
      this.storage.publications.put(record);
    }
    await this.adminSettings.getByName("").mirrorPublication(record);
    return this.#withStatus(record);
  }

  async listPublications(): Promise<PublicationRecord[]> {
    let { offSeenAt } = await readPublicationSnapshot(this.env);
    return [...this.storage.publications.list()].toSorted(byRequestedDesc)
        .map(record => withPublicationStatus(record, this.env, offSeenAt));
  }

  /** The owner withdraws a record or cancels a request. Idempotent, so a retry re-mirrors. */
  async withdrawOwnPublication(recordId: string, reason: string): Promise<PublicationRecord> {
    let record = this.storage.publications.get(recordId);
    if (!record) throw createPublicationError(PUBLICATION_ERROR_CODES.recordNotFound);
    assertPublicationFlagOn(this.env, record.artifact.kind);
    record = this.decidePublication(recordId,
        { type: "withdraw", by: this.storage.profile.get().id, reason });
    await this.adminSettings.getByName("").mirrorPublication(record);
    return this.#withStatus(record);
  }

  /**
   * Write one decision onto a record. Called by AdminSettings, which checks the flag, the
   * approver and the artifact first and mirrors the result; each field is written only once.
   */
  decidePublication(recordId: string, decision:
      | { type: "approve" | "confirm"; by: string; selfApproved: boolean }
      | { type: "withdraw"; by: string; reason: string }): StoredPublicationRecord {
    let record = this.storage.publications.get(recordId);
    if (!record) throw createPublicationError(PUBLICATION_ERROR_CODES.recordNotFound);
    if (record.withdrawnAt) {
      if (decision.type === "withdraw") return record;
      throw createPublicationError(PUBLICATION_ERROR_CODES.invalidState);
    }
    let at = new Date();
    if (decision.type === "withdraw") {
      record = { ...record, withdrawnBy: decision.by, withdrawnAt: at, reason: decision.reason };
    } else {
      let self = decision.selfApproved ? { selfApproved: true as const } : {};
      if (decision.type === "approve") {
        if (record.at) throw createPublicationError(PUBLICATION_ERROR_CODES.invalidState);
        record = { ...record, approvedBy: decision.by, ...self, at };
      } else {
        if (!record.at) throw createPublicationError(PUBLICATION_ERROR_CODES.invalidState);
        record = { ...record, confirmations: [...record.confirmations ?? [], { by: decision.by, at, ...self }] };
      }
    }
    this.storage.publications.put(record);
    return record;
  }

  async #withStatus(record: StoredPublicationRecord): Promise<PublicationRecord> {
    return withPublicationStatus(record, this.env, (await readPublicationSnapshot(this.env)).offSeenAt);
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<GatekeeperVendorInfo[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    // Admin-disabled resources/gatekeepers are filtered out here, which also covers the agent (the
    // Overseer's connectable-vendor/resource list is sourced from this method).
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<GatekeeperVendorInfo | null>[] = [];

    for (let [id, vendor] of this.vendors) {
      if (disabledGatekeeperSet.has(id)) {
        continue;  // Whole gatekeeper disabled by admin.
      }
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, id, filter))) {
          return null;
        }

        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources(options),
          ]);
          let enabledResources =
              filterEnabledResources(config, id, supportedResources);
          if (enabledResources.length == 0) {
            // Every resource for this vendor is disabled (or it advertised none) — hide the vendor.
            return null;
          }

          return {id, description, supportedResources: enabledResources};
        } catch (err) {
          logger.warn("failed to load gatekeeper vendor", {
            event: "gatekeeper.vendor.load.failed", vendorId: id, error: err,
          });
          return unavailableGatekeeperVendorInfo(id);
        }
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<ConnectFlowStart> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(vendorId.toLowerCase())) {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback, {resourceUrlPatterns});
    let nonce = await this.openConnectFlow(accountId);
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return { url, nonce };
  }

  // Iterate every connected-account record, skipping any that fails to load. A record can fail to
  // deserialize when its account stub points at a gatekeeper Worker that's no longer bound in this
  // deployment (workerd throws "Stub refers to a service that doesn't exist"). Skipping it keeps one
  // stale account from breaking listing, provisioning, and opt-in for all the others — the same
  // resilience subscribeConnectedAccounts relies on (it iterates through this).
  *#connectedAccountRecords(): Generator<ConnectedAccountRecord> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try {
        rec = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account: failed to load", {
          event: "connected.account.load.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (rec) yield rec;
    }
  }

  // Whether this user already has a connected account for the given vendor.
  #hasAccountForVendor(vendorId: string): boolean {
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.vendorId === vendorId) return true;
    }
    return false;
  }

  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
      try {
        let description = await vendor.describe();
        return description.autoProvisionsAccount ? {vendorId, vendor, description} : null;
      } catch (err) {
        logger.warn("failed to describe vendor", {
          event: "vendor.describe.failed", vendorId, error: err,
        });
        return null;
      }
    }));
    return described.filter(v => v !== null);
  }

  /**
   * The ambient gatekeepers the user can opt into now: mode "optional" and not yet added. Backs the
   * Connectors "Available" section. ("enabled" ones are already provisioned; "disabled" ones aren't
   * offered.)
   */
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    let config = await readAdminConfig(this.env);
    return (await this.#ambientVendors())
        .filter(({vendorId}) =>
            ambientGatekeeperMode(config, vendorId) === "optional" && !this.#hasAccountForVendor(vendorId))
        // Same shape as listGatekeeperVendors; ambient gatekeepers expose no resources.
        .map(({vendorId, description}) => ({id: vendorId, description, supportedResources: []}));
  }

  // Per-vendor dedup of concurrent provisionAmbientAccount() calls — same DO-input-gate race as
  // #ensureAccountsPromise (see its comment below), e.g. a double-click on "Add". Cleared on completion.
  #provisionPromises = new Map<string, Promise<void>>();

  /**
   * Opt into an ambient gatekeeper on demand: mint its connected account for this user (no OAuth).
   * Only when the vendor's mode isn't "disabled" and the user has no account yet. Idempotent.
   */
  provisionAmbientAccount(vendorId: string): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let inFlight = this.#provisionPromises.get(vendorId);
    if (inFlight) return inFlight;
    let promise = this.#provisionAmbientAccount(vendorId)
        .finally(() => { this.#provisionPromises.delete(vendorId); });
    this.#provisionPromises.set(vendorId, promise);
    return promise;
  }

  async #provisionAmbientAccount(vendorId: string): Promise<void> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error("No such service: " + vendorId);

    if (ambientGatekeeperMode(await readAdminConfig(this.env), vendorId) === "disabled") {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let description = await vendor.describe();
    if (!description.autoProvisionsAccount) {
      throw new Error(`The "${vendorId}" gatekeeper can't be added this way.`);
    }

    if (this.#hasAccountForVendor(vendorId)) return;  // already added

    await this.#createAutoProvisionedAccount(vendorId, vendor);
  }

  // Mint a vendor's connected account with no OAuth flow and persist it as auto-provisioned. The
  // caller must have already confirmed the vendor sets autoProvisionsAccount (so createAccount is
  // present) and that the user has no account for it yet.
  async #createAutoProvisionedAccount(vendorId: string, vendor: Service<GatekeeperVendor>): Promise<void> {
    let account = await (vendor as unknown as AccountCreatorStub).createAccount();
    // Resolve the description before allocating the id, so a describe() failure doesn't burn a slot.
    let description = await account.describe();
    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);
    putAccount(this.storage, {
      id: accountId,
      account,
      description,
      vendorId,
      autoProvisioned: true,
    }, "replaced");
  }

  // Dedup concurrent #ensureAutoProvisionedAccounts() calls. The provisioning loop awaits cross-worker
  // RPCs (describe/createAccount), which releases the DO input gate; without this, two overlapping
  // calls (e.g. the nav listing apps while a gadget opens) could both see "not provisioned" and
  // create duplicate accounts. Cleared on completion so a later call re-checks (e.g. for a gatekeeper
  // bound after this DO started).
  #ensureAccountsPromise?: Promise<void>;

  // Ensure an auto-provisioned connected account exists for every bound vendor that requests it
  // (VendorDescription.autoProvisionsAccount) and is permitted by the provisioning policy. Idempotent
  // and best-effort: a single failing vendor never blocks the others. Creates at most one account per
  // vendor. Deduped via #ensureAccountsPromise (above); callers reach it through listProvidedAccounts.
  #ensureAutoProvisionedAccounts(): Promise<void> {
    return (this.#ensureAccountsPromise ??=
      this.#provisionMissingAccounts().finally(() => { this.#ensureAccountsPromise = undefined; }));
  }

  async #provisionMissingAccounts(): Promise<void> {
    // Which vendors already have an auto-provisioned account?
    let provisioned = new Set<string>();
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.autoProvisioned) provisioned.add(rec.vendorId);
    }

    let config = await readAdminConfig(this.env);
    for (let {vendorId, vendor} of await this.#ambientVendors()) {
      if (provisioned.has(vendorId)) continue;
      // Only "enabled" (forced) vendors are auto-provisioned for everyone. "optional" vendors are
      // added on demand by the user (provisionAmbientAccount); "disabled" ones never.
      if (!shouldAutoProvisionAccount(config, vendorId)) continue;

      try {
        await this.#createAutoProvisionedAccount(vendorId, vendor);
      } catch (err) {
        logger.error("failed to auto-provision account", {
          event: "account.auto.provision.failed", vendorId, error: err,
        });
      }
    }
  }

  /**
   * Ensure the user's auto-provisioned accounts exist (idempotent; see #ensureAutoProvisionedAccounts),
   * then list those that declare an agent singleton and/or a management UI. Folding the ensure in lets
   * callers (gadget open, app nav) provision and read the accounts back in a single round trip to this
   * DO. Callers filter on `description.singleton` (ambient capsules / catalog) or
   * `description.providesUi` (management-UI listing).
   */
  async listProvidedAccounts(): Promise<ProvidedAccountInfo[]> {
    await this.#ensureAutoProvisionedAccounts();
    let config = await readAdminConfig(this.env);
    let result: ProvidedAccountInfo[] = [];
    for (let rec of this.#connectedAccountRecords()) {
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      // A "disabled" ambient gatekeeper's account stays dormant: don't surface its singleton capsule
      // or management UI. (Its data is preserved, so re-enabling restores it.)
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      result.push({ accountId: rec.id, vendorId: rec.vendorId, description: rec.description });
    }
    return result;
  }

  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   */
  async getSingletonGatekeeperClass(accountId: number)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    return (record.account as unknown as SingletonAccountStub).getSingletonGatekeeperClass();
  }

  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is supplied
   * fresh by the caller so admin-gated features reflect the user's current status.
   */
  async startAccountAppUi(accountId: number, context: AppUiContext): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    return (record.account as unknown as SingletonAccountStub).startAppUi(context);
  }

  /**
   * Whether this person may `build` or `publish` shared configuration, as the deployment's
   * SHARED_CONFIGURATION_GATEKEEPER vendor decides it through their own connected accounts (the
   * module-level `holdsSharedConfiguration`). True when the deployment names no vendor.
   */
  async holdsSharedConfiguration(action: SharedConfigurationAction): Promise<boolean> {
    let vendorId = getSharedConfigurationGatekeeper(this.env);
    if (!vendorId) return true;
    return holdsSharedConfiguration(this.#connectedAccountRecords(), vendorId, action);
  }

  /**
   * Whether this person may ask a configured system workflow to run (FAC-102), as the deployment's
   * SHARED_CONFIGURATION_GATEKEEPER vendor decides it through their own connected accounts (the
   * module-level `workflowInvokeAnswer`), about the resource `resourceUrl` only, and the InferOps
   * company that answer was given in (FAC-111), which an admitted run records as its scope. The
   * Overseer asks only when the deployment names a vendor, once per connection the workflow acts
   * through; with none named there is nothing to ask, a yes with no company.
   */
  async workflowInvokeAnswer(resourceUrl: string): Promise<{ holds: boolean; company: string | null }> {
    let vendorId = getSharedConfigurationGatekeeper(this.env);
    if (!vendorId) return { holds: true, company: null };
    if (typeof resourceUrl !== "string" || !resourceUrl) return { holds: false, company: null };
    return workflowInvokeAnswer(this.#connectedAccountRecords(), vendorId, resourceUrl);
  }

  /**
   * The workspaces in which this person may list a console's widgets for their company (FAC-11),
   * as the deployment's SHARED_CONFIGURATION_GATEKEEPER vendor answers through each of their own
   * connected accounts with live credentials, each workspace once, with the first account that
   * may. Empty when the deployment names no vendor. Throws when an account can't answer, so a
   * publication reports that rather than choosing without it.
   */
  async widgetIndexWorkspaces(): Promise<PersonWidgetIndexWorkspace[]> {
    let vendorId = getSharedConfigurationGatekeeper(this.env);
    if (!vendorId) return [];
    let found = new Map<string, PersonWidgetIndexWorkspace>();
    for (let record of this.#connectedAccountRecords()) {
      if (record.vendorId !== vendorId || !areCredentialsValid(record)) continue;
      let workspaces = await (record.account as unknown as WidgetIndexAccountStub).widgetIndexWorkspaces();
      for (let workspace of workspaces) {
        if (!found.has(workspace.workspaceId)) found.set(workspace.workspaceId, { ...workspace, accountId: record.id });
      }
    }
    return [...found.values()];
  }

  /**
   * The widgets this person may use that match `query` (FAC-13), as the deployment's
   * SHARED_CONFIGURATION_GATEKEEPER vendor answers through each of their own connected accounts
   * with live credentials, merged (mergeWidgetSearches). `unavailable` when nothing could be asked:
   * no vendor (`not-configured`), no account of it (`not-connected`), only accounts whose sign-in
   * must be renewed (`reconnect`), or every account answering so itself. An account to reconnect
   * or one that failed beside one that answered counts as `unsearched`. Throws when every account
   * asked failed, so a failure never reads as "nothing found".
   */
  async searchWidgets(query: string, k: number): Promise<WidgetSearchAnswer> {
    let vendorId = getSharedConfigurationGatekeeper(this.env);
    if (!vendorId) return { status: "unavailable", reason: "not-configured" };
    let accounts = [...this.#connectedAccountRecords()].filter(record => record.vendorId === vendorId);
    if (accounts.length === 0) return { status: "unavailable", reason: "not-connected" };
    let found: Extract<WidgetSearchAnswer, { status: "searched" }>[] = [];
    let unavailable: WidgetSearchUnavailableReason[] = [];
    let failed: unknown;
    let failures = 0;
    for (let record of accounts) {
      if (!areCredentialsValid(record)) { unavailable.push("reconnect"); continue; }
      try {
        let answer = await (record.account as unknown as WidgetSearchAccountStub).searchWidgets(query, k);
        if (answer.status === "searched") found.push(answer);
        else unavailable.push(answer.reason);
      } catch (error) {
        failed = error;
        failures++;
      }
    }
    if (found.length === 0) {
      if (failed !== undefined) throw failed;
      // The most actionable reason first: renewing a sign-in, then the service's own.
      return { status: "unavailable", reason: unavailable.includes("reconnect") ? "reconnect" : unavailable[0]! };
    }
    return mergeWidgetSearches(found, k, { denied: 0, unsearched: failures + unavailable.length });
  }

  /**
   * Lists one widget version in `workspaceId` through this person's own account `accountId` of
   * the SHARED_CONFIGURATION_GATEKEEPER vendor, answering as the service did. Refused, and never
   * sent, for an account that isn't theirs, isn't that vendor's or has no live credentials.
   */
  async registerWidget(accountId: number, workspaceId: string, entry: WidgetIndexEntry): Promise<WidgetIndexOutcome> {
    let account = this.#widgetIndexAccount(accountId);
    if (!account) return { status: "refused", reason: WIDGET_INDEX_NOT_YOURS };
    return account.registerWidget(workspaceId, entry);
  }

  /** Removes one widget version's listing, as `registerWidget` writes it. */
  async withdrawWidget(accountId: number, workspaceId: string, sourceId: string, sourceVersion: number)
      : Promise<WidgetIndexOutcome> {
    let account = this.#widgetIndexAccount(accountId);
    if (!account) return { status: "refused", reason: WIDGET_INDEX_NOT_YOURS };
    return account.withdrawWidget(workspaceId, sourceId, sourceVersion);
  }

  #widgetIndexAccount(accountId: number): WidgetIndexAccountStub | null {
    let vendorId = getSharedConfigurationGatekeeper(this.env);
    let record = this.storage.connectedAccounts.get(accountId);
    if (!vendorId || !record || record.vendorId !== vendorId || !areCredentialsValid(record)) return null;
    return record.account as unknown as WidgetIndexAccountStub;
  }

  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[])
      : Promise<ConnectFlowStart | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.ensureResources(resourceUrlPatterns);
    if (url === undefined) return null;
    return { url, nonce: await this.openConnectFlow(accountId) };
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    if (filter?.includeForcedAutoProvisionedAccounts) await this.#ensureAutoProvisionedAccounts();

    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    // Snapshot the admin config once for this subscription. Changes take effect when the client
    // re-subscribes (e.g. on reconnect), matching other deployment config.
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    async function notifyAdd(record: ConnectedAccountRecord) {
      // Ambient (auto-provisioned) accounts only appear in the Connectors list when their vendor is
      // "optional" — i.e. the user opted in and can manage/remove it. "enabled" (forced) accounts have
      // nothing to manage, and "disabled" ones are dormant, so both are hidden.
      // Forced accounts are included when observer verification explicitly requests them.
      if (record.autoProvisioned) {
        let mode = ambientGatekeeperMode(config, record.vendorId);
        if (mode === "disabled" ||
            (mode === "enabled" && !filter?.includeForcedAutoProvisionedAccounts)) {
          return;
        }
      }
      if (disabledGatekeeperSet.has(record.vendorId)) {
        return;  // Whole gatekeeper disabled by admin.
      }
      if (filter && !(await checkGatekeeperVendorFilter(
          record.account, record.vendorId, filter))) {
        return;
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        logger.error("no such service for connected account", {
          event: "connected.account.service.missing",
          accountId: record.id, vendorId: record.vendorId,
        });
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        logger.warn("failed to describe connected account", {
          event: "connected.account.describe.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
        return;
      }

      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = await record.account.getSupportedResources();
        supportedResources =
            filterEnabledResources(config, record.vendorId, supportedResources);
      } catch (err) {
        logger.warn("failed to get supported resources for connected account", {
          event: "connected.account.supported.resources.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // #connectedAccountRecords() skips any record that fails to load, so a single stale account
    // (e.g. one whose gatekeeper Worker is no longer bound) doesn't prevent surfacing the others.
    let promises = [...this.#connectedAccountRecords()].map(record => notifyAdd(record));

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }

  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      if (account.autoProvisioned) {
        // A forced ("enabled") ambient account can't be removed by the user — the admin controls it.
        if (shouldAutoProvisionAccount(await readAdminConfig(this.env), account.vendorId)) {
          throw new Error("This account is provided automatically and can't be disconnected.");
        }
        // An opt-in ("optional") ambient account: the user added it, so let them remove it. revoke()
        // gives the gatekeeper a chance to delete its own per-user storage (e.g. the account's
        // private collections DO) — it's its cleanup hook, not just OAuth revocation. Best-effort:
        // a gatekeeper that throws (or has nothing to revoke) must not block the user's disconnect.
        try {
          await account.account.revoke();
        } catch (err) {
          logger.error("revoke() failed during disconnect", {
            event: "account.revoke.failed",
            vendorId: account.vendorId, accountId, error: err,
          });
        }
        this.storage.connectedAccounts.delete(accountId);
        logger.info("account disconnected", {
          event: "account.disconnected",
          vendorId: account.vendorId, accountId, autoProvisioned: true,
        });
        return;
      }
      await account.account.revoke();
      this.storage.connectedAccounts.delete(accountId);
      // Disconnecting the Cloudflare account also clears the AI Gateway billing state (selected
      // account + cached balance), which is meaningless without the underlying grant.
      if (account.vendorId === CLOUDFLARE_VENDOR_ID) {
        this.storage.cloudflareBilling.put(null);
      }
      logger.info("account disconnected", {
        event: "account.disconnected",
        vendorId: account.vendorId, accountId, autoProvisioned: false,
      });
    }
  }

  async reconnectAccount(accountId: number): Promise<ConnectFlowStart> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    let { url } = await record.account.reconnect();
    return { url, nonce: await this.openConnectFlow(accountId) };
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  /**
   * Persist a connected gatekeeper account that was established during sign-in (rather than via the
   * usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
   * links the account for AI Gateway billing: the login callback resolves this user by verified
   * email, then calls here to store the resulting grant. That grant covers billing only: sign-in
   * requests no gadget-facing resources, so any later resource access is authorized separately.
   * Returns the id of the connected account the grant now backs, so the login callback — which the
   * gatekeeper keeps for that account's lifetime — can find it again.
   */
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<number> {
    let description = await account.describe();
    let uniqueName = description.uniqueName;

    // A repeated sign-in is a re-authorization, so the *fresh* grant is the one we want. If this
    // identity is already connected for this vendor, refresh that record in place rather than letting
    // putConnectedAccount's dedup discard the new grant: keeping the stale record would leave billing
    // broken whenever the old token had expired or was rotated out by this very re-auth — the
    // opposite of what signing in again should accomplish.
    if (uniqueName) {
      let existing = this.#findConnectedAccountByIdentity(vendorId, uniqueName);
      if (existing) {
        // Drop the now-stale grant (a separate gatekeeper-side object from the fresh one), then point
        // the existing record — keeping its id, so UI references stay stable — at the fresh grant.
        try {
          await existing.account.revoke();
        } catch (err) {
          logger.error("failed to revoke stale grant; replacing anyway", {
            event: "account.stale.grant.revoke.failed",
            accountId: existing.id, vendorId, error: err,
          });
        }
        existing.account = account;
        existing.description = description;
        existing.credentialExpiresAt = expiresAt;
        existing.credentialsExpired = false;
        // A same-id replacement: a fresh incarnation, so nothing minted from the old grant matches.
        putAccount(this.storage, existing, "replaced");
        return existing.id;
      }
    }

    let id = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(id + 1);
    putAccount(this.storage, {
      id,
      account,
      description,
      vendorId,
      credentialExpiresAt: expiresAt,
    }, "replaced");
    return id;
  }

  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load, for the same reasons as subscribeConnectedAccounts():
  // a single corrupt record (e.g. one referencing a Worker binding that no longer exists) must not
  // poison the scan and prevent the user from connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      if (id === excludeId) continue;
      let existing: ConnectedAccountRecord | undefined;
      try {
        existing = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account during identity lookup: failed to load", {
          event: "connected.account.identity.lookup.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (!existing) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    putAccount(this.storage, record, "replaced");
  }

  /**
   * The provenance of connected account `accountId` now, or null when it no longer exists. For the
   * host-board kernel path, which compares it after every await: a changed incarnation is another
   * account under the same id, and a changed epoch is a mutation since the last check.
   */
  async hostBoardAccount(accountId: number): Promise<HostBoardAccount | null> {
    return accountProvenance(this.storage, accountId);
  }

  /**
   * `getGatekeeperClassFor` (the one chokepoint), together with the provenance of the account the
   * class was minted from. Throws if the account was replaced or removed while the class was being
   * resolved, since the class could then belong to the replacement.
   */
  async resolveHostBoardClass(accountId: number, url: string)
      : Promise<Awaited<ReturnType<UserDurableObject["getGatekeeperClassFor"]>> & {account: HostBoardAccount}> {
    let before = accountProvenance(this.storage, accountId);
    let resolved = await this.getGatekeeperClassFor(accountId, url);
    let after = accountProvenance(this.storage, accountId);
    if (!before || !after || before.incarnation !== after.incarnation) {
      throw new Error("This account changed while its connection was being made. Please try again.");
    }
    return {...resolved, account: after};
  }

  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      putAccount(this.storage, record, "mutated");
    }
  }

  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    putAccount(this.storage, record, "mutated");
    let restored = accountProvenance(this.storage, accountId);

    // Re-fetch the description since the user may have re-authed with different info. Best-effort:
    // the credentials are live either way, and a record still showing as expired over a failed
    // describe() would send the user back through a reconnect that changes nothing.
    try {
      let description = await record.account.describe();
      // Only the description, and only onto the record as restored: an expiry, a replacement or a
      // disconnect that landed during describe() stands, and its provenance is never rolled back.
      let current = this.storage.connectedAccounts.get(accountId);
      let now = accountProvenance(this.storage, accountId);
      if (current && now && restored && now.incarnation === restored.incarnation && now.epoch === restored.epoch) {
        this.storage.connectedAccounts.put({ ...current, description });
      }
    } catch (err) {
      logger.warn("failed to refresh the description of a restored account", {
        event: "account.describe.refresh.failed", vendorId: record.vendorId, accountId, error: err,
      });
    }
  }

  // --- Connect handoff (see connect-handoff.ts) ---

  /**
   * Start a connect / reconnect / ensure-resources flow for `accountId`: mints the nonce the Workshop
   * tab gives the popup (see ConnectFlowStart) and keeps its hash, so completeConnectHandoff can
   * check that the ticket the flow produces came back through that popup.
   */
  async openConnectFlow(accountId: number): Promise<string> {
    let { secret, hash: nonceHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + CONNECT_FLOW_LIFETIME_MS);
    this.storage.pendingConnectFlows.put({ nonceHash, accountId, expiresAt });
    await this.#armHandoffSweep();
    return secret.toHex();
  }

  // Store a finished-but-unconfirmed flow and hand back the ticket its page must present, together
  // with the flow's nonce, over the initiating user's session. Only the ticket's hash is kept, and
  // only in this user's DO, so the ticket is redeemable by nobody else (completeConnectHandoff looks
  // it up in the caller's own DO).
  async #stagePendingHandoff(
      record: Omit<PendingHandoffRecord, "ticketHash" | "expiresAt">): Promise<ConnectHandoff> {
    let targetOrigin = handoffTargetOrigin(this.env);
    let { secret, hash: ticketHash } = await newSecretToken();
    let expiresAt = new Date(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    this.storage.pendingHandoffs.put({ ...record, ticketHash, expiresAt });
    await this.#armHandoffSweep();
    return { targetOrigin, ticket: secret.toHex() };
  }

  /** A gatekeeper finished a connect flow for a reserved account id; stage it until confirmed. */
  async stagePendingConnect(accountId: number, account: Fetcher<GatekeeperUser>, vendorId: string,
                            credentialExpiresAt?: Date): Promise<ConnectHandoff> {
    let description = await account.describe();
    return this.#stagePendingHandoff({
      kind: "connect", accountId, credentialExpiresAt, connect: { account, description, vendorId },
    });
  }

  /**
   * A gatekeeper finished a reconnect/ensureResources flow; its credentials stay staged there under
   * `stageId`, which commitReconnect() names so the ticket activates exactly those credentials.
   */
  stagePendingRestore(accountId: number, stageId: string, credentialExpiresAt?: Date)
      : Promise<ConnectHandoff> {
    return this.#stagePendingHandoff({ kind: "restore", accountId, stageId, credentialExpiresAt });
  }

  /**
   * Redeem a finished flow's handoff. Called by the Workshop's own /connect/handoff page in the popup
   * over the popup's session; `nonce` proves the popup is the one this user's tab opened for that
   * flow. The ticket's record is deleted before anything else, so a ticket is single-use however the
   * rest goes (DO input gates serialize the read and delete) and a wrong nonce still spends it; the
   * nonce's flow is deleted too, so a nonce cannot be retried against another ticket. A staged
   * connect the redemption cannot activate is dropped like an unredeemed one, so no grant is left
   * reachable in a gatekeeper with nothing to revoke it.
   */
  async completeConnectHandoff(ticket: string, nonce: string): Promise<void> {
    let [ticketHash, nonceHash] =
        await Promise.all([hashPresentedSecret(ticket), hashPresentedSecret(nonce)]);
    let record: PendingHandoffRecord | undefined;
    if (ticketHash !== undefined) {
      record = this.storage.pendingHandoffs.get(ticketHash);
      if (record) this.storage.pendingHandoffs.delete(ticketHash);
    }
    let flow: PendingConnectFlow | undefined;
    if (nonceHash !== undefined) {
      flow = this.storage.pendingConnectFlows.get(nonceHash);
      if (flow) this.storage.pendingConnectFlows.delete(nonceHash);
    }
    let now = Date.now();
    if (!record || record.expiresAt.getTime() <= now ||
        !flow || flow.expiresAt.getTime() <= now || flow.accountId !== record.accountId) {
      if (record) await this.#dropPendingConnect(record);
      throw new Error("This connection attempt has expired. Please try again.");
    }

    if (record.kind === "connect") {
      if (!record.connect) throw new Error("Corrupt pending connection.");
      try {
        await this.putConnectedAccount({
          id: record.accountId, ...record.connect, credentialExpiresAt: record.credentialExpiresAt,
        });
      } catch (err) {
        await this.#dropPendingConnect(record);
        throw err;
      }
      logger.info("account connected", {
        event: "account.connect.completed", vendorId: record.connect.vendorId,
        accountId: record.accountId,
      });
    } else {
      let account = this.storage.connectedAccounts.get(record.accountId);
      if (!account) throw new Error("No such account.");
      if (record.stageId === undefined) throw new Error("Corrupt pending reconnect.");
      // A failed commit changed nothing live, and the gatekeeper's stage expires on its own.
      await account.account.commitReconnect(record.stageId);
      await this.markCredentialsRestored(record.accountId, record.credentialExpiresAt);
      logger.info("account credentials restored", {
        event: "account.reconnect.completed", vendorId: account.vendorId,
        accountId: record.accountId,
      });
    }
  }

  // Drop a pending handoff that will never activate. A staged connect holds a victim's (or just an
  // abandoned) grant in a reachable gatekeeper DO, so it is revoked, best-effort. A staged restore
  // left nothing live: the gatekeeper's staged credentials stop being committable on their own
  // (commitStagedCredentials refuses an expired stage), though they stay stored until the next
  // reconnect overwrites them; deleting them from here is a follow-up.
  async #dropPendingConnect(pending: PendingHandoffRecord): Promise<void> {
    if (pending.kind === "connect" && pending.connect) {
      try {
        await pending.connect.account.revoke();
      } catch (err) {
        logger.warn("failed to revoke unconfirmed connection", {
          event: "connect.handoff.revoke.failed", vendorId: pending.connect.vendorId,
          accountId: pending.accountId, error: err,
        });
      }
    }
    logger.info("unconfirmed connection dropped", {
      event: "connect.handoff.expired", handoffKind: pending.kind, accountId: pending.accountId,
    });
  }

  // Arm the alarm for the soonest pending expiry (the alarm is used for nothing else).
  async #armHandoffSweep(): Promise<void> {
    let next: number | undefined;
    let consider = (at: number) => { if (next === undefined || at < next) next = at; };
    for (let flow of this.storage.pendingConnectFlows.list()) consider(flow.expiresAt.getTime());
    try {
      for (let pending of this.storage.pendingHandoffs.list()) consider(pending.expiresAt.getTime());
    } catch (err) {
      // A record whose stub no longer deserializes (its Worker was unbound) fails the listing, and
      // without a keys-only listing it cannot be deleted either. Staging a new connect must not
      // depend on listing old ones, so arm a retry instead: one warning per lifetime for this user
      // until the Worker is bound again, while the grant the record holds is reachable by nobody.
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.arm.failed", error: err,
      });
      consider(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
    }
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Drop pending handoffs whose ticket never came back (see #dropPendingConnect) and flows whose
   * nonce was never presented (nothing to revoke for those).
   */
  async alarm(): Promise<void> {
    let now = Date.now();
    let expiredFlows = Array.from(this.storage.pendingConnectFlows.list())
        .filter(flow => flow.expiresAt.getTime() <= now);
    for (let flow of expiredFlows) this.storage.pendingConnectFlows.delete(flow.nonceHash);
    let expired: PendingHandoffRecord[] = [];
    try {
      for (let pending of this.storage.pendingHandoffs.list()) {
        if (pending.expiresAt.getTime() <= now) expired.push(pending);
      }
    } catch (err) {
      // Same failure mode as #connectedAccountRecords: a stub for a Worker that is no longer bound
      // fails to deserialize. Leave the sweep for next time (#armHandoffSweep bounds the retry).
      logger.warn("failed to list pending handoffs", {
        event: "connect.handoff.sweep.failed", error: err,
      });
    }
    for (let pending of expired) {
      this.storage.pendingHandoffs.delete(pending.ticketHash);
      await this.#dropPendingConnect(pending);
    }
    await this.#armHandoffSweep();
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string, mock: boolean}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource, mock} = await account.account.getGatekeeperClassFor(url);

    // Block whole gatekeepers + disabled resources at this single core-side chokepoint where a
    // resourceUrl becomes a capability (reached only via the user/UI-facing Overseer.newGatekeeper
    // and blueprint instantiation — never from gadget or agent code). An ambient gatekeeper an admin
    // set to "disabled" is blocked here too.
    let config = await readAdminConfig(this.env);
    let vendorId = account.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId) ||
        ambientGatekeeperMode(config, vendorId) === "disabled") {
      throw new Error(
          `The "${account.vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }

    // Blocking here prevents minting a new capability to a disabled resource even if the request
    // bypasses the (separately filtered) picker/agent listings.
    if (isResourceDisabled(config, vendorId, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }

    // `mock` is the account's own statement that the URL names demonstration data; installs into a
    // workspace that is not test-only refuse it (see Overseer.installBlueprint).
    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern,
            mock: mock === true};
  }

  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it. Returns null if the
   * account no longer exists (or never existed). Throws if the account belongs to a different
   * vendor (not a legitimate UI state — only reachable by bypassing client-side filtering).
   *
   * Account *selection* (which of the user's accounts to use for a given binding) is done by the
   * frontend; this method validates and resolves a chosen account to its verifier.
   */
  async getVerifier(accountId: number, expectedVendorId: string)
      : Promise<Fetcher<GatekeeperUserVerifier> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) return null;
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }

  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account ? account.description : null;
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<ConnectHandoff> {
    let {accountId, vendorId} = this.ctx.props;
    return this.#getUserStub().stagePendingConnect(accountId, account, vendorId, expiresAt);
  }

  reconnectComplete(stageId: string, expiresAt?: Date): Promise<ConnectHandoff> {
    return this.#getUserStub().stagePendingRestore(this.ctx.props.accountId, stageId, expiresAt);
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}

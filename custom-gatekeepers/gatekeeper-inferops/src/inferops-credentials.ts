// A connected person's InferLab session, held for their InferOps gatekeeper account.
//
// - `InferOpsCredentials` is one Durable Object per connected account (`idFromName(accountId)`). It
//   stores the grant a PKCE connect produced -- access token, refresh token -- together with the
//   identity InferLab reported (email, tenant, InferOps workspaces) and the Workshop's callback.
// - Storage, refresh and expiry go through gatekeeper-kit's `CredentialCoordinator`: a refresh is
//   `POST /auth/refresh {refreshToken}` at InferLab, which rotates both tokens; a 401 there is the
//   session's death, which is recorded, announced to the Workshop once, and refused ever after
//   until a reconnect replaces it. Revoking the account signs the session out (`POST /auth/logout`).
// - What leaves this object is an `InferOpsAuthority` (the access token and one workspace id): the
//   refresh token never crosses the RPC boundary. The workspace is always one the person is a
//   member of; a binding in another workspace is refused here, before any request is made.
//
// Nothing here logs a token, a header or a body.

import { DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  CredentialCoordinator, CredentialsExpiredError, type CredentialsWithIdentity,
  type RejectionVerdict,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  commitStagedCredentials, discardStagedCredentials, stageCredentials,
} from "@gadgets/gatekeeper-kit/credential-stage";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { createLogger } from "@gadgets/observability/logger";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import type { InferOpsAuthority } from "./http-inferops";

const VENDOR_ID = "inferops";
type LogFields = { vendorId: string; status: number };
const logger = createLogger<LogFields>({
  component: "gatekeeper.inferops.credentials", vendorId: VENDOR_ID,
});

const SESSION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CALLBACK_KEY = "callback";
const IDENTITY_KEY = "identity";
const WORKSPACE_KEY = "selectedWorkspace";

/** The tokens one InferLab session issued. Stored whole; only the access token is served. */
export type InferOpsGrant = {
  accessToken: string;
  /** When the access token expires (epoch ms, from its `exp` claim), or 0 when it says nothing. */
  accessExpiresAt: number;
  refreshToken: string;
};

/** One InferOps workspace the person belongs to, as InferLab reported it at connect time. */
export type InferOpsWorkspace = { workspaceId: string; workspaceName: string };

/** Who connected, as InferLab reported it. `email` is kept for display and sign-in only. */
export type InferOpsIdentity = {
  userId: string;
  email: string;
  tenantId: string;
  /** The person's InferOps workspaces (product `inferops`), in InferLab's order. */
  workspaces: InferOpsWorkspace[];
};

/** A grant and the identity it came with, as one connect or reconnect produced them. */
export type InferOpsConnection = { grant: InferOpsGrant; identity: InferOpsIdentity };

/** What InferLab's session endpoints need. */
export type InferLabSessionEnv = { INFERLAB_AUTH_ORIGIN?: string };

/** A refresh that failed for a reason other than the session's death. */
class RefreshFailed extends Error {}

/** The `exp` claim of a JWT, as epoch ms, or 0 when the token carries none. Nothing is verified. */
export function accessTokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** The access token and rotated refresh token of a `/auth/refresh` response body, or throws. */
export function grantFromRefreshResponse(body: string): InferOpsGrant {
  let parsed: { token?: unknown; refreshToken?: unknown } | null;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RefreshFailed("InferLab returned an unreadable refresh response.");
  }
  if (typeof parsed?.token !== "string" || !parsed.token ||
      typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
    throw new RefreshFailed("InferLab returned an incomplete refresh response.");
  }
  return {
    accessToken: parsed.token, accessExpiresAt: accessTokenExpiry(parsed.token),
    refreshToken: parsed.refreshToken,
  };
}

async function postSession(origin: string, path: string, refreshToken: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
    redirect: "manual",
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  });
}

/**
 * Rotates the session at InferLab. A 401 proves the session dead (signed out, expired, or already
 * rotated elsewhere); any other failure leaves the stored grant as it is.
 */
export async function refreshInferLabSession(origin: string, current: InferOpsGrant):
    Promise<InferOpsGrant> {
  let response: Response;
  try {
    response = await postSession(origin, "/auth/refresh", current.refreshToken);
  } catch (error) {
    throw new RefreshFailed("InferLab could not be reached to refresh the session.", { cause: error });
  }
  const body = await readTextCapped(response, MAX_RESPONSE_BYTES);
  if (response.status === 401) {
    throw new CredentialsExpiredError("Your InferLab session has ended. Reconnect InferOps.");
  }
  if (!response.ok) {
    logger.warn("InferLab refresh failed", { event: "session.refresh.failed", status: response.status });
    throw new RefreshFailed(`InferLab refused to refresh the session (HTTP ${response.status}).`);
  }
  return grantFromRefreshResponse(body);
}

/** Signs the session out at InferLab. Best effort: a failure is logged and the local copy goes anyway. */
export async function logoutInferLabSession(origin: string, refreshToken: string): Promise<void> {
  try {
    const response = await postSession(origin, "/auth/logout", refreshToken);
    if (!response.ok && response.status !== 401) {
      logger.warn("InferLab logout failed", { event: "session.logout.failed", status: response.status });
    }
  } catch (error) {
    logger.warn("InferLab logout failed", { event: "session.logout.failed", status: 0, error });
  }
}

/** The configured InferLab origin for session calls, or null. Kept local so the DO has no cycle. */
function sessionOrigin(env: InferLabSessionEnv): string | null {
  const raw = env.INFERLAB_AUTH_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** The account's per-account credential store. One object per connected account. */
@validateRpc()
export class InferOpsCredentials extends DurableObject<Cloudflare.Env> {
  #coordinator = new CredentialCoordinator<InferOpsGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.accessExpiresAt || undefined,
    vendorId: VENDOR_ID,
  });

  #refresh = (current: InferOpsGrant): Promise<InferOpsGrant> => {
    const origin = sessionOrigin(this.env);
    if (!origin) throw new RefreshFailed("InferLab sign-in is not configured on this deployment.");
    return refreshInferLabSession(origin, current);
  };

  #notify = (): Promise<void> => notifyCredentialsExpiredOnce(
    this.ctx.storage.kv,
    this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY),
    VENDOR_ID);

  /** Installs the grant a connect flow produced, with the Workshop callback that owns the account. */
  @skipRpcValidation()
  async install(connection: InferOpsConnection,
                callback: Fetcher<GatekeeperConnectCallback>): Promise<void> {
    this.ctx.storage.kv.put(CALLBACK_KEY, callback);
    this.ctx.storage.kv.put(IDENTITY_KEY, connection.identity);
    this.ctx.storage.kv.delete(WORKSPACE_KEY);
    this.#coordinator.connect(connection.grant);
  }

  /**
   * Stages a reconnect's grant and tells the Workshop, whose `commitReconnect` makes it live. The
   * reconnect URL is a bearer capability, so nothing bound to this account reads the new grant
   * until the Workshop has verified the browser that finished the flow.
   */
  async completeReconnect(connection: InferOpsConnection): Promise<{ targetOrigin: string; ticket: string }> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>(CALLBACK_KEY);
    if (!callback) throw new Error("This InferOps account is not connected.");
    const stageId = stageCredentials(this.ctx.storage.kv, connection, Date.now());
    try {
      return await callback.reconnectComplete(stageId);
    } catch (error) {
      const dropped = discardStagedCredentials<InferOpsConnection>(this.ctx.storage.kv, stageId);
      const origin = sessionOrigin(this.env);
      if (dropped && origin) await logoutInferLabSession(origin, dropped.grant.refreshToken);
      throw error;
    }
  }

  /** Makes the grant staged under `stageId` live; see `GatekeeperUser.commitReconnect`. */
  async commitReconnect(stageId: string): Promise<void> {
    const staged = commitStagedCredentials<InferOpsConnection>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("No InferOps reconnect is awaiting confirmation. Please try again.");
    const previous = this.#coordinator.stored();
    this.ctx.storage.kv.put(IDENTITY_KEY, staged.identity);
    this.#coordinator.connect(staged.grant);
    // The old session is a separate InferLab session; ending it cannot touch the new one.
    const origin = sessionOrigin(this.env);
    if (previous && origin) await logoutInferLabSession(origin, previous.refreshToken);
  }

  /** Who connected, or null before a connect. */
  async identity(): Promise<InferOpsIdentity | null> {
    return this.ctx.storage.kv.get<InferOpsIdentity>(IDENTITY_KEY) ?? null;
  }

  /**
   * Chooses which of the person's workspaces new bindings are made in; null returns to the default
   * (the only workspace). A workspace the person is not a member of is refused.
   */
  async selectWorkspace(workspaceId: string | null): Promise<void> {
    if (workspaceId === null) {
      this.ctx.storage.kv.delete(WORKSPACE_KEY);
      return;
    }
    this.#membership(workspaceId);
    this.ctx.storage.kv.put(WORKSPACE_KEY, workspaceId);
  }

  /**
   * The workspace a new binding is made in: the selected one, else the person's only one. Throws
   * when the person has several and none is selected, or has none at all.
   */
  async currentWorkspace(): Promise<string> {
    return this.#workspace(undefined);
  }

  /**
   * The access token and workspace for one request, refreshing the token first when it is about to
   * expire. `workspaceId` names a binding's workspace; omitted, the current one is used. Throws a
   * `CredentialsExpiredError` once InferLab has confirmed the session dead, after announcing it to
   * the Workshop once.
   */
  async getCredentials(workspaceId?: string): Promise<CredentialsWithIdentity<InferOpsAuthority>> {
    // The connection first, so a disconnected account reads as such rather than as no membership.
    const { creds, identity, generation } =
      await this.#coordinator.snapshot(this.#refresh, { notify: this.#notify });
    const target = this.#workspace(workspaceId);
    return { creds: { token: creds.accessToken, workspaceId: target }, identity, generation };
  }

  /** The account's verdict on a token InferOps rejected; see `CredentialCoordinator`. */
  async reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return this.#coordinator.adjudicateRejection(identity, {
      refresh: this.#refresh, notify: this.#notify,
    });
  }

  /** Signs the session out at InferLab and forgets everything held for this account. */
  async revoke(): Promise<void> {
    const current = this.#coordinator.stored();
    const staged = discardStagedCredentials<InferOpsConnection>(this.ctx.storage.kv);
    this.#coordinator.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const origin = sessionOrigin(this.env);
    if (!origin) return;
    if (current) await logoutInferLabSession(origin, current.refreshToken);
    if (staged) await logoutInferLabSession(origin, staged.grant.refreshToken);
  }

  #membership(workspaceId: string): InferOpsWorkspace {
    const identity = this.ctx.storage.kv.get<InferOpsIdentity>(IDENTITY_KEY);
    const member = identity?.workspaces.find(w => w.workspaceId === workspaceId);
    if (!member) {
      throw new Error("You are not a member of that InferOps workspace, so it cannot be used here.");
    }
    return member;
  }

  #workspace(requested: string | undefined): string {
    if (requested !== undefined) return this.#membership(requested).workspaceId;
    const selected = this.ctx.storage.kv.get<string>(WORKSPACE_KEY);
    if (selected !== undefined) return this.#membership(selected).workspaceId;
    const identity = this.ctx.storage.kv.get<InferOpsIdentity>(IDENTITY_KEY);
    const workspaces = identity?.workspaces ?? [];
    if (workspaces.length === 1) return workspaces[0]!.workspaceId;
    if (workspaces.length === 0) {
      throw new Error("Your InferLab account has no InferOps workspace.");
    }
    throw new Error("You belong to several InferOps workspaces; choose one when adding the board.");
  }
}

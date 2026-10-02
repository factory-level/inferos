import type { ConnectFlowStart } from './connect-flow.js';
import type { RpcTarget } from 'capnweb';

/** Recovery choices for a ChatGPT connection or request. */
export type OpenAiRecovery = 'sign-in' | 'consent' | 'usage' | 'retry' | 'configuration' | 'none';

/** Safe provider failure metadata. Raw provider bodies stay in the companion process. */
export type OpenAiPluginError = {
  /** HTTP status, including admission failures before SSE starts. */
  status: number;
  /** Machine-readable provider or InferOS error code. */
  code: string;
  /** User-facing explanation, without tokens or request content. */
  message: string;
  /** Recovery offered without changing the request's billing path. */
  recovery: OpenAiRecovery;
  /** Provider request identifier, when present. */
  requestId?: string;
  /** Rejected parameter, when the provider identifies one. */
  param?: string;
};

/** One saved ChatGPT registration; never includes OAuth credentials. */
export type OpenAiAccount = {
  /** Opaque local registration reference, distinct even for registrations sharing an email. */
  id: string;
  /** Stable account label. */
  label: string;
  /** Email from the validated ID token, for display only. */
  email?: string;
  /** Whether usable credentials and the plan-usage grant are available. */
  status: 'ready' | 'signed-out' | 'plan-disabled' | 'usage-paused';
  /** Explicit permission for scheduled, resumed, and gadget-initiated inference. */
  allowBackground: boolean;
  /** Most recent failure for this registration, independent of the active account. */
  error?: OpenAiPluginError;
};

/** Displayable model from the selected ChatGPT account's current catalog. */
export type OpenAiPlanModel = {
  /** Provider model identifier used in Responses requests. */
  slug: string;
  /** Provider display name. */
  displayName: string;
};

/** Account and connection state belonging to the authenticated Workshop user. */
export type OpenAiPluginState = {
  /** Saved registrations owned by this user. */
  accounts: OpenAiAccount[];
  /** Explicitly selected registration, or null. */
  activeAccountId: string | null;
  /** Connection-wide failure; registration-specific failures are attached to accounts. */
  error?: OpenAiPluginError;
  /** Whether the first successful plan connection still needs acknowledgment. */
  needsWelcome: boolean;
};

/** Authenticated capability for the local ChatGPT companion. */
export interface OpenAiAssistantPluginApi extends RpcTarget {
  /** Read safe account state. */
  getState(): Promise<OpenAiPluginState>;
  /** Start registration or reauthorization; consent is forced only by explicit user request. */
  startSignIn(accountId?: string, consent?: boolean): Promise<ConnectFlowStart>;
  /** Activate staged credentials using this popup's one-use handoff. */
  completeSignIn(ticket: string, nonce: string): Promise<void>;
  /** Select a saved account for use or recovery and cancel the previous account's active requests. */
  selectAccount(accountId: string): Promise<void>;
  /** Read current models in provider order. */
  listModels(accountId: string): Promise<OpenAiPlanModel[]>;
  /** Cancel requests, revoke the renewable session, and clear local tokens. */
  signOut(accountId: string): Promise<{ revoked: boolean }>;
  /** Change explicit permission for autonomous usage. */
  setBackgroundUsage(accountId: string, allowed: boolean): Promise<void>;
  /** Explicitly permit another request after a usage-cap response. */
  retryPlanUsage(accountId: string): Promise<void>;
  /** Acknowledge the first-use plan billing explanation. */
  acknowledgeWelcome(): Promise<void>;
}

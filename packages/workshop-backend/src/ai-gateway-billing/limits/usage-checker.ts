// Usage checker: combines the daily free-tier counter with the BYOK/balance logic to decide
// whether a user's request may proceed, and whose credentials to use.
//
// Billing rules (see canProceedWithRequest):
//   - Connected + balance >= minimum -> billed to the user's own gateway, no daily cap; the daily
//     counter is NOT consumed (the platform free tier is reserved for everyone else).
//   - Connected + balance below minimum (incl. $0), or not connected -> platform free tier; the
//     daily counter is consumed and, once exhausted, the request is blocked.

import { canProceedWithRequest, hasMinimumBalance, LimitWindowKind } from "@gadgets/workshop-shared/limits";
import type { AiModelConfig, CloudflareUsageInfo } from "@gadgets/workshop-shared/api";
import { getAiGatewayConfig } from "../../ai-gateway.js";
import { getDailyAgentTurnCap, modelNotOfferedMessage } from "../../model-allowlist.js";
import { isCloudflareLimitsEnabled, getMinimumCloudflareBalance } from "../config.js";
import { getDailyLlmCallLimit } from "./config.js";
import { getConnectionStatus, resolveConnection, ByokGatewayRouting } from "../cloudflare/connection-service.js";
import type { UserDurableObject } from "../../user.js";

export interface UsageCheckResult {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Guidance/reason when blocked. */
  reason?: string;
  /**
   * The chat error code when blocked. Unset means `usage_limit`, which offers adding credits; the
   * plain daily cap uses `daily_turn_limit`, because there's nothing to top up, and a model the
   * allowlist doesn't offer uses `model_not_offered`.
   */
  errorCode?: "daily_turn_limit" | "model_not_offered";
  /** Whether to serve the request using the user's own gateway/keys rather than the platform's. */
  shouldUseByok: boolean;
  /** Whether the user is within their free-tier limit. */
  withinLimits: boolean;
  /** Calls remaining in the current window (Infinity when limits are disabled). */
  remaining: number;
  /** The configured limit (Infinity when limits are disabled). */
  limit: number;
  /** Window kind and reset time (omitted when unlimited). */
  windowKind?: LimitWindowKind;
  resetAt?: string;
  /** The user's Cloudflare AI Gateway balance, or null if unknown / not connected. */
  balance: number | null;
  /** Whether the user has connected a Cloudflare account with a usable token. */
  hasUserToken: boolean;
  /**
   * Routing to bill the user's own account, present only when shouldUseByok is true. Resolved here
   * (reusing the connection lookup) so the caller needn't decrypt the token a second time.
   */
  byokRouting?: ByokGatewayRouting;
}

// Result used when limits are disabled (self-hosted / unlimited).
function unlimitedResult(): UsageCheckResult {
  return {
    allowed: true,
    shouldUseByok: false,
    withinLimits: true,
    remaining: Infinity,
    limit: Infinity,
    balance: null,
    hasUserToken: false,
  };
}

/**
 * Check whether the user may proceed with an LLM-backed request.
 *
 * When limits are disabled, always allows without touching the user object. Otherwise: connected +
 * funded users bill their own gateway and skip the daily counter entirely; everyone else draws on
 * the platform free tier (consuming one call against the user object) until it's exhausted.
 */
export async function checkUsageAndBalance(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
  platformModel?: AiModelConfig,
): Promise<UsageCheckResult> {
  if (!isCloudflareLimitsEnabled(env)) {
    // No person's gateway can pay here, so the platform funds the turn.
    return platformModelRefusal(env, platformModel) ?? checkDailyTurnCap(env, userStub);
  }

  const limit = getDailyLlmCallLimit(env);
  const minimumBalance = getMinimumCloudflareBalance(env);

  // Resolve the connected-account status up front: it determines billing even within the free tier
  // (connected + funded users always bill their own gateway). `balance` is null when not connected
  // or when the balance can't be read — treated as "not funded" so we fall back to the free tier
  // rather than attempting a BYOK call that would fail.
  let hasUserToken = false;
  let balance: number | null = null;
  // Routing to bill the user's own account, derivable only when connected with a resolved account.
  let byokRouting: ByokGatewayRouting | undefined;
  const conn = await resolveConnection(env, userStub);
  hasUserToken = conn.status.connected;
  balance = conn.status.balance;
  if (conn.accessToken && conn.accountId) {
    byokRouting = { accountId: conn.accountId, apiKey: conn.accessToken };
  }

  // Connected + funded -> bill their gateway; don't touch the daily free-tier counter. The model
  // allowlist doesn't apply when there's a route to their gateway; without one, getModel would fall
  // through to the platform's, so it does.
  if (hasUserToken && hasMinimumBalance(balance, minimumBalance)) {
    const refusal = byokRouting ? null : platformModelRefusal(env, platformModel);
    if (refusal) return refusal;
    return {
      allowed: true,
      shouldUseByok: true,
      withinLimits: true,
      remaining: Infinity,
      limit: Infinity,
      balance,
      hasUserToken,
      byokRouting,
    };
  }

  // Otherwise draw on the platform free tier: a model the allowlist doesn't offer is refused before
  // anything is counted. consumeDailyLlmCall() only increments while within the limit (it no-ops
  // once `used >= limit`), so a blocked request never counts.
  const refusal = platformModelRefusal(env, platformModel);
  if (refusal) return refusal;
  const quota = await userStub.consumeDailyLlmCall(limit);

  const decision = canProceedWithRequest({
    withinLimits: quota.withinLimits,
    hasUserToken,
    balance,
    minimumBalance,
  });

  return {
    ...decision,
    withinLimits: quota.withinLimits,
    remaining: quota.remaining,
    limit: quota.limit,
    windowKind: "daily",
    resetAt: quota.resetAt,
    balance,
    hasUserToken,
    byokRouting: decision.shouldUseByok ? byokRouting : undefined,
  };
}

/**
 * The gate for a turn that draws on the platform's allowance (see drawsOnPlatformAllowance). It's
 * checkUsageAndBalance with the turn's model, so MODEL_ALLOWLIST applies exactly when the platform
 * would fund the turn: a gateway-routed model it doesn't offer is refused there, before anything is
 * counted, with the code `model_not_offered`. A turn routed to the person's own funded gateway is
 * neither allowlisted nor counted. A connection that can't be resolved counts as no connection, so
 * the turn is the platform's, and allowlisted.
 */
export async function checkPlatformTurn(
  env: Cloudflare.Env,
  model: { config: AiModelConfig },
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<UsageCheckResult> {
  return checkUsageAndBalance(env, userStub, model.config);
}

/**
 * The refusal for a turn the platform's gateway would fund on a model MODEL_ALLOWLIST doesn't
 * offer, or null. Only a model with no `billing` rides the platform gateway; one on a person's own
 * key or plan never does.
 */
function platformModelRefusal(env: Cloudflare.Env, config: AiModelConfig | undefined): UsageCheckResult | null {
  if (!config || config.billing !== undefined) return null;
  const gateway = getAiGatewayConfig(env);
  if (!gateway || gateway.offersModel(config)) return null;
  return {
    ...unlimitedResult(),
    allowed: false,
    reason: modelNotOfferedMessage(config.model),
    errorCode: "model_not_offered",
  };
}

/**
 * A plain daily cap on agent turns, for deployments such as a test stage where nobody can connect
 * a Cloudflare account to continue. It shares the user object's daily counter, and a blocked turn
 * isn't counted. Without a cap it allows everything, as before.
 */
async function checkDailyTurnCap(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<UsageCheckResult> {
  const cap = getDailyAgentTurnCap(env);
  if (cap === null) return unlimitedResult();
  const quota = await userStub.consumeDailyLlmCall(cap);
  return {
    allowed: quota.withinLimits,
    ...(quota.withinLimits ? {} : {
      reason: `This environment allows ${cap} agent turns a day, and they're used up. ` +
          "They reset at midnight UTC.",
      errorCode: "daily_turn_limit" as const,
    }),
    shouldUseByok: false,
    withinLimits: quota.withinLimits,
    remaining: quota.remaining,
    limit: quota.limit,
    windowKind: "daily",
    resetAt: quota.resetAt,
    balance: null,
    hasUserToken: false,
  };
}

/**
 * Read the user's current usage + connection status WITHOUT counting a call. Used by the UI to
 * render the usage banner. Returns an "unlimited" snapshot when limits are disabled.
 */
export async function getUsageInfo(
  env: Cloudflare.Env,
  userStub: DurableObjectStub<UserDurableObject>,
): Promise<CloudflareUsageInfo> {
  if (!isCloudflareLimitsEnabled(env)) {
    return {
      cloudflareLimitsEnabled: false,
      unlimited: true,
      dailyUsed: 0,
      dailyLimit: 0,
      remaining: 0,
      connected: false,
      balance: null,
    };
  }

  const limit = getDailyLlmCallLimit(env);
  // These two reads are independent — run them together to halve latency on this UI polling path.
  const [quota, status] = await Promise.all([
    userStub.checkDailyLlmCount(limit),
    getConnectionStatus(env, userStub),
  ]);

  return {
    cloudflareLimitsEnabled: true,
    unlimited: false,
    dailyUsed: quota.used,
    dailyLimit: quota.limit,
    remaining: quota.remaining,
    resetAt: quota.resetAt,
    connected: status.connected,
    balance: status.balance,
    accountId: status.accountId,
    accountName: status.accountName,
    needsAccountSelection: status.needsAccountSelection,
  };
}

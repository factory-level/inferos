import type { OpenAiPluginError, OpenAiRecovery } from '@gadgets/workshop-shared/openai-plugin';

/** Failure whose public message is safe to show or log; provider bodies are never in Error.message. */
export class PlanError extends Error {
  constructor(readonly detail: OpenAiPluginError, readonly diagnostic?: unknown) {
    super(detail.message);
  }
}

const rules: Record<string, [OpenAiRecovery, string]> = {
  subscription_sharing_user_not_eligible: ['none', 'ChatGPT plan usage is unavailable for this account, workspace, or policy.'],
  subscription_sharing_usage_limit_exceeded: ['usage', 'ChatGPT plan usage is paused. Review your app limit in ChatGPT Usage settings, then retry.'],
  subscription_sharing_usage_unavailable: ['retry', 'ChatGPT usage availability is temporarily unavailable.'],
  subscription_sharing_user_unavailable: ['retry', 'ChatGPT account information is temporarily unavailable.'],
  subscription_sharing_unsupported_capability: ['configuration', 'This request uses a capability unsupported by ChatGPT plan usage.'],
  subscription_sharing_route_not_supported: ['configuration', 'The ChatGPT plan request used an unsupported route.'],
  subscription_sharing_invalid_user: ['sign-in', 'Check the selected ChatGPT account and reconnect if its authorization was revoked.'],
  chatpass_v2_scope_not_authorized: ['configuration', 'The ChatGPT grant does not authorize this operation.'],
  chatpass_v2_invalid_authorization_context: ['configuration', 'The ChatGPT authorization context is invalid.'],
  invalid_client: ['configuration', 'The saved OpenAI client registration is invalid.'],
};

/** Refresh-token failures that invalidate this renewable session, not its client registration. */
export const terminalRefreshCodes = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

/** Parse both OAuth and Responses errors, including unstructured admission bodies. */
export function providerError(status: number, body: unknown, requestId?: string): PlanError {
  const root = object(body);
  const error = object(root.error);
  const code = typeof root.error === 'string' ? root.error :
    typeof error.code === 'string' ? error.code : 'http_' + status;
  const fallback: [OpenAiRecovery, string] = status === 401
    ? ['sign-in', 'Check your selected ChatGPT account and granted plan-usage permission.']
    : status === 403 ? ['none', 'ChatGPT denied this request because of a policy or permission restriction.']
    : status === 429 ? ['usage', 'ChatGPT usage is limited. Review your usage settings before retrying.']
    : status >= 500 ? ['retry', 'ChatGPT is temporarily unavailable. Try again later.']
    : ['none', 'The ChatGPT request failed.'];
  const [recovery, message] = terminalRefreshCodes.has(code)
    ? ['sign-in' as const, 'Your ChatGPT session has expired or was revoked. Sign in again.']
    : rules[code] ?? fallback;
  return new PlanError({ status, code, recovery, message,
    ...(requestId && { requestId }),
    ...(typeof error.param === 'string' && { param: error.param }),
  }, body);
}

/** Narrow arbitrary provider JSON without trusting its shape. */
export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Construct a local failure with an explicit recovery action. */
export function fail(code: string, message: string, recovery: OpenAiRecovery = 'none', status = 400): never {
  throw new PlanError({ status, code, message, recovery });
}

/** Safe transport failure for callers; intentionally excludes fetch URLs and headers. */
export function safeError(error: unknown): PlanError {
  return error instanceof PlanError ? error : new PlanError({
    status: 503, code: 'connection_unavailable', recovery: 'retry',
    message: 'The ChatGPT connection is unavailable. Try again later.',
  });
}

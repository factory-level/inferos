import { SUGGESTED_MODELS } from '@gadgets/workshop-shared/api';
import { applyModelAllowlist, modelAllowlist } from './model-allowlist.js';
import type { UserAiModelRecord } from './user.js';

/**
 * Offer the local developer's Anthropic key without storing or returning it to the browser,
 * limited and ordered by MODEL_ALLOWLIST when it's set.
 */
export function localApiModels(env: Cloudflare.Env): UserAiModelRecord[] {
  if (!env.DEV || !env.ANTHROPIC_API_KEY) return [];
  const offered = Object.entries(SUGGESTED_MODELS.anthropic).filter(([, model]) => !model.hidden);
  return applyModelAllowlist(offered, ([model]) => model, modelAllowlist(env))
    .map(([model, description]) => ({
      profile: { type: 'agent', id: 'local:anthropic:' + model,
        name: description.name + ' (local API key)', managed: true },
      config: { billing: 'api-key', provider: 'anthropic', model, apiToken: env.ANTHROPIC_API_KEY!,
        contextWindow: description.contextWindow, outputLimit: description.outputLimit },
    }));
}

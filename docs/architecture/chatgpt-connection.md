---
title: Personal ChatGPT connection
covers:
  - packages/workshop-backend/src/ai-models.ts
  - packages/workshop-backend/src/openai-plugin.ts
  - packages/workshop-backend/src/local-api-models.ts
  - packages/workshop-backend/src/feature-flags.ts
  - packages/workshop-shared/src/openai-plugin.ts
  - packages/workshop-shared/src/api.ts
  - packages/workshop-backend/src/auth/config.ts
  - packages/workshop-frontend/src/features/openai
  - assistant-plugins/openai
  - scripts/openai-companion.ts
  - scripts/local-secrets.ts
updated: 2026-10-04
---

# Personal ChatGPT connection

## Overview

ChatGPT plan usage exists for a **locally run** InferOS only ([#40](https://github.com/factory-level/inferos/pull/40)). An opt-in Bun companion (`assistant-plugins/openai`) implements OpenAI's OSS Sign in with ChatGPT flow on the developer's machine. It owns OAuth, credential files, refresh, revocation, model discovery and the streamed Responses requests. The Workshop Worker reaches it only over a loopback bridge, and no OAuth token crosses that boundary. A local developer can also use an Anthropic API key from the repository's `.env` as managed models, and pick an API-key model as an explicit fallback while ChatGPT is disconnected.

No Cloudflare-hosted connection exists. The bridge accepts only a `127.0.0.1` URL, and the deployed Worker configurations do not set the companion's variables, so the feature is off on every deployment. The feasibility question for a personal Workers install ([#12](https://github.com/factory-level/inferos/issues/12)) is unresolved, and live ChatGPT OAuth and inference are unverified: they need the user's interactive account connection. The [design](../design/chatgpt-connection.md)'s Cloudflare target is not implemented.

## Components

| Path | Responsibility |
| --- | --- |
| `assistant-plugins/openai` | Bun companion: sign-in flow and handoff, credential store (`~/.config/inferos`, or `INFEROS_CONFIG_DIR`), token refresh and revocation, model catalog, Responses request shaping (unsupported fields such as `max_output_tokens` are rejected before sending), and `isOpenAiPluginEnabled`. Its README is the operator guide. Tests run under Bun. |
| `scripts/openai-companion.ts` | Starts the companion on an ephemeral loopback port with a random bridge secret and waits for its authenticated health check. |
| `scripts/local-secrets.ts` | Appends local secrets (the bridge secret, `ANTHROPIC_API_KEY`) to the backend's gitignored, owner-only `.dev.vars` and removes only that addition on exit. |
| `packages/workshop-backend/src/openai-plugin.ts` | `openAiBridgeRequest` (fixed loopback URL, bearer secret, owner header, no redirects) and `OpenAiAssistantPluginApiImpl`, the per-user RPC capability that validates every companion reply. |
| `packages/workshop-backend/src/ai-models.ts` | `getModel` routes a `billing: 'chatgpt-plan'` model through the bridge's `/responses` endpoint, with retries and cache retention off and the plan's structured errors kept on the handle. `billing: 'api-key'` goes direct to the provider. |
| `packages/workshop-backend/src/local-api-models.ts` | `localApiModels`: managed Anthropic models from the local key, only when the deployment is `DEV`. The key is never returned to the browser. |
| `packages/workshop-backend/src/user.ts` | Model storage and validation for plan models, and the disconnected-only fallback in `#getChatContext`. |
| `packages/workshop-backend/src/feature-flags.ts` | Resolves the `openai-chatgpt-plan-usage` UI flag from the deployment switch rather than from Flagship. |
| `packages/workshop-shared/src/openai-plugin.ts` | `OpenAiAssistantPluginApi` and its account, model, state and error types. |
| `packages/workshop-shared/src/api.ts` | `ChatGptPlanModelConfig` (`billing: "chatgpt-plan"`, `provider: "openai"`, a registration id, and no token, URL or headers), `getOpenAiAssistantPlugin()`. |
| `packages/workshop-frontend/src/features/openai` | Settings → ChatGPT plan usage, the plan model modal and the fallback setting. |
| `packages/workshop-backend/src/auth/config.ts` | Workshop sign-in policy. It is unrelated to ChatGPT authorization. |

## Data and Control Flow

`pnpm run-local` or `pnpm dev-server` with `ENABLE_OPENAI_ASSISTANT_PLUGIN=true` starts the companion (Bun 1.3.11 or newer). The dev server sets `ENABLE_OPENAI_ASSISTANT_PLUGIN` and `OPENAI_ASSISTANT_PLUGIN_URL` on the backend and passes the secret through `.dev.vars`, so Wrangler does not print it. `isOpenAiPluginEnabled` requires all three, with an `http://127.0.0.1:<port>/` URL. Every bridge request and every capability method rechecks it. An unexpected companion exit disables requests until the local server restarts.

`AuthenticatedApi.getOpenAiAssistantPlugin()` returns the capability, or null when the switch is off. Its operations (state, start and complete sign-in, select account, list models, sign out, background usage, retry after a usage cap, welcome acknowledgement) are forwarded as commands carrying the Workshop user id. The companion scopes registrations to that user. Sign-in completion uses the same single-use ticket plus nonce handoff as gatekeeper connect flows.

A plan model is bound to one registration. At inference, `getModel` builds an OpenAI Responses handle whose fetch accepts only `POST https://api.openai.com/v1/responses` and sends it to the bridge with the registration id and whether the turn is background usage (anything not started by the user in chat). The companion enforces the per-registration background permission and usage pause.

When the user has chosen an API-key fallback, `#getChatContext` swaps it in only when the plan model's registration is missing or `signed-out`, or the switch is off. Quota, permission, network and companion failures keep the plan route and surface its recovery. The swapped model carries `fallbackForModelId`, so the chat attributes the responding model and the saved plan model is used again after reconnecting.

## Configuration

- `ENABLE_OPENAI_ASSISTANT_PLUGIN=true`, read by the dev server; the backend's `OPENAI_ASSISTANT_PLUGIN_URL` and `OPENAI_ASSISTANT_PLUGIN_SECRET` are set by the dev server, not by hand.
- `INFEROS_CONFIG_DIR` overrides the companion's credential directory.
- `ANTHROPIC_API_KEY`, from the shell, `.dev.vars` or the repository root `.env` (in that precedence), enables the local managed models.
- `AiModelConfig` is now `ApiKeyModelConfig | ChatGptPlanModelConfig`; legacy API-key configurations remain valid unchanged. `AUTH_GATEKEEPERS` and `DISABLE_PASSWORD_AUTH` configure Workshop login, not subscription authorization.

## Divergences from Design

- The design targets a personal **Cloudflare** install after a recorded eligibility decision. The implementation is a local companion on the user's machine, and no eligibility decision is recorded (#12). Per its README, hosted multi-user deployments still need OpenAI partner approval.
- Credentials are isolated per Workshop user in the companion's files, not stored server-side in the Worker.
- The design forbids silently falling back to paid API usage. The implemented fallback is explicit and opt-in, applies only while disconnected, and is attributed in chat. It is not silent, but it is a fallback that the design does not describe.
- Account states are `ready`, `signed-out`, `plan-disabled` and `usage-paused`. The design's `refreshing` and `reauthorization required` states are not modelled separately.
- Live sign-in, model discovery and a completed eligible request have not been demonstrated; the tests use fakes.

## Open Questions

- Official OSS documentation distinguishes locally hosted from remotely hosted applications; is a personal Workers install eligible, and which redirect/token-transfer topology is approved?
- Which stable host lifecycle and credential-storage mechanism fit a multi-tenant Worker without cross-user token reuse?

## Evidence

See the [feasibility findings](../wiki/chatgpt-feasibility.md) and the [source ledger](../wiki/research-sources.md) for official references.

## Wave 5 disposition

The [local audit table](../wiki/chatgpt-feasibility.md#local-implementation-audit--2026-10-04) maps #12/#13/#14 to the existing companion and its fake-backed tests. No new runtime feature or hosted topology was introduced. Cloudflare eligibility, owner sign-in and live subscription inference remain deferred; the local companion is preserved.

---
title: Configuration ownership and required settings
updated: 2026-10-01
---

# Configuration ownership and required settings

A starting settings inventory for the setup skills, grounded in current code.

## Steps

1. Identify the deployment profile and which optional services are enabled.
2. Resolve each required setting from its owner; distinguish values from credentials.
3. Generate Worker configs and validate binding/secret requirements without printing secrets.
4. Verify local fixtures, then run explicitly selected remote checks.

## Current settings

| Setting/group | Owner and source | Required when / default | Sensitivity and explanation |
| --- | --- | --- | --- |
| Worker names, account, route, service bindings | Deployer; canonical cloudflare.config.ts and wrapper deployment inputs | Every cloud deployment; names must remain stable | Nonsecret routing identity; backend bindings select GatekeeperVendor, router bindings select fetch |
| PUBLIC_BASE_URL | Deployer; backend environment | Public callback/connect flows | Nonsecret exact public origin; do not substitute a private worker origin |
| ADMINS | Deployer; environment/instance state | Admin access is desired; local runner supplies admin | Identity policy; not an ordinary theme setting |
| CF_ACCESS_ISS / CF_ACCESS_AUD | Deployer; auth environment | Access-mode deployments | Both must match deployed Access; local mocks do not validate live policy |
| AUTH_GATEKEEPERS | Deployer; auth environment | Gatekeeper sign-in is used | Explicit allowlist; installing a connector alone does not make it a sign-in provider |
| DISABLE_PASSWORD_AUTH | Deployer; auth environment | Password login should be disabled with valid alternative auth | Conditional behavior is in auth/config.ts; validate against lockout/contradictory config |
| Site name/logo/accent, instructions, banners | Admin; AdminConfig | Optional soft customization | Stored by AdminSettings DO and mirrored in reserved KV key |
| disabledGatekeepers / disabledResources | Admin; AdminConfig | Optional opt-outs; offered by default | Enforced before capability issuance in user.ts |
| ambientGatekeeperModes | Admin; AdminConfig | Auto-provisioning vendors; default optional | disabled/optional/enabled; vendor cannot grant itself ambient authority |
| AiModelConfig token/URL/headers | Account/model configuration | Selected current API-key provider | Tokens and credential-bearing headers secret; browser receives redacted secrets |
| CF_AI_GATEWAY family | Deployer; env.d.ts and selected mode | Cloudflare AI Gateway billing/provider configuration | Account ID/provider list nonsecret; API_TOKEN secret; USE_BINDING changes path |
| Gatekeeper CLIENT_ID / CLIENT_SECRET | Deployer/provider app; deploy-inputs metadata | Default OAuth install inputs unless overridden | Client secret secret; no-OAuth connectors must opt out of misleading required inputs |
| BLUEPRINTS / BLUEPRINT_CONTENT / AVATARS | Deployer; KV/R2 bindings | Core artifact/avatar storage | Resource identifiers nonsecret; stored data access is still scoped |
| BUNDLED_BLUEPRINTS_DIR | Builder; environment | Optional alternate bundle directory | Nonsecret filesystem path; backend build is uncached because file contents matter |
| Context sharingDomain | Deployer; gatekeeper binding props | Context Library | Isolation namespace; dev default is dev, choose production domain deliberately |
| METRICS / ERROR_REPORTER | Deployer; optional bindings | Observability enabled | Routing/configuration separate from payload; logs must exclude prompts/tokens/data |
| VITE_FRONTEND_ERROR_REPORTING | Builder; frontend env | Optional client reports, default off | Build-time flag; backend reporter/rate limiter bindings also required |
| Local ports and state directory | Developer/wrapper | Every local instance | Distinct per wrapper; future reset must name exact local target |
| .dev.vars | Developer; local uncommitted input | Local secrets/configuration as needed | Shell overrides; never commit credentials or use production as fixtures |

This table is explanatory, not a complete executable schema. Exact names and conditionals come from `packages/workshop-backend/src/env.d.ts`, `auth/config.ts`, `admin-config.ts`, `scripts/run-dev-server.ts` and `scripts/release/manifest-lib.ts`. Setup implementation must derive validation from those contracts and test drift.

## Proposed additions

The ChatGPT account/host state, InferOps connection scope and canvas composition revision are proposed contracts. Do not invent environment variables for them before their design issues resolve storage and authority. Runtime refresh credentials belong to the selected account, not a committed wrapper config. The wrapper’s upstream pin, local fixture profile and state path should be nonsecret declarative inputs.

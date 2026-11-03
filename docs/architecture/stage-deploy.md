---
title: Persistent stage deploys
design: https://github.com/factory-level/inferops/blob/develop/docs/human/journeys/superuser/inferos-shell/deploy-cloud-tenant.md
covers:
  - scripts/stage
  - scripts/preview/staging-config.ts
  - packages/workshop-backend/src/model-allowlist.ts
  - packages/workshop-backend/src/ai-gateway.ts
  - packages/workshop-backend/src/ai-gateway-billing/limits/usage-checker.ts
updated: 2026-11-03
---

# Persistent stage deploys

## Overview

`scripts/stage/` deploys this checkout as a long-lived instance on the account named by `CLOUDFLARE_ACCOUNT_ID`, with the pinned Wrangler and its login. Stages are defined in `scripts/stage/stages.ts`:

| Stage | Hostname | InferLab API / central auth |
| --- | --- | --- |
| `dev` | `dev-os.factorylevel.dev` (sign-in proxy `auth.dev-os.factorylevel.dev`) | `https://api.dev.inferlab.io` / `https://auth.dev.inferlab.io` |
| `prod` | `os.factorylevel.dev` | `https://api.inferlab.io` / `https://auth.inferlab.io` |

- **Real deploys, not Worker Previews.** Each package is deployed with `wrangler deploy` as `<workerPrefix><package>` (`inferos-dev-…`, `inferos-prod-…`), with every service binding renamed to match and binding names unchanged, so the router and backend discover gatekeepers exactly as they do elsewhere. The prefix is part of a stage's identity: Durable Objects belong to the worker name, so changing it starts an empty instance. `stage-config.ts` builds every config from the committed `wrangler.jsonc` files, reusing `backendGatekeeperServices`/`routerGatekeeperServices` from `scripts/preview/staging-config.ts` with a worker-name mapper; it writes a gitignored `wrangler.stage-<stage>.jsonc` beside each.
- **Topology.** Tiers deploy gatekeepers concurrently, then the backend, then the router. Only the router is reachable, at the stage hostname as a custom domain, plus, on a stage with `inferops.authorizeOrigin`, the InferOps gatekeeper at that origin's hostname (`stageWorkerHost`); every worker sets `workers_dev: false` and `preview_urls: false`, and the deploy fails when Wrangler reports any other target (`WRANGLER_OUTPUT_FILE_PATH`). Gatekeepers are `BASE_URL=https://<host>/gatekeeper/<short>`, and the context gatekeeper's `sharingDomain` is the stage origin.
- **Gatekeepers.** A stage deploys only the gatekeepers it lists: `gatekeeper-inferops`, `gatekeeper-context`, `gatekeeper-scheduler` and `gatekeeper-mcp`, the ones that need no third-party OAuth app. Others are neither deployed nor bound.
- **Sign-in.** Cloudflare Access protects the hostname at the edge only. The backend gets no `CF_ACCESS_*`, because with `CF_ACCESS_AUD` set it takes the Access identity and refuses every other login; instead it gets `AUTH_GATEKEEPERS=inferops` and `DISABLE_PASSWORD_AUTH=true`, checked with `inferLabLoginStartupError` before deploying, and the frontend is built with `VITE_CF_ACCESS_MODE=false`. The InferOps gatekeeper gets `INFEROPS_BASE_URL`, `INFERLAB_AUTH_ORIGIN`, `INFERLAB_AUTHORIZE_ORIGIN` when the stage has an `authorizeOrigin`, `INFEROPS_ENABLED=true`, and every optional switch stated `false` (coding dispatch included). The local-development stopgap (`INFEROPS_API_TOKEN`, workspace id/slug, mock seed) is refused.
- **Sign-in proxy (dev).** Dev InferLab's Cloud Armor admits only allowlisted addresses and the edge header, so a browser elsewhere (an external test agent) cannot open central-auth. `dev` therefore sets `inferops.authorizeOrigin: https://auth.dev-os.factorylevel.dev`: the gatekeeper sends the sign-in popup there and forwards central-auth's three browser legs to InferLab with the edge header (see [InferOps gatekeeper](inferops-gatekeeper.md#sign-in-proxy)). `stageDefinitionProblems` requires it to be a bare https origin on a hostname of its own. The page exposes the persona picker, so the hostname must be in the stage's Access application.
- **Backend.** `PUBLIC_BASE_URL` is the stage origin, `COMPOSABLE_VIEWS` and `DURABLE_VIEWS` are on, `CANVAS_CATALOG` comes from `inferos.canvas.json` when the checkout has one, and the `WORKERS_AI` binding is injected as in the manifest and previews.
- **Resources.** KV namespaces are titled `<resourcePrefix><package>-<binding>`, found by title with `wrangler kv namespace list`, created when missing and bound by id; the R2 bucket is `<resourcePrefix>blueprint-content`, which Wrangler creates on first deploy. Committed Durable Object migrations pass through unchanged; a step that deletes, renames or transfers a class is refused unless `--allow-destructive-migrations` is passed.
- **Secrets.** `ADMINS` (from `STAGE_ADMINS`, required) and the optional AI Gateway settings (`resolveAiGateway`) are uploaded with the backend's version through a temporary `--secrets-file`; no value is written to a config, argv or the plan. The InferOps gatekeeper's optional `INFEROPS_EDGE_SECRET` (`stageInferOpsGatekeeperSecrets`, validated as `[A-Za-z0-9_-]{32,}` without printing it) is uploaded the same way with that gatekeeper's version, and the plan names it on that worker's line. Unset, no secrets file is passed to the gatekeeper, so the deploy keeps any value an earlier version held. Inputs come from the shell, then a gitignored `.stage-<stage>.vars`.
- **Checks.** `--dry-run` prints the plan with no network. `prod` deploys only from a clean tree; `dev` needs `--allow-dirty` for one. After the router deploys, an unauthenticated request to every stage hostname (`stageHostnames`: the stage's, and the sign-in proxy's) must be an Access login redirect, or the run fails saying the stage is exposed; on a first deploy the probe retries name-resolution failures (`ENOTFOUND`/`EAI_AGAIN`) for up to five minutes while the new custom-domain record appears (`retryWhileDnsPending`, `scripts/stage/stage-resources.ts`); with `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` set it then runs `runSmoke` against the stage's gatekeepers. `pnpm stage:delete <stage> --confirm <hostname>` deletes the workers, router first, and keeps the KV namespaces and bucket.
- `scripts/stage/stage-config.test.ts` and `stage-resources.test.ts` cover the configs built from the real packages, the stage definitions (including the authorize origin's rules and which workers get a custom domain), secret redaction in the plan (the backend's and the edge secret), edge-secret validation and the Wrangler output parsers. The runbook is [deploy a persistent stage](../wiki/stage-deploy.md); the decision is [ADR 0009](../adr/0009-persistent-stage-deploys.md) (proposed).

## Agent models and bounds

A stage offers no agent model until it has a model source. On a stage that's the platform AI Gateway: `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_PROVIDERS`, uploaded as backend secrets by `resolveAiGateway`, with the provider's key stored in that gateway, never in InferOS. Without them, the only models are ones a person adds with their own key, so the picker shows "No agent". The local developer key (`localApiModels`) never reaches a stage, because a stage never sets `DEV`.

A stage's optional `agents` (`stages.ts`) bounds the platform's own models, as two plain backend vars (`backendVars`):

- **`MODEL_ALLOWLIST`** (`model-allowlist.ts`): the model ids offered, in order. `AiGatewayConfig.getModelList` and `localApiModels` offer only those, so the first is the default for anyone with no stored choice. `resolveModel` refuses the rest, so a stored choice can't reach a costlier model. Models a person adds with their own key aren't affected.
- **`DAILY_AGENT_TURN_LIMIT`** (`usage-checker.ts`): agent turns each workspace owner may start per UTC day, while the Cloudflare limits flow is off. It counts gateway turns and the local developer key (`drawsOnPlatformAllowance`), never a person's own key or plan, and a refused turn isn't counted. The chat shows "This environment allows N agent turns a day, and they're used up. They reset at midnight UTC." with the code `daily_turn_limit`, so no top-up dialog opens.

`dev` sets `models: ["claude-haiku-5-5"]` and `dailyTurnLimit: 40`; `prod` sets neither. `stageDefinitionProblems` refuses an empty model list, an id that couldn't be a comma-separated var, and a cap that isn't a positive integer.

**Neither is a dollar bound.** That's the spend limit on the key the gateway stores, set with the provider. The cap counts turns, and a turn can make many model calls; there's no per-turn step cap.

Claude Haiku 5.5 isn't in pi's bundled catalog, so `SUGGESTED_MODELS` states its window (200,000) and output limit (16,000) conservatively.

**Evidence, local only:** `workshop-backend/__tests__/model-bounds.test.ts`, the stage-config tests, and a local `pnpm dev-server` with `MODEL_ALLOWLIST=claude-haiku-5-5` and `DAILY_AGENT_TURN_LIMIT=2`. There the picker offered only "Claude Haiku 5.5 (local API key)", two turns were answered, and the third was refused with the message above. Not shown on a deployed stage.

## Divergences from Design

- There is no design document for stages; the owner's stated intent (two Zero-Trust instances wired to InferLab dev and prod, deployed from a workstation) is recorded in [ADR 0009](../adr/0009-persistent-stage-deploys.md), which is proposed. The cloud-parity requirements in [local development](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/local-development.md) remain the nearest design.
- No CI job deploys a stage. Access applications are created by hand in Zero Trust; a deploy can only probe that one is in front of the hostname.
- Stages deploy this checkout's packages only, not wrapper gatekeepers.
- Both stages were first deployed on 2026-10-28 (`inferos-dev-*` at dev-os.factorylevel.dev, `inferos-prod-*` at os.factorylevel.dev); each answered an unauthenticated `/`, `/api/` and `/gatekeeper/inferops/oauth` with an Access login redirect. InferLab sign-in and the deployed InferOps bindings remain unproven in the cloud.

## Open Questions

- Whether stages should move to CI (dev on merge, prod on approved dispatch) once the first deploys are accepted.
- Whether `prod` should configure an AI Gateway or stay bring-your-own-key. `dev` is meant to use one, bounded as above.
- Whether a turn needs its own step or token cap, beyond each call's output limit.

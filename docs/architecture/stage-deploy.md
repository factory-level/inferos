---
title: Persistent stage deploys
covers:
  - scripts/stage
  - scripts/preview/staging-config.ts
updated: 2026-10-29
---

# Persistent stage deploys

## Overview

`scripts/stage/` deploys this checkout as a long-lived instance on the account named by `CLOUDFLARE_ACCOUNT_ID`, with the pinned Wrangler and its login. Stages are defined in `scripts/stage/stages.ts`:

| Stage | Hostname | InferLab API / central auth |
| --- | --- | --- |
| `dev` | `dev-os.factorylevel.dev` | `https://api.dev.inferlab.io` / `https://auth.dev.inferlab.io` |
| `prod` | `os.factorylevel.dev` | `https://api.inferlab.io` / `https://auth.inferlab.io` |

- **Real deploys, not Worker Previews.** Each package is deployed with `wrangler deploy` as `<workerPrefix><package>` (`inferos-dev-…`, `inferos-prod-…`), with every service binding renamed to match and binding names unchanged, so the router and backend discover gatekeepers exactly as they do elsewhere. The prefix is part of a stage's identity: Durable Objects belong to the worker name, so changing it starts an empty instance. `stage-config.ts` builds every config from the committed `wrangler.jsonc` files, reusing `backendGatekeeperServices`/`routerGatekeeperServices` from `scripts/preview/staging-config.ts` with a worker-name mapper; it writes a gitignored `wrangler.stage-<stage>.jsonc` beside each.
- **Topology.** Tiers deploy gatekeepers concurrently, then the backend, then the router. Only the router is reachable, at the stage hostname as a custom domain; every worker sets `workers_dev: false` and `preview_urls: false`, and the deploy fails when Wrangler reports any other target (`WRANGLER_OUTPUT_FILE_PATH`). Gatekeepers are `BASE_URL=https://<host>/gatekeeper/<short>`, and the context gatekeeper's `sharingDomain` is the stage origin.
- **Gatekeepers.** A stage deploys only the gatekeepers it lists: `gatekeeper-inferops`, `gatekeeper-context`, `gatekeeper-scheduler` and `gatekeeper-mcp`, the ones that need no third-party OAuth app. Others are neither deployed nor bound.
- **Sign-in.** Cloudflare Access protects the hostname at the edge only. The backend gets no `CF_ACCESS_*`, because with `CF_ACCESS_AUD` set it takes the Access identity and refuses every other login; instead it gets `AUTH_GATEKEEPERS=inferops` and `DISABLE_PASSWORD_AUTH=true`, checked with `inferLabLoginStartupError` before deploying, and the frontend is built with `VITE_CF_ACCESS_MODE=false`. The InferOps gatekeeper gets `INFEROPS_BASE_URL`, `INFERLAB_AUTH_ORIGIN`, `INFEROPS_ENABLED=true`, and every optional switch stated `false` (coding dispatch included). The local-development stopgap (`INFEROPS_API_TOKEN`, workspace id/slug, mock seed) is refused.
- **Backend.** `PUBLIC_BASE_URL` is the stage origin, `COMPOSABLE_VIEWS` and `DURABLE_VIEWS` are on, `CANVAS_CATALOG` comes from `inferos.canvas.json` when the checkout has one, and the `WORKERS_AI` binding is injected as in the manifest and previews.
- **Resources.** KV namespaces are titled `<resourcePrefix><package>-<binding>`, found by title with `wrangler kv namespace list`, created when missing and bound by id; the R2 bucket is `<resourcePrefix>blueprint-content`, which Wrangler creates on first deploy. Committed Durable Object migrations pass through unchanged; a step that deletes, renames or transfers a class is refused unless `--allow-destructive-migrations` is passed.
- **Secrets.** `ADMINS` (from `STAGE_ADMINS`, required) and the optional AI Gateway settings (`resolveAiGateway`) are uploaded with the backend's version through a temporary `--secrets-file`; no value is written to a config, argv or the plan. The InferOps gatekeeper's optional `INFEROPS_EDGE_SECRET` (`stageInferOpsGatekeeperSecrets`, validated as `[A-Za-z0-9_-]{32,}` without printing it) is uploaded the same way with that gatekeeper's version, and the plan names it on that worker's line. Unset, no secrets file is passed to the gatekeeper, so the deploy keeps any value an earlier version held. Inputs come from the shell, then a gitignored `.stage-<stage>.vars`.
- **Checks.** `--dry-run` prints the plan with no network. `prod` deploys only from a clean tree; `dev` needs `--allow-dirty` for one. After the router deploys, an unauthenticated request to the hostname must be an Access login redirect, or the run fails saying the stage is exposed; on a first deploy the probe retries name-resolution failures (`ENOTFOUND`/`EAI_AGAIN`) for up to five minutes while the new custom-domain record appears (`retryWhileDnsPending`, `scripts/stage/stage-resources.ts`); with `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` set it then runs `runSmoke` against the stage's gatekeepers. `pnpm stage:delete <stage> --confirm <hostname>` deletes the workers, router first, and keeps the KV namespaces and bucket.
- `scripts/stage/stage-config.test.ts` and `stage-resources.test.ts` cover the configs built from the real packages, the stage definitions, secret redaction in the plan (the backend's and the edge secret), edge-secret validation and the Wrangler output parsers. The runbook is [deploy a persistent stage](../wiki/stage-deploy.md); the decision is [ADR 0009](../adr/0009-persistent-stage-deploys.md) (proposed).

## Divergences from Design

- There is no design document for stages; the owner's stated intent (two Zero-Trust instances wired to InferLab dev and prod, deployed from a workstation) is recorded in [ADR 0009](../adr/0009-persistent-stage-deploys.md), which is proposed. The cloud-parity requirements in [local development](../design/local-development.md) remain the nearest design.
- No CI job deploys a stage. Access applications are created by hand in Zero Trust; a deploy can only probe that one is in front of the hostname.
- Stages deploy this checkout's packages only, not wrapper gatekeepers.
- Both stages were first deployed on 2026-10-28 (`inferos-dev-*` at dev-os.factorylevel.dev, `inferos-prod-*` at os.factorylevel.dev); each answered an unauthenticated `/`, `/api/` and `/gatekeeper/inferops/oauth` with an Access login redirect. InferLab sign-in and the deployed InferOps bindings remain unproven in the cloud.

## Open Questions

- Whether stages should move to CI (dev on merge, prod on approved dispatch) once the first deploys are accepted.
- Whether a stage should configure an AI Gateway or stay bring-your-own-key.

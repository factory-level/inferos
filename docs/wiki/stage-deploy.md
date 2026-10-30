---
title: Deploy a persistent stage
updated: 2026-10-30
---

# Deploy a persistent stage

How to deploy, update, roll back and delete the two persistent InferOS instances, each behind Cloudflare Access and connected to its own InferLab environment. The implementation is described in [stage deploy architecture](../architecture/stage-deploy.md) and the decision in [ADR 0009](../adr/0009-persistent-stage-deploys.md).

| Stage | Hostname | InferLab |
| --- | --- | --- |
| `dev` | `https://dev-os.factorylevel.dev` | `api.dev.inferlab.io`, `auth.dev.inferlab.io` |
| `prod` | `https://os.factorylevel.dev` | `api.inferlab.io`, `auth.inferlab.io` |

## Before the first deploy

1. **Account.** The account holding the `factorylevel.dev` zone, on Workers Paid (bundle size, Browser Rendering and the Worker Loader). Nothing may already use the stage hostname as a DNS record or another Worker's custom domain.
2. **Access application, one per hostname** (Zero Trust → Access → Applications → Self-hosted), created **before** the first deploy so the hostname is never reachable without it:
   - Application domain: the stage hostname, all paths. On `dev`, add the sign-in proxy's hostname `auth.dev-os.factorylevel.dev` to the **same** application, so one PIN covers both; it serves the persona picker and must never be reachable without Access.
   - An **Allow** policy for the people (and test agents' mailboxes) who may reach the stage, with One-time PIN or an identity provider as the login method. Give each external test agent its own policy naming its own address (plus aliases such as `bot+owner@…` count as separate addresses), so Access logs say which one signed in.
   - A **Service Auth** policy for a service token (for example `inferos-dev-smoke`), used by the post-deploy smoke.
   The deploy cannot create these; it only checks afterwards that an unauthenticated request is redirected to Access, and fails loudly if not.
3. **InferLab registration.** InferLab's `inferos` sign-in client must allow the stage origin (`auth.sso.inferosOrigins` in InferOps' `config/development.js` for `dev`, `config/production.js` for `prod`); the callback is `<origin>/gatekeeper/inferops/oauth`. Without it "Sign in with InferLab" is refused at InferLab.
4. **Wrangler login.** `pnpm exec wrangler login` (opens a browser), then `export CLOUDFLARE_ACCOUNT_ID=<account id>`.
5. **Inputs.** Put them in the shell or in a gitignored `.stage-<stage>.vars` at the repository root (`KEY=value` lines; the shell wins):

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | yes | The account to deploy to. |
   | `STAGE_ADMINS` | yes | Comma-separated emails of the stage's admins (`/admin`). Uploaded as the backend's `ADMINS` secret. |
   | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | no | The Access service token; when set, the deploy runs the smoke through Access. |
   | `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, … | no | Server-managed models through AI Gateway (see `resolveAiGateway`). Unset, each user brings their own model keys. |
   | `INFEROPS_EDGE_SECRET` | no (yes for `dev` today) | The shared secret InferLab's edge lets through. Dev InferLab's Cloud Armor allows only allowlisted IPs, so without it the stage's sign-in (`POST /auth/token`) and every InferOps call get a 403. Set it to the same value as InferOps' `waf:inferosEdgeSecret` (at least 32 characters of `A-Za-z0-9_-`). It is uploaded as a `gatekeeper-inferops` secret, and the gatekeeper sends it as `x-inferos-edge` to the InferLab origins only. |

## Steps

1. Rehearse with no network: `pnpm stage:deploy dev --dry-run`. It prints every worker, its vars, the backend's secret names (never values), the KV namespaces and the bucket.
2. Deploy: `pnpm stage:deploy dev`. It builds the workspace (frontend in non-Access mode), creates any missing KV namespace, writes `wrangler.stage-dev.jsonc` beside each package, deploys gatekeepers, then the backend, then the router, checks that only the router (and, on `dev`, the gatekeeper's sign-in proxy) has a URL, checks the Access redirect on every stage hostname, and runs the smoke when a service token is set. `dev` refuses a dirty tree unless `--allow-dirty`; `prod` always refuses one.
3. Accept it by hand: sign in through Access, choose "Sign in with InferLab", and open a board you hold (`inferops://<tenant>.<workspace>/project/board/<KEY>`). A config that validates is not acceptance.
4. Re-deploying is the same command; KV namespaces, the bucket and every Durable Object are kept.

## InferLab edge secret

Dev InferLab's WAF lets the stage through only when the InferOps side and this side hold the same value: the WAF's `waf:inferosEdgeSecret` (the InferOps runbook "Allow the hosted InferOS edge"), and this stage's `INFEROPS_EDGE_SECRET`.

1. Add `INFEROPS_EDGE_SECRET=<value>` to `.stage-dev.vars`.
2. Rehearse with `pnpm stage:deploy dev --dry-run`. The `inferos-dev-gatekeeper-inferops` line should read `secrets: INFEROPS_EDGE_SECRET`, with no value anywhere.
3. Deploy with `pnpm stage:deploy dev`, then sign in with InferLab.
4. **Rotate.** Change both values and redeploy both sides. Requests are refused between the two deploys.
5. **Remove.** Leaving the variable out does not delete the value, because a deploy without it keeps the previous version's secret. Delete it with `pnpm exec wrangler secret delete INFEROPS_EDGE_SECRET --name inferos-dev-gatekeeper-inferops`.

## Rollback and deletion

- `pnpm exec wrangler rollback --name inferos-<stage>-<package>` returns one worker to an earlier version. It never undoes a Durable Object migration, which is why the deploy refuses destructive migrations unless `--allow-destructive-migrations` is passed.
- `pnpm stage:delete <stage> --confirm <hostname>` deletes the stage's workers, router first, and with them every Durable Object (all users' Workshop data). KV namespaces and the bucket are kept; delete them in the dashboard if that is intended.
- Never change a stage's `workerPrefix` or `resourcePrefix` in `scripts/stage/stages.ts`: the next deploy would create a new, empty instance and abandon the old one.

## Limits

- Only `gatekeeper-inferops`, `gatekeeper-context`, `gatekeeper-scheduler` and `gatekeeper-mcp` are deployed; the others need OAuth apps a stage does not configure.
- No CI job deploys a stage, and two people deploying one stage at once are not prevented.
- Wrapper gatekeepers are not packaged; a stage is this checkout.

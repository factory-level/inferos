---
title: Deploy a persistent stage
updated: 2026-11-05
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
2. Confirm the InferOps revision running behind this stage. Until its `/status` response exposes a full `gitSha`, pass the revision confirmed from the deployed InferOps Worker version: `pnpm stage:deploy dev --inferops-sha <40-character-sha>`. The checkout in `INFEROPS_REPO` (or the sibling `../inferops` checkout) must contain it. Deploy refuses a revision not descended from `connection.json`'s reviewed pin or whose board DTO changed since that pin; regenerate and review `scripts/consumer/project-board.schema.json` and update the pin before deploying such a change. Do not infer the deployed SHA from a branch name.
3. Deploy: `pnpm stage:deploy dev --inferops-sha <40-character-sha>`. It builds the workspace (frontend in non-Access mode), creates any missing KV namespace, writes `wrangler.stage-dev.jsonc` beside each package, deploys gatekeepers, then the backend, then the router, checks that only the router (and, on `dev`, the gatekeeper's sign-in proxy) has a URL, checks the Access redirect on every stage hostname, and runs the smoke when a service token is set. `dev` refuses a dirty tree unless `--allow-dirty`; `prod` always refuses one. The successful command prints a JSON deploy record containing the InferOS commit, stage config digest, InferOps commit and compatibility pin, and smoke report or skip reason. Save that record with the deployment evidence.
4. Accept it by hand: sign in through Access, choose "Sign in with InferLab", and open a board you hold (`inferops://<tenant>.<workspace>/project/board/<KEY>`). A config that validates is not acceptance. On `dev`, the reserved grokbot personas and their board are set up as in [set up the grokbot tenant for dev-os](grokbot-dev-os.md).
5. Re-deploying is the same command; KV namespaces, the bucket and every Durable Object are kept.

## InferLab edge secret

Dev InferLab's WAF lets the stage through only when the InferOps side and this side hold the same value: the WAF's `waf:inferosEdgeSecret` (the InferOps runbook "Allow the hosted InferOS edge"), and this stage's `INFEROPS_EDGE_SECRET`.

1. Add `INFEROPS_EDGE_SECRET=<value>` to `.stage-dev.vars`.
2. Rehearse with `pnpm stage:deploy dev --dry-run`. The `inferos-dev-gatekeeper-inferops` line should read `secrets: INFEROPS_EDGE_SECRET`, with no value anywhere.
3. Deploy with `pnpm stage:deploy dev`, then sign in with InferLab.
4. **Rotate.** Change both values and redeploy both sides. Requests are refused between the two deploys.
5. **Remove.** Leaving the variable out does not delete the value, because a deploy without it keeps the previous version's secret. Delete it with `pnpm exec wrangler secret delete INFEROPS_EDGE_SECRET --name inferos-dev-gatekeeper-inferops`.

## Agents on dev

`dev` offers one model, Claude Haiku 5.5, with 40 agent turns per workspace owner per UTC day (`agents` in `scripts/stage/stages.ts`). It still needs a model source, which takes a person's steps:

1. **Store the key in the gateway.** In the Cloudflare dashboard, AI Gateway, open or create the gateway in the stage's account. Add the Anthropic key to its stored provider keys. The key never goes in `.stage-dev.vars`, a stage secret or the repository.
2. **Bound the spend.** In the Anthropic console, set the monthly spend limit on that key's workspace. It's the only dollar bound: InferOS counts turns, not dollars.
3. **Name the gateway.** Add to `.stage-dev.vars`: `CF_AI_GATEWAY=<gateway name>`, `CF_AI_GATEWAY_ACCOUNT_ID=<account id>` and `CF_AI_GATEWAY_PROVIDERS=anthropic`. If the gateway is in the stage's own account, the `WORKERS_AI` binding carries requests and `CF_AI_GATEWAY_API_TOKEN` isn't needed. If it's in another account, add `CF_AI_GATEWAY_USE_BINDING=false` and a `CF_AI_GATEWAY_API_TOKEN` with Run and Read permission.
4. **Rehearse.** `pnpm stage:deploy dev --dry-run`. The backend's secrets line should name `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_PROVIDERS`, with no value. Its vars should list `MODEL_ALLOWLIST` and `DAILY_AGENT_TURN_LIMIT`; the plan prints names, not values.
5. **Deploy and accept.** `pnpm stage:deploy dev`, then sign in as a tester seat and send a chat message. The picker should offer only Claude Haiku 5.5.

### How a tester seat signs in

1. Open `https://dev-os.factorylevel.dev`. **Cloudflare Access** asks for an email: use the address its Allow policy names for this tester. A one-time code goes to that mailbox.
2. Choose **Sign in with InferLab**. The persona page (`auth.dev-os.factorylevel.dev`) lists the reserved test seats. Pick one: `owner@grokbot.inferlab.dev`, `power@grokbot.inferlab.dev` or `operate@grokbot.inferlab.dev`. No password or secret is involved.
3. **Your InferOS account is that email.** A different seat, or a seat whose address changed, is a different account, with its own empty list of workspaces, not lost ones. Check `/profile` to see which you're in. To switch seats, sign out of InferOS, open `https://auth.dev-os.factorylevel.dev/logout?return=/`, then sign in again.

When the day's turns are used up, the chat says so and when they reset. Nothing else changes.

On dev, a Gadget can't bind the platform's model, since the daily cap can't count a binding's calls: binding one is refused with a message saying so. A model a person adds on their own key can still be bound. A hand-added model that would run on the platform's gateway must be one dev offers.

## A company's own InferOS, from its wrapper

A company's InferOS is deployed from its wrapper repository, at the InferOS revision the wrapper pins, with the same deploy as the persistent stages. Nothing below has been run against a real account yet; the dry run and the tests are the proof so far.

1. **Describe the deployment** in `inferos.deploy.json` at the wrapper root, committed:

   ```json
   {
     "schemaVersion": 1,
     "company": "acme",
     "hostname": "os.acme.example",
     "inferops": {
       "baseUrl": "https://api.inferlab.io",
       "authOrigin": "https://auth.inferlab.io",
       "tenantId": "<the company's InferLab tenant id>",
       "resources": ["tables"]
     }
   }
   ```

   `company` is 2 to 31 lowercase letters and digits, no hyphen. Every worker and resource is named `inferos-<company>-…`, so the slug is the deployment's identity: never change it once deployed. `inferops.tenantId` is required: the company's InferLab tenant id, the one company this deployment serves (FAC-160). It becomes the stage's `inferops.company` and the gatekeeper's `INFEROPS_COMPANY`. A missing value, anything but a lowercase tenant id, and `internal` are refused: `internal` admits every tenant and is for InferLab's own stages only. `inferops.authorizeOrigin` (a sign-in proxy hostname) and `inferops.resources` (`tables`, `members`, `workflowPolicy`) are optional, as on the persistent stages.
2. **Do the account steps above** for the company's hostname: the account on Workers Paid holding the hostname's zone, and an Access application for the hostname (and the sign-in proxy's, if any). **And register the origin with InferLab**, in InferOps' config for that environment (`config/production.js` for prod), two entries for `https://<hostname>`:
   - in `auth.sso.inferosOrigins`, so InferLab's `inferos` sign-in client allows it;
   - in `auth.sso.inferosCompanies`, mapped to the same tenant id as `inferops.tenantId`. Without it InferOps refuses every sign-in from that origin; with a different tenant id it refuses everyone but that tenant's people.
3. **Put the inputs** in a gitignored `.inferos-deploy.vars` at the wrapper root, with the same names as the table above (`CLOUDFLARE_ACCOUNT_ID`, `STAGE_ADMINS`, and the optional ones), and **run from a clean shell**. A name the shell also sets to a different value stops the deploy, naming it, so another stage's exported account id, admin list or edge secret never deploys into this company. Values are never printed.
4. **Rehearse:** `pnpm inferos:deploy --dry-run` in the wrapper. It checks the pin, then prints the plan: every `inferos-<company>-…` worker, its vars, the secret names, the KV namespaces, the bucket and the ownership marker it will check.
5. **Deploy:** `pnpm inferos:deploy`. It refuses a dirty wrapper or pinned checkout, checks the account (below), builds, deploys the three tiers, and checks the Access redirect. Rerunning it is the update: the marker, the namespaces, the bucket and every Durable Object are kept.

**What stops two companies colliding.**

- **Names:** the prefix comes from the slug, and the slug can't contain a hyphen, so no prefix starts another.
- **Reserved:** `dev`, `prod`, `staging`, `preview`, `test`, `local` and `disposable`.
- **Hostnames:** every hostname the deployment serves, its own and its sign-in proxy's, is compared with the persistent stages'.
- **On the account, before anything is created:** the deploy reads the KV namespaces and R2 buckets, and checks each worker name it would use. A deployment's claim is one KV namespace per hostname, `inferos-<company>-owner.<hostname>`.
  - A claim for another hostname under this prefix, or for one of these hostnames under another prefix, stops the deploy, even if this deployment's own claim is there too.
  - With no claim of its own, any worker, KV namespace or R2 bucket already under the prefix stops it, as not known to be this deployment's.
  - A first deploy creates its claim and checks again, and withdraws it if a rival appeared at the same moment.
- **What's left open:** two runs racing within any delay in Cloudflare's namespace listing, and resources other tools make after the check. See [stage deploy architecture](../architecture/stage-deploy.md).

**What it needs.**

| Credential or input | Who provides it | Used for |
| --- | --- | --- |
| A Cloudflare account on Workers Paid, holding the hostname's DNS zone | The company or the operator | Every worker, KV namespace, the R2 bucket, the custom domain |
| A Wrangler login with access to that account (`wrangler login`) and `CLOUDFLARE_ACCOUNT_ID` | The person deploying | Running the deploy |
| An Access application covering the hostname | The account admin, in the dashboard | Gating the instance; the deploy only checks it |
| `STAGE_ADMINS` | The company | The instance's `/admin` users |
| The company's InferLab tenant id (`inferops.tenantId`) | InferLab | Binding the deployment to its one company |
| InferLab registering the origin in `auth.sso.inferosOrigins` and mapping it to the tenant id in `auth.sso.inferosCompanies` | InferLab (an InferOps configuration change) | "Sign in with InferLab", for that company's people only |
| Optional: `CF_ACCESS_CLIENT_ID`/`_SECRET`, `CF_AI_GATEWAY*`, `INFEROPS_EDGE_SECRET` | As above | The smoke, server-managed models, an edge-restricted InferLab |

**What it costs.** The account must be on Workers Paid (the deploy uses bundle sizes, Browser Rendering and the Worker Loader that need it): $5 a month per account at the time of writing, plus usage beyond the plan's included requests, Durable Objects, KV, R2 storage and Workers AI. Access is free up to its free plan's seat limit. The custom domain has no charge of its own, but the zone and domain are the company's. Check Cloudflare's current pricing before a deploy; this deploy adds nothing on the InferLab side but a configuration entry.

**Limits.** The wrapper's own gatekeepers and Workers (`features.customCloudflareCode`) aren't deployed yet, so such a wrapper is refused. `pnpm inferos:deploy delete --confirm <hostname>` deletes the workers as `stage:delete` does, after the same ownership check.

## Rollback and deletion

- `pnpm exec wrangler rollback --name inferos-<stage>-<package>` returns one worker to an earlier version. It never undoes a Durable Object migration, which is why the deploy refuses destructive migrations unless `--allow-destructive-migrations` is passed.
- The gatekeeper reports sanitized connected-InferOps readiness at `/gatekeeper/inferops/health/ready`; `pnpm local factory doctor stage-probe` and the authenticated stage smoke check this route. The response includes component names and statuses only. The deploy record is evidence of the selected revision and smoke outcome, not a rollback mechanism. For an application rollback, roll back affected Worker versions together and rerun the Access-protected smoke. Do not change prefixes, namespaces or Durable Object migrations during recovery.
- InferOS persistent state is held in Cloudflare Durable Objects, KV and R2; InferOps application records and jobs are held in its database. Restarting a Worker or Cloud Run revision does not itself delete those stores. In-memory work and connections are transient: let health checks recover and rerun the smoke after a restart. Do not use `stage:delete` or change a stage prefix as a restart or rollback method.
- `pnpm stage:delete <stage> --confirm <hostname>` deletes the stage's workers, router first, and with them every Durable Object (all users' Workshop data). It prints the exact KV namespaces and R2 buckets retained. It performs no export or KV/R2 deletion. For a real stage, a person must export and delete only the printed KV/R2 names in the matching Cloudflare account.
- Never change a stage's `workerPrefix` or `resourcePrefix` in `scripts/stage/stages.ts`: the next deploy would create a new, empty instance and abandon the old one.

## Configuration, restart and recovery

- **InferOS stage configuration:** `.stage-<stage>.vars` or the shell supplies non-secret deploy variables such as `CLOUDFLARE_ACCOUNT_ID`. Wrangler secret inputs such as `STAGE_ADMINS`, `INFEROPS_EDGE_SECRET` and optional `CF_AI_GATEWAY_*` values are uploaded as secrets; the deploy plan and deploy record name secrets but never print their values. Keep secret values in the approved secret store or ignored local vars file. Do not put them in this runbook, command transcripts or a generated checked-in config.
- **InferOps configuration:** the service selects its config with `NODE_CONFIG_ENV`; environment config files are combined with the encrypted `config/<environment>.sops.json` layer, and runtime secret environment values come from Google Secret Manager (`secretEnvs`). Treat those files and secret values as separate from InferOS Wrangler vars/secrets. Record names and the selected environment only. Never copy a decrypted config between worktrees or include values in deploy evidence.
- **Cloudflare recovery:** identify the affected stage and Worker, inspect the deploy record, then use the Cloudflare dashboard's Workers & Pages deployment history to send traffic back to the known-good version. Coordinate the router and affected gatekeepers/backend as one compatible set, then verify the Access redirect and run the protected smoke. A Worker rollback does not reverse Durable Object migrations; do not roll back across a data migration without an owner-approved compatibility plan. Leave KV, R2, Durable Object names and prefixes intact.
- **InferOps Cloud Run recovery:** identify the project, region, service (`inferlab-api` or `inferlab-worker`), and known-good revision from the deployment record and Cloud Run revision history. In Cloud Run, route traffic back to the known-good revision for the affected service, then check readiness and the stage's connected-InferOps readiness route. Coordinate API and worker revisions when they share a release. Cloud Run revision rollback does not roll back database migrations; confirm schema compatibility before shifting traffic. Do not delete services or database resources as a restart step.
- After either cloud recovers, record the revision(s), time, readiness result and smoke result. If the stage remains unavailable or the data/schema compatibility is unclear, stop before changing persistent resources and escalate to the service owner.

## Limits

- Only `gatekeeper-inferops`, `gatekeeper-context`, `gatekeeper-scheduler` and `gatekeeper-mcp` are deployed; the others need OAuth apps a stage does not configure.
- No CI job deploys a stage, and two people deploying one stage at once are not prevented.
- Wrapper gatekeepers are not packaged; a stage is this checkout.

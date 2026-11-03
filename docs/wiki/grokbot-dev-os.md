---
title: Set up the grokbot tenant for dev-os
updated: 2026-11-02
---

# Set up the grokbot tenant for dev-os

How to give a person or an external test agent (Grok Bot) a working InferOps sign-in on
`https://dev-os.factorylevel.dev`, using the reserved `grokbot` tenant on dev InferLab. Deploying the
stage itself is in [deploy a persistent stage](stage-deploy.md). The smoke that drives these personas
is described in [factory](../architecture/factory.md#grok-bot-persona-contract-and-acceptance).

## The tenant

`grokbot` is one of InferOps' reserved tenants (`GROKBOT` in InferOps
`domain/ts/portal/shared/reserved-tenants.ts`). Unlike the other reserved tenants it is
**persistent**: the weekly develop refresh keeps every row it owns, including boards, issues, Wiki
pages and sessions (`infra/pii-anon-sync/src/reserved.ts`). The refresh never *creates* a seat.

| Workspace | Product | Id | Reference |
| --- | --- | --- | --- |
| `grokbot.operations` | InferOps | `00000000-0000-4000-8000-000000000c11` | board `inferops://grokbot.operations/project/board/GROK` |
| `grokbot.knowledge` | InferMind | `00000000-0000-4000-8000-000000000c12` | Wiki `inferops://grokbot.knowledge/knowledge/wiki` |

| Persona | Operations / knowledge role | Seat email | Used for |
| --- | --- | --- | --- |
| `grokbot-owner` | owner / owner | `owner@grokbot.inferlab.dev` | Sign-in, Wiki, Kanban, simulate, approve and restore |
| `grokbot-power` | admin / admin | `power@grokbot.inferlab.dev` | Build collaborator; never the negative test |
| `grokbot-operate` | member / viewer | `operate@grokbot.inferlab.dev` | Its own sign-in and Wiki reads; a knowledge write must be refused |

Personas sign in only because dev InferLab runs in stub auth. Prod has no persona sign-in, and there
the seats are inert placeholders.

## Seed or re-seed the tenant

In factory-level/inferops, run Actions → **Seed reserved tenants (dev)**
(`.github/workflows/seed-reserved.yml`, manual dispatch). It converges every reserved row by its
fixed id against the dev database only. Run it after a seat is added, or when sign-in says a persona
"is not seeded here". It writes to the shared dev database, so get the owner's OK first. Never seed
prod for this; prod's reserved seeding is a separate, gated lane.

## Check dev-os prerequisites

Check these in order. Each one, when missing, breaks sign-in in a different way.

1. **Stub auth.** `curl -s https://api.dev.inferlab.io/auth/public-config` names mode `stub`.
   Otherwise the persona picker does not exist.
2. **Origin registered.** `https://dev-os.factorylevel.dev` is in `auth.sso.inferosOrigins` in
   InferOps `config/development.js`. Otherwise InferLab refuses "Sign in with InferLab".
3. **Edge secret.** `INFEROPS_EDGE_SECRET` is deployed on `inferos-dev-gatekeeper-inferops` and
   equals InferOps' `waf:inferosEdgeSecret` ([edge secret](stage-deploy.md#inferlab-edge-secret)).
   Otherwise sign-in and every InferOps call get a 403.
4. **Cloudflare Access.** The `dev-os.factorylevel.dev` Access application covers both
   `dev-os.factorylevel.dev` and `auth.dev-os.factorylevel.dev`. Its policies:
   - `dev-os.factorylevel.dev-allow`: the `platform-admins` group (the people who run the stage).
   - One Allow policy per test agent, each naming one mailbox (a `+alias` counts as a separate
     address), so Access logs say which agent signed in. Today: `grokbot-owner`, `grokbot-power`,
     `grokbot-operate`.
   - The `inferos-dev-smoke` service token (Service Auth), used by the smoke.
5. **Stage admins.** `STAGE_ADMINS` in `.stage-dev.vars` lists everyone who needs `/admin`. It
   takes effect on the next `pnpm stage:deploy dev`.

## Sign an agent in

1. Open `https://dev-os.factorylevel.dev` and pass Access with the agent's own mailbox.
2. Choose "Continue with InferOps". The popup opens the persona picker on
   `auth.dev-os.factorylevel.dev`.
3. Choose the persona, finish onboarding, then connect the InferOps account from the same picker.
4. Open the GROK board or the Wiki by the references above.

**Switching persona.** Every sign-in, connect and reconnect through `auth.dev-os` starts by ending
the InferLab session that host holds, so the picker is shown each time
([sign-in proxy](../architecture/inferops-gatekeeper.md#sign-in-proxy)). Reconnecting the account
as another persona replaces its session. A dev-os deploy from before 2026-11-02 reuses the last
persona without asking: open `https://auth.dev-os.factorylevel.dev/logout` in the same browser
first, then reconnect.

**Signing in as yourself with Google.** The same page's "Continue with Google" works through
`auth.dev-os` once three things hold: dev InferLab lists `https://auth.dev-os.factorylevel.dev` in
`auth.sso.proxyOrigins` (factory-level/inferops#2528), dev's Google OAuth client (inferlab-dev) has
`https://auth.dev-os.factorylevel.dev/auth/oauth/callback/google` as an authorized redirect URI, and
the Google account is already a user in dev InferLab (a first Google sign-in creates no account).
Without the first, Google sends the browser to `auth.dev.inferlab.io`, which dev's edge refuses;
without the second, Google itself refuses the sign-in with `redirect_uri_mismatch`.

## Check the data

The seed creates the seats and workspaces but no project and no Wiki page. Check read-only as each
persona against `https://api.dev.inferlab.io`:

1. `POST /auth/inferlab-login` with `{"personaId":"grokbot-owner","product":"inferops","transport":"bearer"}`
   gives a token. Send it as `authorization: Bearer <token>` with
   `x-workspace-id: <workspace id>` on the reads below.
2. `GET /project/board-snapshot?ref=inferops://grokbot.operations/project/board/GROK` returns
   the board.
3. `GET /knowledge/documents` (knowledge workspace id) lists at least one page.

If something is missing, create it as `grokbot-owner`, and only with the owner's OK for dev writes:

- **GROK project:** `POST /project/projects` `{"name":"Grokbot QA","identifier":"GROK"}` with the
  operations workspace id. InferOps seeds both workflow ladders. A `409` means it already exists.
- **Wiki page:** `POST /knowledge/documents` `{"slug":"grokbot-qa-handbook","title":"Grokbot QA Handbook"}`
  with the knowledge workspace id, then `PATCH /knowledge/wiki/pages/<its id>` with an
  `x-idempotency-key` and `{"expectedVersion":1,"body":"<markdown>"}`.

## Run the smoke

From a shell that holds only `PATH`, `HOME`, `USER`, `LANG` and `TERM` plus
`FACTORY_STAGE_URL=https://dev-os.factorylevel.dev`, `GROKBOT_PERSONA_USER=grokbot-owner`,
`GROKBOT_OPERATE_USER=grokbot-operate` and `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`
(sourced from a mode-600 vars file, never printed), run `pnpm local factory doctor stage-probe`.
Once every line is READY, run `pnpm local factory stage-smoke`. The `factory-sandboxes` skill
(`.agents/skills/factory-sandboxes/SKILL.md`) has the full procedure.

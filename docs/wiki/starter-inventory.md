---
title: Upstream starter inventory and provenance
updated: 2026-10-03
---

# Upstream starter inventory and provenance

This page lists the operator flow in Cloudflare's deployment starter, the InferOS command that covers each step (or why the step was not adopted), and the starter's licence and provenance. It is the inventory and licence review that #18 asks for in its first box.

## Source inspected

| Item | Value |
| --- | --- |
| Repository | [`cloudflare/cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter), described as "A guide for customizing your Cloudflare OS deployment" |
| Commit inspected | `3d211477ad009e13a98d863d843e5c12a29ad02b` on `main` (2026-08-19, "Align with upstream tooling and enable AI Gateway by default"), read on 2026-10-03 through `gh api` |
| Licence | Apache License 2.0 (`LICENSE` at that commit, also reported by the GitHub licence API) |
| Files read | `README.md`, `docs/customization.md`, `docs/migrate-from-hosted.md`, `.agents/skills/cloudflare-os-operator/SKILL.md` and its `references/upgrade-and-rollback.md`, `package.json`, `.gitmodules`, `deployment.jsonc`, and the outline of `scripts/deploy.ts` and `scripts/deployment-config.ts` |

The starter is a wrapper repository. It pins `cloudflare/cloudflare-os` as the `cloudflare-os` submodule, keeps deployment settings in `deployment.jsonc`, and runs `scripts/deploy.ts`. That script derives temporary Wrangler configs from upstream base configs, builds the frontend in Cloudflare Access mode, deploys the Workers in dependency order, and removes the generated files afterwards. It ships two wrapper-owned packages, `packages/custom-gatekeeper` and `packages/error-reporter`, and an agent skill, `cloudflare-os-operator`.

## Operator flow and InferOS coverage

The starter's README gives four steps, and its operator skill expands them into a twelve-step workflow. Both are listed below in their order.

| Starter step | What it does | InferOS equivalent | Status |
| --- | --- | --- | --- |
| Locate the starter, read current sources | The skill checks for the marker files (`deployment.jsonc`, `scripts/deploy.ts`, `cloudflare-os/`, `packages/custom-gatekeeper/`) and reads them before making any change | `.agents/skills/bootstrap-inferos/SKILL.md`. A wrapper is recognised by `.inferos/bootstrap.json` | Adapted |
| Establish provenance | Records the root and submodule commits, tool versions and target account | `pnpm inferos:check` reports the pinned `revision`, `modifiedUpstream`, the package manager and where each setting came from. `pnpm run doctor` checks Node, pnpm, the native scripts, build tools and the port | Adapted, without account or cloud fields |
| Prepare the workspace | `git submodule update --init`, `pnpm install`, `pnpm --dir cloudflare-os install`, `wrangler login` | `node scripts/consumer/bootstrap.ts <dest> <repo> <full-sha>` creates the wrapper with the submodule at that exact SHA. `pnpm run setup` installs with a frozen lockfile. No `wrangler login`, because nothing deploys | Adapted |
| Collect decisions, fill in `deployment.jsonc` | Account ID, Worker names, hostname, Access audience, admin emails, storage, AI, observability | `inferos.config.json`: profile, feature flags, `capabilities`, styling, `local.port` and the `inferops` target. Generating a wrapper from a reviewed customer intake (`pnpm inferos intake apply`) is in open PR #116 and not yet on `main` | Adapted for local settings only |
| Configure Cloudflare Access and routing | Self-hosted Access application, hostname or `workers.dev` route | None. Local sign-in is the Workshop's own login, and InferLab sign-in comes through the InferOps gatekeeper (`INFEROPS_AUTH`) | Not adopted |
| Configure AI | AI Gateway over the `WORKERS_AI` binding, optional providers | None at the wrapper level. Local model setup is the upstream Workshop's (`pnpm dev:setup`, scripted mock model) | Not adopted |
| Review the custom gatekeeper | `packages/custom-gatekeeper`, bound as `GATEKEEPER_CUSTOM` on the Workshop and router | The wrapper's `gatekeepers/` directory, checked by `pnpm gatekeepers:check` and given generated configs by `pnpm gatekeepers:generate`. This fork's own gatekeeper lives in `custom-gatekeepers/gatekeeper-inferops` | Adapted |
| Code extensions | Prefer wrapper-owned Workers and service bindings over patching the submodule | `inferos.extensions.json` plus `workers/<id>/cloudflare.config.ts`, enabled by `features.customCloudflareCode` and checked by `pnpm extensions:check`. When enabled, each one is served at `/extensions/<id>`, and the route returns 404 when disabled | Adapted (#36) |
| Observability and error reporting | Private Error Reporter Worker and structured logs | None in the wrapper. The upstream `@gadgets/observability` logger and the optional `ERROR_REPORTER` binding are unchanged | Not adopted |
| Validate locally (`pnpm check`) | Validates `deployment.jsonc` and the derived configs without deploying | `pnpm inferos:check`, `pnpm run doctor`, `fixtures:check`, `views:check`, `blueprints:check`, `extensions:check`, `gatekeepers:check` and `skills:check` | Adapted |
| Approve and deploy (`pnpm deploy`) | Mutation summary, operator approval, ordered `wrangler deploy` | Local only: `pnpm dev`, or `pnpm local start` / `stop` / `status`. Consumer cloud deployment is post-release | Not adopted (out of MVP scope) |
| Branding in `/admin` | Site name, logo and accent colour without a redeploy | `pnpm profile:init` applies `styling` (site name and theme) to the local deployment. `/admin` stays available | Adapted |
| Verify the live deployment | Sign-in, admin, Context, custom gatekeeper observation, Scheduler, logs | `pnpm local seed` and `pnpm local verify` (sign in, read the demo board through the gatekeeper, reach the approval queue) on the local stack. Evidence lives in [local verification evidence](local-verification-evidence.md) | Adapted for local only |
| Close out, rollback | Sanitised operation record, Workers rollback | None. Cloud rollback is not applicable without a cloud deploy | Not adopted |
| Pinned submodule upgrade | Record the gitlink, update it, review base configs, re-sync the `catalog:` entries, lint, check, deploy | `bootstrap.ts` refuses to change an existing wrapper's pin ("bootstrap does not perform upgrades"). Reviewed upgrade and recovery automation is #20 | Not adopted yet (backlog) |

## Why the differences

- **Local-first MVP.** The #1 MVP is a private local shell with InferOps Kanban and the InferMind Wiki. Cloud deployment, Access, AI Gateway and Workers rollback belong to the post-release cloud-parity work (#11), so the steps that need a Cloudflare account were left out.
- **Atomic, rerunnable scaffolding.** The starter is a template that operators clone and edit. InferOS instead generates the wrapper with a script: it stages the wrapper and moves it into place, refuses a non-managed destination, and leaves existing edits alone on a rerun. #18 needs this so that several coding harnesses can drive the same flow.
- **Explicit opt-in for wrapper Workers.** The starter's deploy script always binds its custom gatekeeper, and an administrator then enables it in `/admin`. InferOS gates wrapper Workers and gatekeepers behind `customCloudflareCode` and an explicit manifest, and a flag never grants an agent filesystem or deployment authority.
- **One submodule install.** The starter installs the submodule as its own pnpm workspace and also makes two submodule packages members of its root workspace. That is why it must re-sync `catalog:` on every upgrade. InferOS runs the pinned checkout's own scripts against its own lockfile instead.

## Provenance of InferOS code

The following was checked on 2026-10-03 against `factory-level/inferos` at `a38ac8b1bd9a1a68926466f0b099ee723c20043c`:

- `git grep` finds no starter-specific identifiers in tracked files: `cloudflare-os-operator`, `deployment.jsonc`, `CustomSessionImpl`, `getDeploymentInfo`, `GATEKEEPER_CUSTOM`, or headings from the operator skill such as "Locate The Starter", "Read Current Sources First" and "Hard Stops".
- The starter is mentioned only in the upstream `README.md` (a link inherited from `cloudflare/cloudflare-os`), [`research-sources.md`](research-sources.md), and the [repository setup architecture](../architecture/repo-setup-skills.md).
- `git log -S"cloudflare-os-starter" --all` finds only upstream README commits and two InferOS documentation commits (`882d870`, `12763da`). No code commit introduced starter content.

No starter source code or documentation text was found copied into InferOS. The scaffolder, wrapper runtime and bootstrap skill were written in this repository. The starter shaped the wrapper and submodule pattern and the operator checklist. If starter code is copied in the future, Apache-2.0 requires keeping its copyright and licence notice and marking modified files.

## Open Questions

- Should consumer cloud deployment follow the starter's derive-then-delete Wrangler approach or the upstream release manifest (`scripts/release/`)? This is undecided and tracked with #11 and #20.

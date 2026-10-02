---
title: InferOS repository setup skills
status: draft
updated: 2026-10-02
---

# InferOS repository setup skills

Tracking epic: [#5](https://github.com/factory-level/inferos/issues/5); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Let a coding agent configure and maintain a consuming repository with a ready-to-customize local environment and explained deployment settings.

## Requirements

- Own the skills in InferOS and make them usable across coding harnesses; no Harness HG dependency.
- Bootstrap the selected wrapper plus pinned submodule layout and preserve wrapper-owned changes on reruns.
- Explain each setting’s owner, requirement condition, source, default, secret classification and local/cloud differences.
- Drive deterministic scripts for mutations and validation; skills describe orchestration and recovery rather than hiding executable configuration in prose.
- Include setup, configure, verify, upgrade and recovery tasks with explicit evidence and no credential dumps.

## Behavior

A skill inventories the consuming repository, records chosen upstream revision and configuration, shows missing inputs and creates only the necessary wrapper files. It runs the native local lifecycle, opens a synthetic board fixture and reports readiness evidence. Configuration separates identity policy, admin customization, model access, gatekeeper credentials, resource bindings and deployment secrets. Upgrades compare pinned revisions and migration/config differences before changing the submodule; verify follows every upgrade. Recovery diagnoses config drift, missing resources, port conflicts and stale local state with bounded commands.

## Non-Goals

No live deployment merely because setup ran; no global coding-agent installation or unrelated repository rewrite.

## Acceptance and delivery

### Create InferOS-owned wrapper bootstrap skill and deterministic scaffolder

Tracking issue: [#18](https://github.com/factory-level/inferos/issues/18) (`skills-bootstrap`).

- Inventory and adapt the upstream starter operator flow with provenance/license review.
- Generate wrapper-owned configuration, gatekeeper/blueprint extension locations and a pinned InferOS submodule.
- Operate through scripts usable by multiple coding harnesses; preserve existing files and explain conflicts.
- Test fresh clone, rerun, nonempty wrapper and incompatible pin without deploying resources.

### Explain and validate required local and deployment settings

Tracking issue: [#19](https://github.com/factory-level/inferos/issues/19) (`skills-settings`).

- Provide a settings schema/reference covering identity, admin, model, gatekeeper, storage, router and observability configuration.
- Mark secret/nonsecret, owner, default, conditional requirement and local versus cloud source for each input.
- Validate missing/contradictory values and redact secrets in diagnostics.
- Test optional gatekeepers, no-OAuth deploy inputs, invalid auth configuration and explicit remote mode.

### Add verify, upgrade and recovery skills for consuming repositories

Tracking issue: [#20](https://github.com/factory-level/inferos/issues/20) (`skills-maintenance`).

- Run lifecycle/parity evidence from the wrapper and report machine-readable failures.
- Upgrade the pinned submodule with config/migration review and preserve custom extensions.
- Document rollback limits for stateful migrations and recover local config/ports/fixtures safely.
- Exercise a fresh clone and upgrade fixture end to end without production side effects.

## Open Questions

- How much of the upstream starter operator skill can be reused verbatim under its license and version contract?
- Which machine-readable configuration schema best prevents divergence between explanations and executable defaults?

## Related

- [Current architecture](../architecture/repo-setup-skills.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)

## Wrapper-owned blueprint sources

Bootstrap copies standard format sources into the wrapper once. Local startup uses the wrapper as the complete `BUNDLED_BLUEPRINTS_DIR`, while empty legacy wrappers retain upstream defaults. Validation uses the pinned compiler without modifying generated backend files. Upgrades preserve consumer edits and require explicit reconciliation of copied upstream templates. Source-content, presentation or revision changes update installed templates; existing gadgets and admin curation are not reset. A consumer cloud-release wrapper must eventually carry the same source selection into release artifacts.

## Skill packs and skill upload

Wrappers carry two kinds of skills, linked by one convention:

- **Coding-agent skills** live in `.agents/skills/<name>/`. Bootstrap ships `bootstrap-inferos` and `skill-upload`. Third-party skills install with the skills.sh (`skills`) CLI at a pinned version, through `pnpm skills:install [source --skill name]`. Anthropic's `skill-creator` is the default. The CLI records installs in `skills-lock.json` and links agent-specific directories such as `.claude/skills`.
- **Runtime skills** for the Workshop agent live in `skills/<pack>/<name>/SKILL.md`. `inferos.skills.json` maps each pack to one public Context Library collection. A pack's `include` list publishes installed coding-agent skills without a second copy, so `build` includes `skill-creator`. `exclude` globs keep skill-creator's eval and workspace output out of the collection.

New wrappers are preloaded with three packs:
- **operate**: InferOps boards, issues and approvals.
- **build**: gadgets, views, blueprints and skills.
- **shared**: conventions every agent follows.

Each pack starts with editable starter skills, which the wrapper owns from then on, the same as `blueprints/`.

`pnpm skills:check` validates packs offline with the Context Library's own frontmatter rules (an invalid `SKILL.md` would otherwise be skipped silently), along with path and size limits and unique names across packs. `pnpm skills:upload [pack...] [--dry-run] [--prune]` publishes packs to the local Workshop:
- It uses the same administrator session and localhost-only rule as `profile:init`.
- It finds each collection by title and creates it if missing.
- It writes only changed files.
- It reports remote-only files, and deletes them only with `--prune`.
- It confirms every `SKILL.md` was indexed.

The `skill-upload` agent skill drives this flow, including authoring new skills with skill-creator. It does not hide any configuration in prose.

Uploading to deployed instances waits on a deployment-origin authentication contract. Preloading is the explicit `skills:upload` step after `profile:init`, not an automatic part of `pnpm dev`.

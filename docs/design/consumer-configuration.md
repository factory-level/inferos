---
title: Consumer configuration, profiles and durable views
status: draft
updated: 2026-10-02
---

# Consumer configuration, profiles and durable views

Tracking: [configuration and flags #33](https://github.com/factory-level/inferos/issues/33), [durable views #34](https://github.com/factory-level/inferos/issues/34), [profiles/style #35](https://github.com/factory-level/inferos/issues/35), [custom Workers #36](https://github.com/factory-level/inferos/issues/36).

## Purpose

Make a forkable consuming repository semi-configured for InferOps operations: pinned platform, explained settings, synthetic domain data, selectable views, profile/style defaults and wrapper-owned Cloudflare extensions. Success requires these settings to affect running behavior, not merely exist in a JSON file.

## Requirements

- `inferos.config.json` is a versioned, nonsecret consumer contract. Validate unknown keys, types, version, Git pin, URL credentials and incompatible flags before starting or deploying.
- The wrapper owns its files and custom code; `inferos/` is a pinned submodule. A bootstrap rerun preserves edits and does not perform an implicit upgrade.
- Explicit flags are `composableViews`, `durableViews`, `customCloudflareCode` and `inferlabLogin`. Base defaults are false. The operations profile enables composable and durable layouts; custom Cloudflare code and InferLab sign-in remain opt-in, because profiles never change authentication policy. New wrappers materialize these resolved defaults explicitly. Board data and agent view adapters remain pending.
- `durableViews` requires `composableViews`. Reject an incompatible combination instead of silently enabling a dependency. Flags are deployment choices, never credentials or permission grants.
- Resolve defaults → selected profile → explicit wrapper overrides and report provenance. Existing Flagship rollout resolution must remain separate from structural installation capabilities: a rollout cannot activate a feature absent from the installation.
- Enforce disabled features at server operation boundaries as well as UI discovery. Account, tenant, workspace and project authorization is always enforced independently.
- The bootstrap includes an InferOps project/board fixture with canonical field names and string revisions. Runtime data mode selects either fixtures or an explicit external InferOps endpoint; remote credentials are never committed.

## Behavior

### Bootstrap and data model

A fresh wrapper contains `inferos.config.json`, the exact submodule gitlink, a package manager pin, local commands and extension directories. The initial synthetic board describes projects, workflow states, issue cards, priorities and decimal-string revisions. This is a transport fixture, not a second production database. The typed gatekeeper remains the boundary to canonical InferOps transactions.

The initial source reference is `inferops://demo.local/project/board/DEMO`. A reference identifies a target and does not authorize it. A remote endpoint requires the gatekeeper account/scope contract before it can be used. Contract drift is checked against the upstream InferOps schema in integration fixtures; do not indefinitely maintain a divergent DTO copy.

### Composable views

When enabled, users and agents can add registered widget instances, edit schema-validated parameters, move them among ordered sections/columns and choose curated sizes. Renderer-owned Kumo styling keeps views consistent. No arbitrary CSS, scripts or unregistered renderers enter the composition operation. With durable views disabled, an explicitly temporary view remains session-local and is labeled unsaved; reload discards it rather than implying persistence.

### Durable views

When enabled, persist a versioned definition with stable view/widget IDs, owner, sharing policy, resource references, parameters, order/layout and revision. Transactional rows remain in InferOps. Authorize both the saved view and every bound resource on load; possession of a view ID is not resource authority.

Create/update/share/delete operations use existing native capabilities and expected revisions. Concurrent changes produce an actionable conflict. Recovery must cover browser disconnect, process restart, deployment update and supported schema migration. Export contains definition and binding requirements only; import rebinds authority. Private personal pins remain private unless the user explicitly imports/shares a new definition.

Disabling durable views preserves saved definitions while denying the disabled surface's reads and mutations. Re-enabling exposes only currently authorized definitions. Explicit deletion and retention policy are separate operations. Undo restores composition revisions; it does not reverse domain transactions behind the user's back.

### Profiles and styling

`personal` and `inferops-operations` are initial profile names. A profile selects defaults for offered components, starter views, instructions and semantic appearance; later vertical profiles compose the same schema. It never changes authentication policy, grants a resource or asserts ambience.

Initial styling fields are `siteName`, `density` (comfortable/compact) and `theme` (system/light/dark). Additional branding must map to existing AdminConfig/Kumo semantics after review, not an arbitrary style object. The explicit post-login `profile:init` step initializes site name, instructions, fallback theme and listing density once through the administrator capability. Existing custom values are preserved. Compact density reduces desktop workspace-row and Explore card/list spacing; mobile spacing and gadget-owned layouts remain unchanged. Later administrator edits are authoritative unless an explicit configuration update resolves the difference. Rerun/upgrade cannot silently reset branding or profile changes.

### Custom Cloudflare code

`customCloudflareCode` enables an explicit wrapper extension manifest. Each entry names a canonical Worker config, service bindings, routes, required inputs, migrations and local fixture strategy. Wrapper paths must stay inside the wrapper, names/routes/bindings must not collide, and library packages must remain nondeployable. Generated Wrangler configuration is derived from canonical definitions for both local and cloud execution.

This is trusted deployer code. An agent composing a view cannot enable the flag to acquire filesystem, service-binding or deployment authority. The gatekeeper and Gadget boundaries remain in force. Disabling the feature stops activation while preserving source files.

## Non-Goals

No generic entity database, automatic copying of a live InferOps tenant, unrestricted styling, implicit production deploy, or claim that a native Workshop launch has already validated the full consumer experience.

## Open Questions

- Complete resource binding and agent integration on the existing native workspace definition store.
- Resolve external InferOps authentication and credential storage through the gatekeeper contract.
- Define profile migrations and field-level ownership between declarative initialization and later AdminConfig edits.

## Related

- [Current implementation](../architecture/consumer-configuration.md)
- [Bootstrap usage and limitations](../wiki/consumer-bootstrap.md)
- [Canvas design](inferops-canvas.md)
- [Setup skills](repo-setup-skills.md)

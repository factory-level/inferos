---
title: Bootstrap a consuming repository
updated: 2026-10-01
---

# Bootstrap a consuming repository

Create a wrapper with pinned InferOS code and explicit InferOps/profile/feature configuration. The command currently establishes a cloneable development baseline; the full operational canvas remains tracked work.

## Steps

Run from this InferOS checkout with Node 22.18 or later:

```bash
node scripts/consumer/bootstrap.ts /tmp/my-inferos https://github.com/factory-level/inferos 02d6d3b2327904426e0c190caf559f5741bee419
cd /tmp/my-inferos
pnpm inferos:check
pnpm run setup
pnpm run doctor
pnpm blueprints:check
pnpm fixtures:check
pnpm dev
```

The example pins the consumer implementation, not a moving branch. Select a reviewed commit from your own fork when appropriate. For local development/testing, supply an absolute local Git repository path instead of the HTTPS URL. The destination must be new or an existing wrapper created by this command. The command does not overwrite an arbitrary existing repo.

Review and commit the wrapper files and staged gitlink before publishing it. Another developer can then use `git clone --recurse-submodules` on the wrapper. Use the wrapper's pinned pnpm version. `.dev.vars` and local state remain uncommitted.

## Generated contract

| File | Meaning |
| --- | --- |
| `inferos.config.json` | Versioned nonsecret inputs, exact upstream revision, profile, feature flags, style and local port |
| `inferos/` | Pinned Git submodule |
| `.inferos/runtime.ts` and `config.ts` | Standalone operator and validation helpers copied from this version |
| `.agents/skills/bootstrap-inferos/SKILL.md` | Agent setup guidance copied into the consuming repository |
| `views/operations.json` | Guarded starter composition; import it from the workspace Canvas dialog on supporting pins |
| `fixtures/project-board.json` | Synthetic projects/states/issues using the InferOps board wire fields |
| `blueprints/` | Editable copies of the pinned standard formats; the complete local format set |
| `gatekeepers/`, `profiles/` | Wrapper-owned customization locations; runtime adapters remain pending |
| `package.json` | Pinned package manager and check/setup/doctor/blueprints:check/profile:init/dev entrypoints |

## What check proves

`pnpm inferos:check` validates settings, the actual submodule HEAD and the wrapper's staged gitlink. It reports `pending` adapters and `modifiedUpstream`. A true modifiedUpstream means the run includes local experiments and is not an exact-pinned-revision proof. An `ok` result proves configuration/pin consistency only; it is not proof that data/views/style are applied or that a server is healthy. A pin mismatch must be resolved deliberately, not bypassed by editing the validator.

Flags are `composableViews`, `durableViews` and `customCloudflareCode`. Durable views require composable views. Pins containing the Canvas dialog support `composableViews` locally; `durableViews` additionally requires the native canvas store. The launcher passes both switches to the backend, whose public configuration controls the builder UI. Unsupported pins fail startup explicitly. Pins containing the custom Worker adapter support `customCloudflareCode` locally. This prevents a config file from falsely advertising running features.

## Local preflight

`pnpm run doctor` emits JSON and exits nonzero when configuration/pins, required native scripts, the pinned pnpm version, local build-tool resolution, port availability or requested unsupported features prevent startup. It does not install dependencies or start Workers. A dirty submodule is a warning rather than a rejection so intentional local experiments remain possible.

`ok: true` means the local preflight passed. `runtimeReady: false` explicitly records that the complete InferOps experience remains pending. Neither field proves application health, provider access or cloud parity. The dependency check resolves local tools; `pnpm run setup` and the native builds still validate the complete dependency graph. A port check does not reserve the port, and an already running server produces a conflict rather than being terminated. Doctor is for pre-start diagnosis, not a running-service health endpoint.

The native launcher at the example pin uses `pnpm install --frozen-lockfile` so starting development cannot silently rewrite dependency resolution. A consumer pinned to an older revision retains that revision's launcher behavior.

## Customize native applications

New wrappers copy the pinned standard blueprint sources into `blueprints/`. Edit these files in the wrapper, or add a directory containing `blueprint.json` and `files/` using the pinned bundled-blueprint format. `pnpm blueprints:check` runs the pinned native compiler and archive validation with a temporary output, so it does not overwrite the backend's generated module. This validates packaging and imports; it is not a TypeScript type check or a test of the application's behavior.

`pnpm dev` selects the wrapper directory through `BUNDLED_BLUEPRINTS_DIR`. It is the complete format set, not an additive overlay. Keep the copied standard formats if you still want them. A legacy wrapper whose blueprint directory is missing or contains only hidden files/README retains the upstream defaults. This fallback means an empty directory cannot currently request zero formats. The wrapper setting takes precedence over any inherited `BUNDLED_BLUEPRINTS_DIR`.

After editing, restart development. The native installer detects source-content and presentation changes as well as `revision` changes and refreshes the installed template on the next `/api` request; increment `revision` when publishing a reviewed template release. In either case, existing gadget instances retain their own code and administrator format-curation edits remain authoritative. Removing a directory changes the next bundle, but is not an instruction to delete previously installed templates or gadgets. Bootstrap reruns never overwrite customizations, and upgrades must explicitly reconcile copied standard formats with upstream changes.

These are ordinary sandboxed Gadget blueprints, not custom Cloudflare Workers. They do not enable `customCloudflareCode`, bypass gatekeeper grants or implement the planned InferOps canvas. Cloud release commands must receive the same absolute `BUNDLED_BLUEPRINTS_DIR` explicitly until a consumer release wrapper is implemented.

## Initialize the local deployment profile

A reviewed pin containing `initialize-consumer-profile.ts` supports `pnpm profile:init`. First start the local server, sign in as a deployment administrator, and obtain that local origin's `authToken` from browser DevTools → Application → Local Storage. Supply it as an environment variable for the command, not as a command-line argument or committed setting. For Bash, prompt without echoing or recording the value in shell history:

```bash
read -rs -p 'Local admin session: ' INFEROS_ADMIN_SESSION
export INFEROS_ADMIN_SESSION
pnpm profile:init
unset INFEROS_ADMIN_SESSION
```

The command applies the configured `styling.siteName` (maximum 40 characters), instructions selected by `profile`, and the fallback theme from `styling.theme`. It connects only to the configured local port. Results are `initialized`, `preserved` (existing name, instructions or non-system theme won), or `already-initialized`. Reruns do not update settings; use the normal admin UI for later name/instruction changes, or the admin API for the default theme. Reload the Workshop to pick up branding. The initialization marker lives with the authoritative settings, not in a wrapper file, so a wrapper rerun or changed config cannot reset it.

This initializes branding, instructions and the deployment fallback theme. Pins containing the density extension also initialize curated listing spacing: compact reduces desktop workspace-row and Explore card/list spacing. Mobile touch targets and gadget-owned layouts remain unchanged. Starter views, remote InferOps data and profile-specific component catalogs remain pending. Cloud application needs a separate explicit deployment-origin contract.

## Theme preference precedence

The deployment theme is a fallback, not an enforced setting. A browser's saved `light`, `dark` or explicit `system` preference wins. Without a valid saved preference, the browser uses `ServerConfig.defaultTheme`, falling back to `system` on older deployments or before config loads. Choosing a theme keeps that choice for the session even if local storage is unavailable. A deployment fallback is never written into the browser's preference storage.

`AdminApi.setDefaultTheme` updates the persisted deployment default for the next client connection; a dedicated admin-panel control remains pending. This uses the existing Kumo light/dark palettes and applies through the root `data-mode` and native-control color scheme. It does not change custom blueprint styling or introduce a new color system. Before server config arrives, a new browser may briefly display its system theme.

## Current limits

`dev` launches native Workshop through run-local. It does not yet load the included InferOps fixture into board widgets or automatically initialize the profile. Supporting pins persist compositions in the native workspace store when both view flags are enabled. It uses the pinned native runner's local state and asset-serving behavior. The example pin includes a router asset-parity fix; an older pinned revision does not gain that change automatically. `dev` checks the selected local port before building and asks you to choose another port if it is occupied. Full setup/read/propose/approve/refresh evidence, lifecycle controls and cloud parity remain in [the roadmap](implementation-roadmap.md).

The tests cover fresh creation, recursive clone, paths with spaces, customized rerun, revision drift, Git failure cleanup and all flag combinations. No cloud deployment or live provider login is performed by bootstrap or those tests.

## Custom Cloudflare Workers in local development

New wrappers include `inferos.extensions.json` and a disabled `workers/hello` example. Set `features.customCloudflareCode` to true, run `pnpm extensions:check`, then `pnpm dev`. The example returns JSON at `/extensions/hello`. `extensions:check` executes trusted canonical config modules and writes generated `wrangler.consumer.jsonc` files; review that code before running it. A disabled flag does not read the manifest or import its configs. Disabling it and restarting removes activation while retaining source and local state.

The v1 manifest is `{ "schemaVersion": 1, "workers": [{ "id": "hello", "directory": "workers/hello" }] }`. IDs are unique lowercase hyphenated slugs; directories and entrypoints stay under the wrapper's `workers/`. Each entry requires `cloudflare.config.ts`, whose Worker name is `consumer-<id>`. The generated config uses the same canonical converter as native Workers and retains bindings/migrations. Never edit generated configs. Only explicit entries are activated; library directories are not discovered automatically.

The native multi-Worker launcher binds each entry to the router as `CONSUMER_<ID>` and sets its deployer-owned enable switch. The router reserves `/extensions/<id>` and descendants, passes the original request/path through, and returns 404 for disabled, missing or malformed routes. These are **public endpoints**: the custom Worker owns authentication for private data. No Workshop session, admin capability, gatekeeper grant or agent binding is automatically provided. This is trusted deployer code, not code accepted from canvas composition.

Local service bindings may target other listed consumer Workers only. Remote resource bindings are rejected; configure local emulation/fixtures in canonical configs. Inputs/secrets stay in the Worker's ignored `.dev.vars`; the manifest contains no secret values. Dependencies and custom build commands are owned by the wrapper and must be installed explicitly. Entry points must exist before validation. Restart after manifest/config changes; ordinary Worker source changes use Wrangler's watcher.

Consumer cloud release packaging, input validation and deployment wiring remain pending. The platform release reserves these routes but does not deploy custom Workers or enable them. The example pin above includes this adapter. Older pins without `scripts/consumer/extensions.ts` reject activation explicitly.

## Guarded starter views

New wrappers contain `views/operations.json`: one `inferops.project-board` widget with the initial configured target reference. On a pin containing the canvas contract, `pnpm views:check` validates regular JSON definitions, unique identities, registered widget parameters and layout limits. It rejects linked/oversized files, unknown fields, arbitrary renderers and unsupported schema versions. It does not install a view, read a board or grant resource authority. `runtimeReady` remains false because the InferOps data adapter and agent canvas tools remain pending. On supporting pins, builders can open Canvas in a workspace and import this definition. With only `composableViews`, edits remain in memory and are discarded on reload or leaving the workspace. With both view flags, compositions are saved under the workspace build capability, with revision-checked writes and explicit reload after conflicts. Imported definitions receive a new view identity. The dialog supports creation, renaming, sections, curated widths/columns, ordering, removal and session-local undo. Board cards explicitly show “Not connected”; no transactional records are loaded or mutated. Disabling the flags hides the UI and denies storage calls without deleting saved definitions.

Views are wrapper-owned source. Bootstrap reruns preserve edits; changing `inferos.targetRef` later does not silently rewrite existing view references. Edit them deliberately and revalidate. Ownership, sharing, credentials and transactional rows do not belong in view files. A target reference must be rebound to authorized resources when the runtime loader is implemented. Older pins without `scripts/consumer/views.ts` fail the command explicitly.

## Profile defaults and explicit overrides

New wrappers select `inferops-operations` and write an explicit snapshot: composable/durable layouts enabled, custom Workers disabled, InferOps Workspace name, compact listing density and system theme. Use a pin containing canvas support; older pins report unsupported flags instead of silently dropping them. Previously generated wrappers keep their explicit settings, including disabled views.

On supporting pins, `features` and `styling` must be objects but their individual fields may be omitted. Resolution is base defaults → profile → explicit settings. `personal` inherits disabled features, My Workspace branding, comfortable density and system theme. `inferops-operations` supplies the defaults above. `pnpm inferos:check` reports the effective values and a `provenance` map (`default`, `profile`, `override`). An explicit false wins. For a temporary operations canvas, set `features.durableViews` to false; to disable the canvas entirely, set both view flags false. Disabling only composition while inheriting durable views is an error.

Generated settings are deliberately explicit: changing only the profile name does not rewrite them. Remove chosen nested fields to inherit a profile after verifying the pinned parser supports partial objects. Old pins may require every field; fully explicit settings remain the portable form. Profile resolution controls startup and initial customization; it never reapplies over existing administrator settings or authorizes a resource.

## Synthetic InferOps data validation

`pnpm fixtures:check` validates `fixtures/project-board.json` using JSON Schema generated from InferOps `BoardResponseSchema` at a recorded Git revision. The validator additionally checks unique project/state/issue IDs, membership of the selected project, target-reference agreement and each issue’s state/workflow against its column. Revisions remain strings; live lease/run fields follow the canonical schema. Unknown fields fail instead of being silently discarded. The file must be regular JSON within the wrapper fixture directory, at most 1 MiB, with at most 256 projects/columns and 5000 total issues.

Doctor reports fixture errors; dev rejects invalid fixtures before starting Workers. Run setup before validation so the pinned Zod dependency is available. A changed target reference requires deliberately updating the selected fixture project identifier. Remote mode does not read local fixture files and remains unsupported for startup. Reports contain counts and schema provenance, never card contents. Passing validation does not install records, authorize a resource or load the board into Canvas.

Maintainers regenerate the committed schema with `node scripts/consumer/generate-board-schema.ts /absolute/path/to/clean/inferops FULL_SHA`, or append `--check` for a read-only drift check. This requires Bun and the InferOps checkout’s locked dependencies, but normal consumer validation uses only the committed schema and InferOS dependencies. Generation requires a clean tracked source tree at the supplied revision; review schema changes and fixture compatibility together.

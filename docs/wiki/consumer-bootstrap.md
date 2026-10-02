---
title: Bootstrap a consuming repository
updated: 2026-10-01
---

# Bootstrap a consuming repository

Create a wrapper with pinned InferOS code and explicit InferOps/profile/feature configuration. The command currently establishes a cloneable development baseline; the full operational canvas remains tracked work.

## Steps

Run from this InferOS checkout with Node 22.18 or later:

```bash
node scripts/consumer/bootstrap.ts /tmp/my-inferos https://github.com/factory-level/inferos 0e282e2144edbac404bcb83d52a5c814121be9e8
cd /tmp/my-inferos
pnpm inferos:check
pnpm run setup
pnpm run doctor
pnpm blueprints:check
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
| `fixtures/project-board.json` | Synthetic projects/states/issues using the InferOps board wire fields |
| `blueprints/` | Editable copies of the pinned standard formats; the complete local format set |
| `gatekeepers/`, `profiles/` | Wrapper-owned customization locations; runtime adapters remain pending |
| `package.json` | Pinned package manager and check/setup/doctor/blueprints:check/profile:init/dev entrypoints |

## What check proves

`pnpm inferos:check` validates settings, the actual submodule HEAD and the wrapper's staged gitlink. It reports `pending` adapters and `modifiedUpstream`. A true modifiedUpstream means the run includes local experiments and is not an exact-pinned-revision proof. An `ok` result proves configuration/pin consistency only; it is not proof that data/views/style are applied or that a server is healthy. A pin mismatch must be resolved deliberately, not bypassed by editing the validator.

Flags are `composableViews`, `durableViews` and `customCloudflareCode`. Durable views require composable views. Until adapters ship, enabling these causes `dev` to fail with an explicit message. This prevents a config file from falsely advertising running features.

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

`dev` launches native Workshop through run-local. It does not yet render the included InferOps fixture, automatically initialize the profile, load wrapper Workers or implement durable view storage. It uses the pinned native runner's local state and asset-serving behavior. The example pin includes a router asset-parity fix; an older pinned revision does not gain that change automatically. `dev` checks the selected local port before building and asks you to choose another port if it is occupied. Full setup/read/propose/approve/refresh evidence, lifecycle controls and cloud parity remain in [the roadmap](implementation-roadmap.md).

The tests cover fresh creation, recursive clone, paths with spaces, customized rerun, revision drift, Git failure cleanup and all flag combinations. No cloud deployment or live provider login is performed by bootstrap or those tests.

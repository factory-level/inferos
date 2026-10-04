---
title: Bootstrap a consuming repository
updated: 2026-10-03
---

# Bootstrap a consuming repository

Create a wrapper with pinned InferOS code and explicit InferOps/profile/feature configuration. The command currently establishes a cloneable development baseline; the full operational canvas remains tracked work.

## Steps

Run this from the InferOS checkout with Node 22.18 or later, after running `pnpm install` in the checkout. The scaffolder imports `yaml` through `scripts/consumer/skill-manifest.ts` and fails with `ERR_MODULE_NOT_FOUND` without it.

```bash
node scripts/consumer/bootstrap.ts /tmp/my-inferos https://github.com/factory-level/inferos 6bb215f0ad9d6911d599117949088dab4e0d7496
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

## Kanban customer shell

One private Kanban + operations shell per customer is a wrapper bootstrapped with the InferOps capabilities switched on. Profiles never switch a capability on, so the bootstrap command takes them explicitly:

```bash
# from an InferOS checkout, pinning a reviewed commit that contains the InferOps gatekeeper
node scripts/consumer/bootstrap.ts /path/to/acme-shell https://github.com/factory-level/inferos <full-sha> \
  --capability INFEROPS_ENABLED --capability INFEROPS_AUTH
cd /path/to/acme-shell
pnpm inferos:check          # schemaVersion 2; INFEROPS_ENABLED and INFEROPS_AUTH "enabled", source "override"
pnpm run setup
pnpm run doctor
pnpm local start            # foreground; in a second terminal:
pnpm local seed             # local account, mock model, InferOps account, the "operations" screen
pnpm local verify           # reads the board through the gatekeeper, as an agent would
pnpm profile:init           # after signing in as administrator; see below
```

What the options write, and only on creation:

- `inferos.config.json` is schema version 2 with profile `inferops-operations` (or `--profile personal`) and all eight capabilities written explicitly, the named ones `true`. `--capability` takes a name per flag or a comma-separated list; an unknown name fails.
- `inferos.canvas.json` is written by the pinned `pnpm canvas` CLI: `customGatekeepers` is `["gatekeeper-inferops"]` (either InferOps capability needs it), and with `INFEROPS_ENABLED` the starter board is the first screen template, `operations`, which `pnpm local seed` opens.
- The new wrapper must pass its own `inferos:check` before it is created. A pin without the canvas CLI, without version 2 parsing or without a requested capability's code fails, and nothing is left at the destination.

`INFEROPS_AUTH` adds "Sign in with InferLab" against `INFERLAB_AUTH_ORIGIN` (default `http://localhost:8080`, the local InferLab stack); see [sign-in](../oauth-signin.md#inferlab). To keep password sign-in only, set `capabilities.INFEROPS_AUTH` to `false`. Board data is the InferOps gatekeeper's mock unless `INFEROPS_BASE_URL` and its companions are set in the shell that runs `pnpm local start`; `pnpm local status` reports which.

A rerun of the same command validates the pin and changes nothing: options never rewrite an existing wrapper's configuration or canvas file, so edited branding, switched-off capabilities and replaced screen templates survive. `pnpm profile:init` is likewise one-time on the server, and later administrator edits win (covered by the `workshop-profile` integration test).

Not yet verified in a browser for this walkthrough: the Operate page and Kanban at narrow and wide widths, and a screen-reader pass. The Kumo kind picker's keyboard behaviour is covered by jsdom tests only.

## Configure a customer from a reviewed intake

A reviewed intake describes one customer: tenant and workspace, projects and their workflow kinds, requested capabilities, selected Wiki pillars, the operational inventory and the requirements. Its format is `scripts/consumer/intake.schema.json` in the pinned InferOS, and `scripts/consumer/fixtures/intake/acme-field-ops.json` is a clearly synthetic sample. Keep the customer's intake in the wrapper and apply it:

```bash
mkdir -p intake && cp inferos/scripts/consumer/fixtures/intake/acme-field-ops.json intake/acme.json
pnpm inferos intake apply intake/acme.json
pnpm inferos:check
```

What it does:

- A version 1 `inferos.config.json` is migrated to version 2 first.
- It switches on only the capabilities this pin implements. A `kanban` request turns on `INFEROPS_ENABLED` and `INFEROPS_AUTH`. A capability the pin cannot honour, such as `CODING_WORKBENCH_ENABLED` today, stays off and is reported.
- It sets the `inferops-operations` profile.
- With Kanban, it selects `gatekeeper-inferops` and adds a `customer-operations` screen template first in `inferos.canvas.json`, so `pnpm local seed` opens it. It also writes `views/customer-operations.json`. Both show one board per project, referenced as `inferops://<tenant>.<workspace>/project/board/<KEY>`.
- It writes `intake-report.json` and `intake-report.md`. Every requirement is `supported`, `unsupported` or `custom-work`, with a reason, the capability or issue it maps to, and a drafted issue for each gap. Wiki pillars are recorded as pending [#87](https://github.com/factory-level/inferos/issues/87).
- It runs the wrapper's `inferos:check` and rolls every write back if that fails.

It never deploys, starts a server or contacts InferOps. A draft intake (`review.status: "draft"`) is refused. Validation errors name the field, never the value.

`.inferos/intake-managed.json` records each value the intake wrote. Commit it. A rerun:

- updates a managed value only if it still holds what the intake last wrote;
- keeps a value you changed and reports it as `customized`;
- reports a `conflict`, and does not overwrite your value, when the intake's value changed too (or your value predates the first apply);
- never touches a field the intake does not manage, such as branding or the port.

Resolve a conflict by setting the value by hand, then rerun. `inferops.targetRef` and `fixtures/project-board.json` stay on the synthetic fixture board.

To file the drafted gap issues, name the repository explicitly. This uses your `gh` login, and a rerun never files the same requirement twice:

```bash
pnpm inferos intake apply intake/acme.json --file-issues acme-corp/acme-shell
```

`pnpm inferos config migrate` rewrites a version 1 `inferos.config.json` as version 2 on its own. It carries over whether the InferOps gatekeeper runs, and refuses without writing when the pin could not honour the result. Wrappers bootstrapped before the `inferos` script was added need the newer `.inferos/runtime.ts` and a `"inferos": "node .inferos/runtime.ts"` script first.

## Wrapper `pnpm local`

On a pin containing `scripts/local/lifecycle.ts`, `pnpm local status|start|stop|seed|verify|reset|logs` runs the pinned lifecycle operator from `inferos/`, with the wrapper's `local.port` as `VITE_BACKEND_HOST` (`--port` still overrides it). Flags and exit codes are the operator's (see [local development](../architecture/local-development.md#lifecycle-commands)). Two arguments are added so it operates the wrapper rather than the pinned checkout:

- `start` first applies every refusal `pnpm dev` applies (unsupported capabilities or schema, unavailable features, remote mode, invalid fixture), then appends `--consumer-root <wrapper>` after any run-local flags, and selects the wrapper's `blueprints/`.
- `seed` without `--screen` passes the first screen template in the wrapper's `inferos.canvas.json`.
- `runner start|status|stop` and `coding doctor` get `--consumer-root <wrapper>`, so the local coding runner reads the wrapper's `codingWorkbench.repos` and `.dev.vars` and keeps its state in the wrapper's git-ignored `.inferos/state/runner/` (see [Run the local coding runner](local-coding-runner.md)).

State, the dev-server record and `reset` stay under `inferos/.wrangler/`, as with `pnpm dev`. `status` lists the Workers the pinned checkout would bind, not the wrapper's custom Workers. An older pin fails with "does not support the local lifecycle"; use `pnpm dev` there.

## Verify, upgrade and recover

Run these from the wrapper root. Each prints one JSON object and exits 0 when the result is healthy, 1 when it is not and 2 on a usage error.

```bash
pnpm inferos verify [--live]                 # check + doctor + local status (+ local verify while the stack runs)
pnpm inferos upgrade <full-sha>              # plan only (same as --plan): writes nothing
pnpm inferos upgrade <full-sha> --apply      # clean tree required; stages the result, never commits
pnpm inferos upgrade <full-sha> --apply --branch <name> [--open-pr <owner/repo>]   # reviewed upgrade: commit on a new branch, optionally open a PR
pnpm inferos recover ports|config|fixtures|state [--apply]   # dry run unless --apply
```

- **verify** reports `checks[]` named `check`, `doctor`, `local-status` and `local-verify`, each with a `status` (`pass`, `fail` or `skipped`) and `reasons`. The live checks are `skipped` while the stack is stopped. `--live` makes a stopped stack a failure.
- **upgrade** fetches the commit into `inferos/` if needed and runs that revision's planner from a temporary worktree.
  - The plan lists blockers, the submodule move, whether `pnpm inferos config migrate` would succeed on the target (the upgrade never migrates), each changed file's action and the state rollback limit.
  - `--apply` moves the submodule and gitlink, rewrites `upstream.revision`, `.inferos/bootstrap.json` and `.inferos/files.json`, and refreshes InferOS files and upstream starters (blueprints, skill packs) you have not edited.
  - An edited skill, SOP, README or blueprint is merged three-way. The original is rebuilt from the submodule's history, so the wrapper keeps no extra copy. A clean merge is written (`merge`). A conflicting one leaves your file untouched (`conflict`), with a diff3 merge and its conflict markers under `.inferos/state/upgrade/<sha>/`.
  - Edited `.inferos/` helpers and binary files are not merged (`needs-review`, with the new text in the same place). The fixture is only reported (`upstream-changed`). Configuration, views, workers and gatekeepers are never touched.
  - `--branch <name>` creates the branch, applies, and refuses to commit if the staged diff or summary contains a staged `.dev.vars*`, `.env*`, `.wrangler/` or `.inferos/state/` path, a value from your `.dev.vars`, or a known token shape. Otherwise it commits with a review summary, also written to `.inferos/state/upgrade/<sha>/UPGRADE.md`. The summary covers code range, configuration, capabilities, connections and OAuth, Durable Object migrations, new action kinds and every file's reconciliation. `--open-pr <owner/repo>` pushes to `origin` and runs `gh pr create` with that body. Nothing is merged.
  - New action kinds are flagged in the summary. The wrapper holds no grants or auto-approval rules, so a new kind waits for manual approval until someone enables a rule for it.
  - A wrapper bootstrapped before `.inferos/files.json` existed has no baseline, so every copied file that differs from the target is `needs-review`. If its `.inferos/runtime.ts` has no `upgrade` command, run `node scripts/consumer/upgrade.ts <wrapper> <sha> [--apply]` from an InferOS checkout at the target SHA.
  - After apply: `git diff --cached`, `pnpm run setup`, `pnpm inferos verify`, then commit. Before the commit, `git reset --hard && git submodule update --init inferos` undoes it.
- **recover** never deletes a customer-owned file.
  - `ports` stops this wrapper's own dev server, or moves `local.port` to a free port. It never stops another process.
  - `config` realigns the submodule checkout with the gitlink, rewrites `bootstrap.json`, re-merges the managed `package.json` scripts and restores missing InferOS files. A gitlink that disagrees with `upstream.revision` is left for you to decide.
  - `fixtures` keeps an invalid fixture as `<fixture>.invalid-<time>` and restores the pinned starter.
  - `state` deletes `inferos/.wrangler/state` through `pnpm local reset --yes`.

**Rollback limit for stateful migrations:** local state is reset only, never migrated back. Durable Object and storage migrations that a newer pin applied on start cannot be undone. Going back to an older pin therefore means reverting the upgrade and running `pnpm inferos recover state --apply`, which loses every local account, workspace, seeded board and approval. Nothing here touches cloud resources.

## Generated contract

| File | Meaning |
| --- | --- |
| `inferos.config.json` | Versioned nonsecret inputs, exact upstream revision, profile, feature flags, style and local port |
| `inferos/` | Pinned Git submodule |
| `.inferos/runtime.ts`, `config.ts` and `maintenance.ts` | Standalone operator, validation and maintenance (verify/recover/upgrade) helpers copied from this version |
| `.inferos/files.json` | Every file bootstrap wrote, with its class (`generated`, `copied-template`, `customer-owned`), sha256 and upstream source; upgrade reads it to rebuild originals for three-way merges, and recover to keep customer edits |
| `.agents/skills/{verify,upgrade,recover}-inferos/SKILL.md` | Agent procedures for the maintenance commands below |
| `.agents/skills/bootstrap-inferos/SKILL.md` | Agent setup guidance copied into the consuming repository |
| `.agents/skills/skill-upload/SKILL.md` | Agent guidance for installing, authoring and publishing runtime skills (`/skill-upload`) |
| `.agents/skills/local-coding/SKILL.md` | Agent SOP for setting up, operating and recovering the local coding runner |
| `skills/{operate,build,shared}/` | Editable starter runtime skills for the Workshop agent, one pack per public Context Library collection |
| `inferos.skills.json` | Pack titles, directories, `include` lists (for example `.agents/skills/skill-creator`) and `exclude` globs |
| `views/operations.json` | Guarded starter composition; import it from the workspace Canvas page on supporting pins |
| `inferos.canvas.json` | Only with `--capability INFEROPS_ENABLED` or `INFEROPS_AUTH`: selects the InferOps gatekeeper and, with `INFEROPS_ENABLED`, the `operations` board screen template. Otherwise create it with `pnpm canvas` |
| `fixtures/project-board.json` | Synthetic projects/states/issues using the InferOps board wire fields |
| `blueprints/` | Editable copies of the pinned standard formats; the complete local format set |
| `gatekeepers/`, `profiles/` | Wrapper-owned customization locations; runtime adapters remain pending |
| `package.json` | Pinned package manager and inferos (`intake apply`, `config migrate`, `verify`, `recover`, `upgrade`)/check/setup/doctor/blueprints:check/profile:init/local/skills:check/skills:install/skills:upload/dev entrypoints |

## What check proves

`pnpm inferos:check` validates settings, the actual submodule HEAD and the wrapper's staged gitlink. It reports `pending` adapters and `modifiedUpstream`. A true modifiedUpstream means the run includes local experiments and is not an exact-pinned-revision proof. An `ok` result proves configuration/pin consistency only; it is not proof that data/views/style are applied or that a server is healthy. A pin mismatch must be resolved deliberately, not bypassed by editing the validator.

Flags are `composableViews`, `durableViews`, `customCloudflareCode` and `inferlabLogin`. `inferlabLogin` (or `INFEROPS_AUTH` under `capabilities` in a version 2 file) adds "Sign in with InferLab" against `INFERLAB_AUTH_ORIGIN` (default `http://localhost:8080`) and makes every InferOps account a person's own InferLab session; the launcher stops with the reason if the gatekeeper is not enabled or the origin is unusable. See [sign-in](../oauth-signin.md#inferlab). Durable views require composable views. Pins containing the Canvas page or dialog support `composableViews` locally; `durableViews` additionally requires the native canvas store. The launcher passes both switches to the backend, whose public configuration controls the builder UI. Unsupported pins fail startup explicitly. Pins containing the custom Worker adapter support `customCloudflareCode` locally. This prevents a config file from falsely advertising running features.

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


## Skills

A wrapper has two skill locations:

- **Coding-agent skills** in `.agents/skills/`. Bootstrap ships `bootstrap-inferos`, `skill-upload` and `local-coding`. Run `pnpm skills:install` to add Anthropic's `skill-creator` with the pinned skills.sh CLI (`skills@1.7.0`). To install something else, pass a source and skill: `pnpm skills:install vercel-labs/agent-skills --skill <name>`. The CLI writes `skills-lock.json` and links agent directories such as `.claude/skills`. Commit both.
- **Runtime skills** in `skills/<pack>/<name>/SKILL.md`. These become Workshop agent skills and `/` commands in chat. `inferos.skills.json` maps each pack to one public Context Library collection, with titles `InferOS · Operate`, `InferOS · Build` and `InferOS · Shared`. A pack's `include` publishes an installed coding-agent skill as part of the pack. `exclude` drops `evals/`, `*-workspace/` and similar authoring output.

Preload a fresh local deployment after `profile:init`, with the same private session variable:

```bash
pnpm skills:install                 # optional: skill-creator for coding agents and the build pack
pnpm skills:check                   # offline: frontmatter, names, paths and size limits
pnpm skills:upload --dry-run        # needs pnpm dev and INFEROS_ADMIN_SESSION
pnpm skills:upload                  # or: pnpm skills:upload operate build
```

How `skills:upload` behaves:
- If the administrator has not added the Context Library yet, it opts them in (a dry run only reports `provisionContextAccount`).
- It creates a missing collection, writes only new or changed files, and checks that the Context Library indexed every `SKILL.md`.
- Files that exist only in the collection, such as edits made in the UI, are listed as `stale`. They are deleted only with `--prune`.
- The `skill-upload` agent skill walks a coding agent through this, including drafting a new skill with skill-creator.
- Uploads reach the configured localhost port only. Deployed instances need the pending deployment-origin contract.

## Theme preference precedence

The deployment theme is a fallback, not an enforced setting. A browser's saved `light`, `dark` or explicit `system` preference wins. Without a valid saved preference, the browser uses `ServerConfig.defaultTheme`, falling back to `system` on older deployments or before config loads. Choosing a theme keeps that choice for the session even if local storage is unavailable. A deployment fallback is never written into the browser's preference storage.

`AdminApi.setDefaultTheme` updates the persisted deployment default for the next client connection; a dedicated admin-panel control remains pending. This uses the existing Kumo light/dark palettes and applies through the root `data-mode` and native-control color scheme. It does not change custom blueprint styling or introduce a new color system. Before server config arrives, a new browser may briefly display its system theme.

## Current limits

`dev` launches native Workshop through run-local. It does not yet load the included InferOps fixture into board widgets or automatically initialize the profile. Supporting pins persist compositions in the native workspace store when both view flags are enabled. It uses the pinned native runner's local state and asset-serving behavior. The example pin includes a router asset-parity fix; an older pinned revision does not gain that change automatically. `dev` checks the selected local port before building and asks you to choose another port if it is occupied. Full setup/read/propose/approve/refresh evidence and cloud parity remain in [the roadmap](implementation-roadmap.md).

The tests cover fresh creation, recursive clone, paths with spaces, customized rerun, revision drift, Git failure cleanup, all flag combinations, the version 2 customer shell (capabilities, canvas selection, rerun preservation, unsupported pins) and the wrapper's `pnpm local` delegation against a stand-in operator. No cloud deployment or live provider login is performed by bootstrap or those tests.

## Custom Cloudflare Workers in local development

New wrappers include `inferos.extensions.json` and a disabled `workers/hello` example. Set `features.customCloudflareCode` to true, run `pnpm extensions:check`, then `pnpm dev`. The example returns JSON at `/extensions/hello`. `extensions:check` executes trusted canonical config modules and writes generated `wrangler.consumer.jsonc` files; review that code before running it. A disabled flag does not read the manifest or import its configs. Disabling it and restarting removes activation while retaining source and local state.

The same flag runs the wrapper's own gatekeepers. Each lives in `gatekeepers/gatekeeper-<slug>/` with a `cloudflare.config.ts` whose Worker name is the directory name. `pnpm gatekeepers:generate` writes its `wrangler.jsonc` beside it (commit it; the `wrangler.dev.jsonc` the dev server also writes there is machine-specific, and wrappers bootstrapped before it was added to the generated `.gitignore` should ignore it by hand), and `pnpm gatekeepers:check` exits 1 when one has drifted from its source. `pnpm dev` binds each to the backend as `GATEKEEPER_<SLUG>` and serves its callbacks at `/gatekeeper/<slug>` on the wrapper's own origin. A directory with no config is a library and never runs; symbolic links and names the pinned InferOS already uses are rejected. The gatekeeper's imports must resolve from the wrapper (for example `../../inferos/scripts/worker-config.ts`), and cloud packaging does not include it yet.

The v1 manifest is `{ "schemaVersion": 1, "workers": [{ "id": "hello", "directory": "workers/hello" }] }`. IDs are unique lowercase hyphenated slugs; directories and entrypoints stay under the wrapper's `workers/`. Each entry requires `cloudflare.config.ts`, whose Worker name is `consumer-<id>`. The generated config uses the same canonical converter as native Workers and retains bindings/migrations. Never edit generated configs. Only explicit entries are activated; library directories are not discovered automatically.

The native multi-Worker launcher binds each entry to the router as `CONSUMER_<ID>` and sets its deployer-owned enable switch. The router reserves `/extensions/<id>` and descendants, passes the original request/path through, and returns 404 for disabled, missing or malformed routes. These are **public endpoints**: the custom Worker owns authentication for private data. No Workshop session, admin capability, gatekeeper grant or agent binding is automatically provided. This is trusted deployer code, not code accepted from canvas composition.

Local service bindings may target other listed consumer Workers only. Remote resource bindings are rejected; configure local emulation/fixtures in canonical configs. Inputs/secrets stay in the Worker's ignored `.dev.vars`; the manifest contains no secret values. Dependencies and custom build commands are owned by the wrapper and must be installed explicitly. Entry points must exist before validation. Restart after manifest/config changes; ordinary Worker source changes use Wrangler's watcher.

Consumer cloud release packaging, input validation and deployment wiring remain pending. The platform release reserves these routes but does not deploy custom Workers or enable them. The example pin above includes this adapter. Older pins without `scripts/consumer/extensions.ts` reject activation explicitly.

## Guarded starter views

New wrappers contain `views/operations.json`: one `inferops.project-board` widget with the initial configured target reference. On a pin containing the canvas contract, `pnpm views:check` validates regular JSON definitions, unique identities, registered widget parameters and layout limits. It rejects linked/oversized files, unknown fields, arbitrary renderers and unsupported schema versions. It does not install a view, read a board or grant resource authority. `runtimeReady` remains false because the real InferOps data adapter remains pending (boards are mocked by the InferOps gatekeeper). Chat agents can list and edit canvases; `pnpm canvas` configures which widget kinds, blueprint widgets and screen templates they offer (see the canvas architecture doc). On supporting pins, builders can open Canvas in a workspace and import this definition. With only `composableViews`, edits remain in memory and are discarded on reload or leaving the workspace. With both view flags, compositions are saved under the workspace build capability, with revision-checked writes and explicit reload after conflicts. Imported definitions receive a new view identity. The dialog supports creation, view/section renaming, curated widths/columns, ordering, cross-section board moves, removal and session-local undo. Export view downloads a validated JSON definition that can be kept in views/ and imported into another workspace. Import creates a new view identity and does not transfer resource grants. Board cards explicitly show “Not connected”; no transactional records are loaded or mutated. Disabling the flags hides the UI and denies storage calls without deleting saved definitions.

Views are wrapper-owned source. Bootstrap reruns preserve edits; changing `inferos.targetRef` later does not silently rewrite existing view references. Edit them deliberately and revalidate. Ownership, sharing, credentials and transactional rows do not belong in view files. A target reference must be rebound to authorized resources when the runtime loader is implemented. Older pins without `scripts/consumer/views.ts` fail the command explicitly.

## Profile defaults and explicit overrides

New wrappers select `inferops-operations` (unless bootstrapped with `--profile personal`) and write an explicit snapshot: composable/durable layouts enabled, custom Workers disabled, InferOS name, compact listing density and system theme. Use a pin containing canvas support; older pins report unsupported flags instead of silently dropping them. Previously generated wrappers keep their explicit settings, including disabled views.

On supporting pins, `features` and `styling` must be objects but their individual fields may be omitted. Resolution is base defaults → profile → explicit settings. `personal` inherits disabled features, InferOS branding, comfortable density and system theme. `inferops-operations` supplies the defaults above. `pnpm inferos:check` reports the effective values and a `provenance` map (`default`, `profile`, `override`). An explicit false wins. For a temporary operations canvas, set `features.durableViews` to false; to disable the canvas entirely, set both view flags false. Disabling only composition while inheriting durable views is an error.

Generated settings are deliberately explicit: changing only the profile name does not rewrite them. Remove chosen nested fields to inherit a profile after verifying the pinned parser supports partial objects. Old pins may require every field; fully explicit settings remain the portable form. Profile resolution controls startup and initial customization; it never reapplies over existing administrator settings or authorizes a resource.

## Synthetic InferOps data validation

`pnpm fixtures:check` validates `fixtures/project-board.json` using JSON Schema generated from InferOps `BoardResponseSchema` at a recorded Git revision. The validator additionally checks unique project/state/issue IDs, membership of the selected project, target-reference agreement and each issue’s state/workflow against its column. Revisions remain strings; live lease/run fields follow the canonical schema. Unknown fields fail instead of being silently discarded. The file must be regular JSON within the wrapper fixture directory, at most 1 MiB, with at most 256 projects/columns and 5000 total issues.

Doctor reports fixture errors; dev rejects invalid fixtures before starting Workers. Run setup before validation so the pinned Zod dependency is available. A changed target reference requires deliberately updating the selected fixture project identifier. Remote mode does not read local fixture files and remains unsupported for startup. Reports contain counts and schema provenance, never card contents. Passing validation does not install records, authorize a resource or load the board into Canvas.

Maintainers regenerate the committed schema with `node scripts/consumer/generate-board-schema.ts /absolute/path/to/clean/inferops FULL_SHA`, or append `--check` for a read-only drift check. This requires Bun and the InferOps checkout’s locked dependencies, but normal consumer validation uses only the committed schema and InferOS dependencies. Generation requires a clean tracked source tree at the supplied revision; review schema changes and fixture compatibility together.

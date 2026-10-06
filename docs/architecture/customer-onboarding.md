---
title: Customer OS onboarding
covers:
  - scripts/consumer/intake.ts
  - scripts/consumer/intake-inferops.ts
  - scripts/consumer/intake.schema.json
  - scripts/consumer/intake.test.ts
  - scripts/consumer/fixtures/intake
updated: 2026-10-06
---

# Customer OS onboarding

## Overview

Steps 6 and 7 of the [onboarding sequence](../design/customer-onboarding.md) have code: a wrapper derives its configuration from a reviewed intake with `pnpm inferos intake apply <file>`. The command writes a report with every requirement's disposition and can file the drafted gap issues. With `--inferops` it also applies the intake to InferOps: the operations, then the Wiki's company root, selected pillars and their Master pages, read back and recorded. Bootstrap (step 5), local customization and the local checks (steps 8 and 9) are described in [consumer configuration](consumer-configuration.md). There is no upgrade or deploy command.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/intake.schema.json` | JSON Schema for intake version 1, for editors and reviewers. The parser is authoritative, and a test keeps the schema in step with it |
| `scripts/consumer/intake.ts` | Strict bounded parser (`parseIntake`, `readIntakeFile`), the support table (`PRODUCT_SUPPORT`, `disposeRequirements`, `derivedCapabilities`), managed-field reconciliation, the reports, issue filing through an injectable seam, `applyIntakeWithInferOps`, and the `intake.ts apply ROOT FILE [--file-issues OWNER/REPO] [--inferops]` entry point |
| `scripts/consumer/intake-inferops.ts` | The InferOps side of `--inferops`: the binding from the environment (`inferOpsBindingFromEnv`), the binding proof (`proveInferOpsBinding`: a dry run in operations, a Wiki read in InferMind), the Wiki memberships an intake asks for (`pillarMembers`), and the three reported steps (`applyIntakeToInferOps`) through an injectable `fetch` |
| `scripts/consumer/fixtures/intake/acme-field-ops.json` | The synthetic Acme Field Operations sample: tenant `acme`, workspace `operations`, a software project `ENG` and a content project `OPS`, three pillars, four operations and eight requirements |
| `scripts/consumer/intake.test.ts` | Parser and schema agreement, rejection without echo, the sample against a stand-in pin, rerun and conflict handling, rollback, issue drafting and filing, the wrapper commands, and `--inferops` against an in-memory InferOps: the happy path and rerun, refused bindings, a partial failure and its retry, failed and incomplete readbacks, a denied write, binding errors without echo, and SOP membership |
| `scripts/consumer/runtime.ts` | The wrapper's `intake` command (delegates to the pinned `intake.ts`) and `config migrate` (`migrateWrapperConfig`) |

## Data and Control Flow

The wrapper's `package.json` has an `inferos` script (`node .inferos/runtime.ts`), so `pnpm inferos intake apply <file>` reaches the copied runtime. The runtime checks the pin as every command does, then runs the pinned `scripts/consumer/intake.ts` with the wrapper root and the file resolved against the working directory. A pin without that script fails with "does not support customer intake".

`applyIntake` runs in this order:

1. **Read the intake.** The file must be a regular file of at most 256 KiB. It is parsed and validated. A `draft` review status is refused. Errors name a field and a rule only; invalid JSON reports "Intake is not valid JSON".
2. **Migrate.** A version 1 `inferos.config.json` is migrated with `migrateConsumerConfig`. `INFEROPS_ENABLED` carries over whether the wrapper runs the gatekeeper today (`inferOpsGatekeeperSelected`).
3. **Derive.** `derivedCapabilities` switches on the configuration capabilities of each requested product capability whose sources are all in the pin (`capabilitySources`). `kanban` maps to `INFEROPS_ENABLED` and `INFEROPS_AUTH`. A capability whose `CAPABILITY_REQUIREMENTS` are not also on is dropped. The profile is `inferops-operations`. With `INFEROPS_ENABLED` derived, the wrapper also gets `gatekeeper-inferops` in `inferos.canvas.json`, a `customer-operations` screen template at the front of `screens` (so `pnpm local seed` opens it), and `views/customer-operations.json`. Each has one section per project, holding that project's board with its workflow kind.
4. **Reconcile.** Each managed value is a slot keyed `file:locator`. `.inferos/intake-managed.json` records the value the intake last wrote to each slot. A slot is written when the current value equals the recorded one. On first apply, it is also written when the value is absent or a known default (`false` for a capability or gatekeeper selection). Otherwise the value is kept. It is reported as `customized` when the intake's value is unchanged, and as `conflict` when both values changed or the value predates the intake. A kept slot leaves the record at the last written value, so a conflict is reported on every run until someone resolves it. A slot that is no longer derived is `released` and left as it is. No other field is read or written.
5. **Validate, then write.** The configuration goes through `parseConsumerConfig` and `unsupportedCapabilities`, the canvas file through `resolveCanvasConfig`, and the view through `parseCanvasDefinition`. Then the files are written and the wrapper's own `.inferos/runtime.ts check` runs. If the check fails, every write is rolled back.
6. **Dispose.** `disposeRequirements` maps each requirement category to a disposition (below). Each `supported` requirement records whether the wrapper now holds its mapped values (`configured`). A kept customer edit can leave it `false`. Every `unsupported` and `custom-work` requirement gets a drafted issue. The title starts with `[synthetic]` for a synthetic intake, and the body states the disposition, reason, capabilities and related issue.
7. **File.** Only with `--file-issues OWNER/REPO`, after the check passes, each draft not already filed is filed with `gh issue create --repo`. Its URL is recorded in `filedIssues`, so a rerun never files it twice. A failure stops filing, keeps the URLs already recorded, and exits nonzero.
8. **Report.** `intake-report.json` and `intake-report.md` are rewritten at the wrapper root.

With `--inferops`, `applyIntakeWithInferOps` wraps these steps:

- **Before step 1**, `inferOpsBindingFromEnv` reads `INFEROPS_BASE_URL`, `INFEROPS_API_TOKEN`, `INFEROPS_WORKSPACE_ID` (the InferOps operations workspace) and `INFEROPS_KNOWLEDGE_WORKSPACE_ID` (the InferMind workspace). A missing or malformed variable is named, never its value. `proveInferOpsBinding` then proves both workspaces before anything changes: a dry run of `POST /project/intake` in the operations workspace (it writes nothing, and the provider refuses it unless the workspace's tenant and workspace slugs are the intake's and the token holds `project:manage`) and `GET /knowledge/wiki/structure` in the InferMind workspace (answered only in an InferMind workspace the token may read). A plain project read is not used as proof: the provider answers it in an InferMind workspace too. A wrong, swapped or unauthorized workspace is refused before the wrapper or InferOps changes.
- **After step 8** (so a wrapper rollback never sits behind a remote write), `applyIntakeToInferOps` runs three steps, each reported on its own:
  1. `POST /project/intake` in the operations workspace. InferOps models the projects and operations and returns its canonical `intakeSha256`. That is the provider's identity of the intake, kept apart from the raw-bytes `intakeSha256` above and never compared with it.
  2. `POST /knowledge/wiki/pillars` in the InferMind workspace, with the provider's hash, `rootTitle` from `customer.name`, the pillars (`id` as `key`), and one membership per operation whose `sop` is `wiki:<slug>` and has a pillar (`pillarMembers`). Any other SOP is reported as unlinked, never dropped. Its idempotency key names the tenant, the workspace, the operation and the provider's hash.
  3. `GET /knowledge/wiki/structure`, the readback: `complete` only when the company root and every selected pillar's Master are present.
- A failure is returned as a step status (`failed`, and the steps after it `not-run`), never as a rolled-back wrapper. A write that succeeded is not reported failed because the readback failed or came back incomplete. The report gains an `inferops` section; each pillar becomes `applied` with its Master's document id, `failed`, `unverified` (written, readback failed) or `pending`; the `wiki` requirement becomes `supported` only when the readback is complete. The managed record keeps `inferops` (the provider's hash, each step's status, the root and Master ids). The command exits nonzero unless every step completed. Rerunning is safe: both writes are idempotent on InferOps and keep ids and human edits.

| Category | Disposition in this pin | Maps to |
| --- | --- | --- |
| `kanban` | supported | `INFEROPS_ENABLED` |
| `sign-in` | supported | `INFEROPS_AUTH`, [#66](https://github.com/factory-level/inferos/issues/66) |
| `views` | supported (composable and durable views through the profile, with the InferOps integration) | `INFEROPS_ENABLED`, `composableViews`, `durableViews` |
| `wiki` | unsupported; with `--inferops`, supported once the root and every selected pillar's Master are read back | [#87](https://github.com/factory-level/inferos/issues/87) |
| `local-coding` | unsupported until `CODING_WORKBENCH_ENABLED` has a source | `CODING_WORKBENCH_ENABLED`, [#69](https://github.com/factory-level/inferos/issues/69) |
| `state-machine`, `harness`, `publish-widget`, `publish-app`, `agent-deployments` | unsupported until their capability has a source | the capability of the same meaning |
| `deployment` | unsupported: no deploy command | [#11](https://github.com/factory-level/inferos/issues/11) |
| `custom-component` | custom work in `workers/`, `gatekeepers/` or `blueprints/` | [#36](https://github.com/factory-level/inferos/issues/36) |
| `integration` | custom work: a wrapper-owned gatekeeper | [#9](https://github.com/factory-level/inferos/issues/9) |

The disposition follows the pin, not the vocabulary: when a capability's source lands in `capabilitySources`, the same intake reports it `supported` and switches it on.

The JSON report holds the intake identity (wrapper-relative path, SHA-256, synthetic label, review), the target projects with their references, the configuration (whether it was migrated, the profile, the capabilities, each managed field's action and the conflicts), the pillars (each `pending` #87 unless `--inferops` applied it), the `inferops` run (null without `--inferops`), the operational inventory, the requirements, a summary of counts, `deployed: false` and a list of what is still pending. The Markdown report is rendered from it. Neither includes a timestamp, so a rerun on an unchanged wrapper rewrites the same bytes.

`pnpm inferos config migrate` rewrites a version 1 file as version 2 in place. It refuses, writing nothing, when the pin would not honour the result: a capability it would carry over is unsupported, or the pin's own parser rejects version 2. A version 2 file is left untouched.

## Configuration

The intake file is the input. Keeping it in the wrapper (for example `intake/<customer>.json`) records its path in the report. Commit `.inferos/intake-managed.json` so reruns on another machine know what the intake manages. The reports are generated and can be committed as review evidence. The command never deploys or starts a server. It contacts InferOps only with `--inferops`, through the four `INFEROPS_*` variables above (keep the token in the environment, not in a committed file). Only `--file-issues` reaches GitHub, through the operator's `gh` login.

## Divergences from Design

- The [design](../design/customer-onboarding.md) has the intake yield a modeled tenant. With `--inferops` the command models the projects, operations, pillars and Masters in an existing tenant and workspaces; it does not create the tenant or workspaces, and requirement dispositions stay InferOS-side (factory-level/inferops#2324).
- `inferops.targetRef` and `fixtures/project-board.json` keep naming the synthetic fixture board, because fixture validation requires the fixture's project to match the reference and remote mode cannot start yet. The customer references live in the starter view and screen template only.
- Branding is not derived: `styling` stays as written.
- Without `--inferops`, the operational inventory and pillars are recorded in the report only. The InferOS Wiki widget and gatekeeper still read documents, not the root, pillars or Masters ([#87](https://github.com/factory-level/inferos/issues/87)), and coverage is [factory-level/inferops#2325](https://github.com/factory-level/inferops/issues/2325).
- Upgrade and deploy have no command.

## Open Questions

- Which repository gap issues belong in by default. Today the operator names one.
- Whether a wrapper whose copied helpers predate the `inferos` script should gain it on a bootstrap rerun. Today a rerun rewrites nothing, so an older wrapper runs `node .inferos/runtime.ts intake apply <file>` after copying newer helpers.

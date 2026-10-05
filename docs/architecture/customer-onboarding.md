---
title: Customer OS onboarding
covers:
  - scripts/consumer/intake.ts
  - scripts/consumer/intake.schema.json
  - scripts/consumer/intake.test.ts
  - scripts/consumer/fixtures/intake
updated: '2026-10-05'
obsidian_designs:
- note: software/InferOS/InferOS Cloudflare Deployment.md
  sections:
  - Customer onboarding
---

# Customer OS onboarding

## Overview

Steps 6 and 7 of the [onboarding sequence](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20Deployment.md%23Customer%20onboarding) have code: a wrapper derives its configuration from a reviewed intake with `pnpm inferos intake apply <file>`. The command writes a report with every requirement's disposition and can file the drafted gap issues. Bootstrap (step 5), local customization and the local checks (steps 8 and 9) are described in [consumer configuration](consumer-configuration.md). There is no upgrade or deploy command.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/consumer/intake.schema.json` | JSON Schema for intake version 1, for editors and reviewers. The parser is authoritative, and a test keeps the schema in step with it |
| `scripts/consumer/intake.ts` | Strict bounded parser (`parseIntake`, `readIntakeFile`), the support table (`PRODUCT_SUPPORT`, `disposeRequirements`, `derivedCapabilities`), managed-field reconciliation, the reports, issue filing through an injectable seam, and the `intake.ts apply ROOT FILE [--file-issues OWNER/REPO]` entry point |
| `scripts/consumer/fixtures/intake/acme-field-ops.json` | The synthetic Acme Field Operations sample: tenant `acme`, workspace `operations`, a software project `ENG` and a content project `OPS`, three pillars, four operations and eight requirements |
| `scripts/consumer/intake.test.ts` | Parser and schema agreement, rejection without echo, the sample against a stand-in pin, rerun and conflict handling, rollback, issue drafting and filing, and the wrapper commands |
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

| Category | Disposition in this pin | Maps to |
| --- | --- | --- |
| `kanban` | supported | `INFEROPS_ENABLED` |
| `sign-in` | supported | `INFEROPS_AUTH`, [#66](https://github.com/factory-level/inferos/issues/66) |
| `views` | supported (composable and durable views through the profile, with the InferOps integration) | `INFEROPS_ENABLED`, `composableViews`, `durableViews` |
| `wiki` | unsupported | [#87](https://github.com/factory-level/inferos/issues/87) |
| `local-coding` | unsupported until `CODING_WORKBENCH_ENABLED` has a source | `CODING_WORKBENCH_ENABLED`, [#69](https://github.com/factory-level/inferos/issues/69) |
| `state-machine`, `harness`, `publish-widget`, `publish-app`, `agent-deployments` | unsupported until their capability has a source | the capability of the same meaning |
| `deployment` | unsupported: no deploy command | [#11](https://github.com/factory-level/inferos/issues/11) |
| `custom-component` | custom work in `workers/`, `gatekeepers/` or `blueprints/` | [#36](https://github.com/factory-level/inferos/issues/36) |
| `integration` | custom work: a wrapper-owned gatekeeper | [#9](https://github.com/factory-level/inferos/issues/9) |

The disposition follows the pin, not the vocabulary: when a capability's source lands in `capabilitySources`, the same intake reports it `supported` and switches it on.

The JSON report holds the intake identity (wrapper-relative path, SHA-256, synthetic label, review), the target projects with their references, the configuration (whether it was migrated, the profile, the capabilities, each managed field's action and the conflicts), the pillars (each `pending` #87), the operational inventory, the requirements, a summary of counts, `deployed: false` and a list of what is still pending. The Markdown report is rendered from it. Neither includes a timestamp, so a rerun on an unchanged wrapper rewrites the same bytes.

`pnpm inferos config migrate` rewrites a version 1 file as version 2 in place. It refuses, writing nothing, when the pin would not honour the result: a capability it would carry over is unsupported, or the pin's own parser rejects version 2. A version 2 file is left untouched.

## Configuration

The intake file is the input. Keeping it in the wrapper (for example `intake/<customer>.json`) records its path in the report. Commit `.inferos/intake-managed.json` so reruns on another machine know what the intake manages. The reports are generated and can be committed as review evidence. The command never deploys, starts a server or contacts InferOps. Only `--file-issues` reaches GitHub, through the operator's `gh` login.

## Divergences from Design

- The [design](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20Deployment.md%23Customer%20onboarding) has the intake yield a modeled tenant. The command reads a hand-reviewed intake and models nothing in InferOps.
- `inferops.targetRef` and `fixtures/project-board.json` keep naming the synthetic fixture board, because fixture validation requires the fixture's project to match the reference and remote mode cannot start yet. The customer references live in the starter view and screen template only.
- Branding is not derived: `styling` stays as written.
- The operational inventory and pillars are recorded in the report and drive nothing else until the Wiki host ([#87](https://github.com/factory-level/inferos/issues/87)) and coverage work ([factory-level/inferops#2325](https://github.com/factory-level/inferops/issues/2325)) consume them.
- Upgrade and deploy have no command.

## Open Questions

- Which repository gap issues belong in by default. Today the operator names one.
- Whether a wrapper whose copied helpers predate the `inferos` script should gain it on a bootstrap rerun. Today a rerun rewrites nothing, so an older wrapper runs `node .inferos/runtime.ts intake apply <file>` after copying newer helpers.

## Design authority

The `obsidian_designs` front matter identifies intended design in the `authored` vault.
Read the owning notes through the [Obsidian CLI workflow](_brain.md); references do not
imply complete implementation.

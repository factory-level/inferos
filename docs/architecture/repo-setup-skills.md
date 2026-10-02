---
title: InferOS repository setup skills
covers:
  - scripts/run-dev-server.ts
  - scripts/generate-worker-configs.ts
  - scripts/release/manifest-lib.ts
  - .agents/skills
updated: 2026-10-01
---

# InferOS repository setup skills

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/repo-setup-skills.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Existing local startup orchestration. |
| `scripts/generate-worker-configs.ts` | Generated config synchronization. |
| `scripts/release/manifest-lib.ts` | Deployable discovery and inputs. |
| `.agents/skills` | Existing project skills. |

## Data and Control Flow

InferOS has internal project skills and runnable development scripts. The upstream cloudflare-os-starter demonstrates a wrapper/submodule deployment and operator skill, but that is an external project, not an already-shipped InferOS consuming-repository setup suite. Current worker discovery and deploy inputs constrain how wrapper extensions can integrate.

## Configuration

Use the repo-pinned pnpm and lockfile. Do not edit generated wrangler.jsonc. Installable gatekeepers default to OAuth credential inputs unless manifest policy overrides them.

## Divergences from Design

A first bootstrap skill and strict versioned wrapper configuration now exist in the working tree; see [consumer configuration](consumer-configuration.md). Full configure/verify/upgrade/recover behavior, runtime adapters and cloud parity remain backlog work.

## Open Questions

- How much of the upstream starter operator skill can be reused verbatim under its license and version contract?
- Which machine-readable configuration schema best prevents divergence between explanations and executable defaults?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

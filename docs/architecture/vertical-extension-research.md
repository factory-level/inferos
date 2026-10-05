---
title: Vertical extension research and decision matrix
covers:
  - docs/blueprints.md
  - packages/gatekeeper-kit
  - packages/gatekeeper-context
  - packages/gatekeeper-scheduler
  - packages/mcp-shared
  - scripts/recipes
updated: 2026-10-04
---

# Vertical extension research and decision matrix

## Overview

Current-state baseline inspected at InferOS `21708d3449a482843e13cb2268d1ae79451c7dfb`. Proposed work is recorded in the [design](../design/vertical-extension-research.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `docs/blueprints.md` | Existing native artifact boundary. |
| `packages/gatekeeper-kit` | External integration and approval mechanisms. |
| `packages/gatekeeper-context` | Scoped context library. |
| `packages/gatekeeper-scheduler` | Native callback scheduling. |
| `packages/mcp-shared` | Generic MCP trust boundary. |

## Data and Control Flow

Current native primitives cover sandboxed apps, bindings, observed reads, approved writes, context collections and scheduled callbacks. They supply composition mechanisms, not complete vertical products. Existing MCP support does not automatically confer provider write trust: untrusted write annotations do not authorize automatic application. The wiki records reviewed source evidence and proposed workflow mappings separately from implemented functionality.

## Configuration

Admin-config controls offered connectors/resources and optional auto-provisioning. Authentication remains environment-driven. External providers retain their own authorization, rate limits, retention and data constraints.

## Divergences from Design

Synthetic wrapper recipes now exercise existing local mechanisms; actual domain adapters and cloud/customer validation remain open. The researched matrix is an implementation decision aid, not a feature catalog.

## Open Questions

- Which actual providers and deployment jurisdictions apply to each first customer?
- Which offline, latency, retention and audit requirements are mandatory rather than desirable for each workflow?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

## Wave 5 research refresh

The capability inventory now includes shipped wrapper maintenance, connection packages, pinned installs and bounded Kanban rendering. The 36-row matrix records mechanism confidence and follow-up ownership for all 12 areas. Primary sources for the first five verticals were reopened on 2026-10-04. This validates the research artifact, not provider integrations or 36 executable workflows. Synthetic recipe delivery and cloud/customer acceptance remain #32; industry object packs/schema migrations are not implemented by wrapper recipes.
## Synthetic recipe generator

`scripts/recipes/create.ts` builds a new pinned wrapper through `bootstrapConsumer`, selects the existing InferOps fixture capability, sets its port and synthetic three-card board, and carries its view, inherited blueprints/skills and explicit domain limits. Creation is staged then renamed; failures clean only the staging directory. Reruns verify recipe identity and upstream pin, then preserve customer edits. It adds no kernel/RPC API or provider. Industrial and medical JSON files are future scenario inputs, not running adapters. See [recipe runbook](../wiki/vertical-recipes.md). Cloud/provider acceptance stays open in #32.

The pinned mock does not import wrapper fixture JSON. `packages/workshop-backend/scripts/propose-recipe.ts` is a Node operator, not a kernel endpoint: it uses existing authenticated RPC to queue the catalog cards and create a saved view on the local synthetic board. It never approves; the operator reviews creation in the normal queue. Existing demo cards remain, and fixture IDs/data are not imported.

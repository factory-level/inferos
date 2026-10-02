---
title: Vertical extension research and decision matrix
covers:
  - docs/blueprints.md
  - packages/gatekeeper-kit
  - packages/gatekeeper-context
  - packages/gatekeeper-scheduler
  - packages/mcp-shared
updated: 2026-10-01
---

# Vertical extension research and decision matrix

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/vertical-extension-research.md), not asserted as implemented here.

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

Vertical recipes and their validation evidence must be built and tested; the researched matrix is an implementation decision aid, not a feature catalog.

## Open Questions

- Which actual providers and deployment jurisdictions apply to each first customer?
- Which offline, latency, retention and audit requirements are mandatory rather than desirable for each workflow?

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

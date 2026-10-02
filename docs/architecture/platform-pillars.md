---
title: InferOS platform baseline
covers:
  - packages/workshop-backend
  - packages/workshop-frontend
  - packages/workshop-shared
  - packages/router
updated: 2026-10-01
---

# InferOS platform baseline

## Overview

InferOS is a Cloudflare Workers application with a browser SPA and sandboxed Gadgets. This baseline describes commit `1045d2e1ceac7be29e1a6f056c936fb31aa00851`; it separates existing native mechanisms from the [intended pillars](../design/platform-pillars.md).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/router` | Public assets and path routing to backend/gatekeepers |
| `packages/workshop-frontend` | Client-side React application and sandboxed iframe hosting |
| `packages/workshop-shared` | Cap’n Web and gatekeeper contracts |
| `packages/workshop-backend` | Kernel, native agents, persistent state and capability issuance |
| `packages/gatekeeper-*` | Configured external-service Workers; gatekeeper-kit is a library |

## Data and Control Flow

The browser connects to the kernel over persistent Cap’n Web RPC. Gadgets execute within sandbox boundaries and use explicitly granted bindings. Gatekeepers mediate external data and actions; observed reads and approval queues are existing mechanisms. Blueprint artifacts carry code and required bindings, not credentials or live state. Admin policy controls offered resources and auto-provisioning, while sign-in policy stays in environment configuration.

InferOps is a separate transactional application. Its board/widget code and AI Trader’s registry provide reusable evidence, but neither repository is implicitly installed into this runtime. See the paired topic documents for inspected paths and gaps.

## Configuration

Worker cloudflare.config.ts files generate committed wrangler.jsonc files. Router/backend service bindings and deployment input metadata determine installability. The current development runner uses Wrangler/workerd. Vite runs separately on port 3000; the router falls back to the backend, rather than proxying Vite. No wrapper skills or subscription account implementation is established by these facts.

## Divergences from Design

The planned ChatGPT subscription connection, reusable authoring qualification, complete consuming-repository skill suite, InferOps gatekeeper, guarded shared canvas and agent activity feed require implementation. Existing local tools need wrapper and parity work. The research wiki is a documented decision aid, not implemented vertical functionality.

## Open Questions

See each [draft pillar](../design/platform-pillars.md) and the [roadmap](../wiki/implementation-roadmap.md).

The first consumer bootstrap/parser and skill are now implemented in the working tree; see [consumer configuration](consumer-configuration.md). Runtime data/view/style integration is still outstanding.

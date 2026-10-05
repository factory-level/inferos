---
title: InferOS platform baseline
covers:
  - packages/workshop-backend
  - packages/workshop-frontend
  - packages/workshop-shared
  - packages/router
updated: '2026-10-05'
obsidian_designs:
- note: software/InferOS/InferOS Cloudflare OS Fork.md
  sections:
  - Platform requirements
---

# InferOS platform baseline

## Overview

InferOS is a Cloudflare Workers application with a browser SPA and sandboxed Gadgets. This page describes the native mechanisms every pillar builds on, separately from the [intended pillars](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Platform%20requirements). Each topic page records what its pillar has implemented; the [implementation roadmap](../wiki/implementation-roadmap.md) tracks merged work against the MVP walkthrough in [#1](https://github.com/factory-level/inferos/issues/1).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/router` | Public assets and path routing to backend/gatekeepers |
| `packages/workshop-frontend` | Client-side React application and sandboxed iframe hosting |
| `packages/workshop-shared` | Cap’n Web and gatekeeper contracts |
| `packages/workshop-backend` | Kernel, native agents, persistent state and capability issuance |
| `packages/gatekeeper-*` | Configured external-service Workers; gatekeeper-kit is a library |
| `custom-gatekeepers/gatekeeper-*` | This fork's own gatekeepers, currently `gatekeeper-inferops` |

## Data and Control Flow

The browser connects to the kernel over persistent Cap’n Web RPC. Gadgets execute within sandbox boundaries and use explicitly granted bindings. Gatekeepers mediate external data and actions; observed reads and approval queues are existing mechanisms. Blueprint artifacts carry code and required bindings, not credentials or live state. Admin policy controls offered resources and auto-provisioning, while sign-in policy stays in environment configuration.

InferOps is a separate transactional application. InferOS reaches it only through the fork's InferOps gatekeeper, with each person's own InferLab session ([InferOps gatekeeper](inferops-gatekeeper.md)), and shows boards through the Kanban blueprint and the canvas ([InferOps canvas](inferops-canvas.md)) and the operate session ([Operate mode](operate-mode.md)). AI Trader's registry is reusable evidence, not installed code. See the paired topic documents for inspected paths and gaps.

## Configuration

Worker cloudflare.config.ts files generate committed wrangler.jsonc files. Router/backend service bindings and deployment input metadata determine installability. The development runner uses Wrangler/workerd; see [local development](local-development.md).

## Divergences from Design

Partly implemented, all without live acceptance: the InferOps gatekeeper (per-person accounts, governed reads and writes), the canvas and Kanban, attributed board activity, the operate session, local lifecycle commands, and ChatGPT plan usage through a local companion only. Not implemented: a Cloudflare-hosted ChatGPT connection, reusable authoring qualification, the complete consuming-repository skill suite, wrapper topology and cloud parity, and the InferMind Wiki host. The research wiki is a documented decision aid, not implemented vertical functionality.

## Open Questions

See each [draft pillar](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20OS%20Fork.md%23Platform%20requirements) and the [roadmap](../wiki/implementation-roadmap.md).

The consumer bootstrap, parser and skills are described in [consumer configuration](consumer-configuration.md); applied profiles and styling ([#35](https://github.com/factory-level/inferos/issues/35)) are still outstanding.

## Design authority

The `obsidian_designs` front matter identifies intended design in the `authored` vault.
Read the owning notes through the [Obsidian CLI workflow](_brain.md); references do not
imply complete implementation.

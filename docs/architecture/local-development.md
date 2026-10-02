---
title: Cloudflare-like local development
covers:
  - scripts/run-dev-server.ts
  - scripts/run-local.ts
  - scripts/dev
  - packages/workshop-backend/scripts/dev-setup.ts
  - packages/workshop-shared/src/password-salt.ts
  - scripts/dev-server-config.ts
  - cloudflare.config.ts
  - scripts/worker-config.ts
  - scripts/worker-dirs.ts
  - custom-gatekeepers
  - packages/router
  - packages/integration-tests
updated: 2026-10-02
---

# Cloudflare-like local development

## Overview

Current-state baseline inspected at InferOS `1045d2e1ceac7be29e1a6f056c936fb31aa00851`. Proposed work is recorded in the [design](../design/local-development.md), not asserted as implemented here.

## Components

| Path | Responsibility |
| --- | --- |
| `scripts/run-dev-server.ts` | Discovers configured workers, generates dev wiring, builds gatekeeper UIs and starts Wrangler/watchers. |
| `scripts/run-local.ts` | Convenience local install/build/run flow. |
| `packages/workshop-backend/scripts/dev-setup.ts` | `pnpm dev:setup`: prepares a running local Workshop (account, onboarding, mock model, InferOps, demo screen). |
| `scripts/dev/scripted-model.ts` | `pnpm dev:mock-model`: a scripted, credential-free stand-in model for local agent flows. |
| `scripts/worker-config.ts` | Shared canonical Worker configuration factory. |
| `packages/router` | Public routing and frontend assets/backend fallback. |
| `packages/integration-tests` | Real Workers and RPC test harness with external network interception. |

## Data and Control Flow

The repository already has multi-worker Wrangler development and a Vite frontend. Discovery requires a wrangler.jsonc, so gatekeeper-kit is not a Worker. The dev runner scans this repository’s `packages/` and `custom-gatekeepers/` (the fork’s own gatekeepers), both listed once in `scripts/worker-dirs.ts`, which config generation, worker types, the release manifest and previews also use; a package name present in both is rejected. Arbitrary wrapper-owned gatekeeper directories outside this repository are still not a supported discovery contract. The integration harness exercises real RPC and Workers, but is not a consuming-repository bootstrap product. The working-tree run-local now assigns frontend assets to the public router, deriving ASSETS binding, SPA fallback and worker-first paths from the generated production router configuration. The backend no longer receives a second assets configuration. Normal Vite development still uses its separate port. The baseline commit predates this parity fix.

## Preparing a local instance

`pnpm dev:setup` drives a running local Workshop over the same Cap'n Web API the browser uses, so neither a person nor an agent clicks through signup, onboarding and settings before testing. It signs in as `dev`/`devpassword` (the `VITE_DEV_AUTO_LOGIN` defaults; `--user`/`--password` override), creating the account on first run. The password hash is derived exactly as the browser derives it (Argon2id over `SERVICE_SALT` plus the username, via Node's `crypto.argon2Sync`), so the same credentials work on the login page; `SERVICE_SALT` lives in its own import-free `password-salt.ts` so Node tooling can import it. It then marks onboarding complete and, on request:

- `--mock-model [url]` registers the scripted model as an Ollama model (default `http://localhost:11434`) and makes it the preferred model. `pnpm dev:mock-model` serves it: it answers in the OpenAI-compatible format and plays the agent's side of "add an InferOps Kanban to this canvas", choosing each step from the conversation so far. Every action it triggers runs through the real Workshop and gatekeepers.
- `--inferops` opts into the auto-provisioned InferOps gatekeeper (mock data).
- `--screen <templateId>` ensures an "InferOps Canvas demo" workspace with a screen from that catalog template, and reports its URL.

Every step is idempotent. The JSON report includes the session token, which a browser (or a browser-driving agent) adopts with `localStorage.setItem("authToken", token)`. The command refuses any host but localhost or 127.0.0.1.

## Configuration

cloudflare.config.ts is authoritative; pnpm configs:generate emits wrangler.jsonc. The default frontend and backend ports are 3000 and 8787. .dev.vars supplies local values with shell overrides. Remote Workers AI requires account access. See the settings and parity wiki pages.

## Divergences from Design

Wrapper discovery, machine-readable lifecycle commands, deterministic seed/reset and a reviewed topology parity contract remain planned.

## Open Questions

- Choose the wrapper configuration schema after comparing the upstream starter contract with this fork.
- The asset ownership difference is fixed in the working tree; wrapper extension discovery, cloud auth and real binding parity still need proof.

## Evidence

See [source ledger](../wiki/research-sources.md) for sibling repository revisions and official references.

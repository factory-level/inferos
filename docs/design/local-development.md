---
title: Cloudflare-like local development
status: draft
updated: 2026-10-01
---

# Cloudflare-like local development

Tracking epic: [#2](https://github.com/factory-level/inferos/issues/2); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Give a consuming repository a repeatable, agent-operable environment before it customizes an InferOS deployment.

## Requirements

- Use a wrapper repository with a pinned InferOS submodule; keep vertical gatekeepers, blueprints, configuration and skills in the wrapper.
- Use native pnpm, Wrangler and workerd. Docker and devcontainers are optional future packaging.
- Generate local and deployment topology from canonical configuration; keep the public router, backend, gatekeeper entrypoints and capability boundaries equivalent.
- Provide deterministic fixtures, isolated persistent state, readiness checks and structured lifecycle results; remote services require an explicit mode.
- Expose setup, start, stop, status, logs, seed, reset and verify operations to humans and agents. Reset must identify the local state directory and require explicit destructive intent.

## Behavior

A fresh clone initializes the pinned submodule, checks tool versions, installs locked dependencies, generates configurations, builds prerequisites, seeds synthetic data and starts the public origin. The same origin serves or proxies frontend assets and routes API and gatekeeper traffic. Readiness means an authenticated RPC and fixture board read succeed, not merely an open port. Re-running setup preserves customizations and data. Stop terminates owned watchers and workerd processes. A second wrapper uses distinct ports and state roots. Offline fixture mode intercepts external requests and fails on unexpected network access. A separate opt-in cloud smoke test checks the behaviors emulation cannot establish.

## Non-Goals

No production resource creation during local setup; no promise that local emulation proves Cloudflare Access, external OAuth, global limits or provider eligibility.

## Acceptance and delivery

### Generate wrapper-aware local and deployed Worker topology

Tracking issue: [#9](https://github.com/factory-level/inferos/issues/9) (`local-topology`).

- Load a pinned InferOS submodule and wrapper-owned gatekeepers without editing upstream files.
- Generate configs from cloudflare.config.ts and explicit wrapper inputs; never hand-edit wrangler.jsonc.
- Route frontend assets, /api and gatekeeper callbacks through the same public-origin shape.
- Test two isolated wrappers, absent optional bindings, library exclusion and configuration drift.

### Add local lifecycle, fixtures and agent diagnostics

Tracking issue: [#10](https://github.com/factory-level/inferos/issues/10) (`local-lifecycle`).

- Provide documented setup/start/stop/status/logs/seed/reset/verify operations with stable exit codes and JSON results.
- Seed repeatable synthetic board and approval scenarios; preserve local state across restarts.
- Confirm readiness with authenticated RPC; fail offline fixtures on unexpected external traffic.
- Test startup failure cleanup, port collision, repeated setup, shutdown and explicit reset boundaries.

### Verify local-to-Cloudflare behavior and document cloud-only checks

Tracking issue: [#11](https://github.com/factory-level/inferos/issues/11) (`local-parity`).

- Exercise router, Cap’n Web, Durable Object persistence, gatekeeper reads, approvals and reconnect in workerd.
- Document emulated, mocked, remote and cloud-only capabilities separately.
- Add an opt-in disposable deployment smoke recipe for Access, OAuth origins and real bindings.
- Record runtime/config versions and evidence; never imply mock provider success establishes subscription support.

## Open Questions

- Choose the wrapper configuration schema after comparing the upstream starter contract with this fork.
- Resolve the current run-local asset-serving difference before calling the local topology deployment-equivalent.

## Related

- [Current architecture](../architecture/local-development.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)

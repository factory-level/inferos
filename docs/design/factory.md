---
title: Software factory sandboxes and local CI
status: draft
updated: 2026-10-28
---

# Software factory sandboxes and local CI

## Purpose

Give every agent (Claude Code, the Codex coding runner, Workshop agents, Grok Bot) the same reproducible, credential-free place to build, run, attack and load InferOS and InferOps, and one release graph that runs identically in a shell, on the factory-server runner and in GitHub Actions. Tracking: [#285](https://github.com/factory-level/inferos/issues/285).

## Requirements

- The factory is (1) the skills agents consume and (2) the sandbox environments they run in. GitHub Actions and factory-server are consumers, not the factory.
- `pnpm local factory up <sandbox>|status|doctor|down` in InferOS (the vessel) manages four sandboxes: `dev` (InferOps stack via `bun run dev up --docker --seed` in its own checkout and toolchain, InferOS `pnpm run-local`), `infra` (dev + floci-gcp :4588 + Wrangler/Miniflare), `verify` (dev + security scanners, ZAP, Artillery with Playwright), `stage-probe` (no services; only the narrowly scoped smoke credentials).
- No sandbox holds cloud, model-provider or prod credentials, except `stage-probe`'s smoke credentials; `doctor` proves it and reports per-check READY/FAIL with health JSON.
- Each release-graph node is a script with one gate, wrapped by a reusable workflow built from thin composite actions; `scripts/ci/pipeline.ts --target=local` runs the same composition and writes evidence to `.factory/runs/<id>/<node>/`.
- Security: no new high/critical finding against a reviewed baseline. Perf: Artillery HTTP plus the Playwright engine with Web Vitals and `ensure` gates, ceilings proposed until agreed (#158, baselines from #28).
- Docker: ports on 127.0.0.1 only, never the Docker socket.

## Behavior

Graph order for InferOS: verify, security, build (wrangler dry-run, no account), local deploy, bindings proof, DAST, perf; later intake, e2e, release to the dev/prod stages, grokbot smoke and rollback. A gate failure stops the run with a non-zero exit. A mocked check or a validated config is never reported as proof.

## Non-Goals

- Deploying from the factory graph's local target.
- Holding any long-lived credential in a sandbox other than `stage-probe`.

## Open Questions

- Isolation: rootless container vs microVM per agent run, and the egress allowlist.
- Numeric perf budgets (#158).

## Related

- Architecture: [`../architecture/factory.md`](../architecture/factory.md)

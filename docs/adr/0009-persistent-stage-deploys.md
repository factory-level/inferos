---
title: Persistent stages deploy real prefixed Workers
status: proposed
date: 2026-10-27
---

# 0009. Persistent stages deploy real prefixed Workers

## Context

The owner asked for two long-lived InferOS instances, `dev-os.factorylevel.dev` and `os.factorylevel.dev`, each behind Cloudflare Zero Trust and each connected to its own InferLab environment, deployed from a workstation first. That un-defers part of [#11](https://github.com/factory-level/inferos/issues/11) (local-to-cloud behaviour). The repository had two cloud paths, and neither fits:

- **Worker Previews** (`scripts/preview`) are per-PR branches of a baseline worker. They are reachable only at public `workers.dev` URLs, cannot carry a custom domain, need a draft Wrangler build, and are swept when their PR closes. Their Durable Objects belong to the baseline, so they are not a stable home for user data.
- **The release pipeline** (`scripts/release`) produces a manifest for a deploy service that lives outside this repository.

## Decision

A stage is a real `wrangler deploy`, with the workspace's pinned Wrangler, of every package it lists, named `<workerPrefix><package>`, with service bindings renamed to match and binding names unchanged. Each stage has its own explicitly titled KV namespaces and R2 bucket. Only the router is reachable, at the stage hostname as a custom domain. Access gates the hostname at the edge, and the Workshop signs people in with InferLab (no `CF_ACCESS_*` on the backend). Stage definitions are committed in `scripts/stage/stages.ts`, and secrets travel only in `--secrets-file`. A stage's prefixes are immutable once deployed.

## Consequences

- Durable Object state survives every deploy, because worker names are stable. Renaming a prefix, or a destructive migration, would lose it, so the deploy refuses destructive migrations without an explicit flag.
- The Access application is created by hand. The deploy only proves afterwards that an unauthenticated request is redirected to Access.
- Two Access layers would conflict, so the backend never verifies the Access JWT. The InferLab session is the application-level identity, and Access is the perimeter.
- Third-party gatekeepers are not deployed until a stage configures their OAuth apps.
- No CI job runs a stage yet.

## Alternatives Considered

- Reuse Worker Previews with a pinned preview name: no custom domain, public URLs, and a draft Wrangler.
- Implement the deploy service's renderer against the release manifest: the right long-term shape for customer instances, but much larger, and the service is not in this repository.
- Backend-verified Access (`CF_ACCESS_AUD`): this disables InferLab sign-in, which the stages exist to exercise.

## Related

- Architecture: [`../architecture/stage-deploy.md`](../architecture/stage-deploy.md)
- Runbook: [`../wiki/stage-deploy.md`](../wiki/stage-deploy.md)
- Design: [`../design/local-development.md`](../design/local-development.md)

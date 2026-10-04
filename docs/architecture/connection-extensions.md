---
title: Connection packages and reviewed fork updates
covers:
  - packages/gatekeeper-kit/src/conformance.ts
  - packages/gatekeeper-kit/__tests__/workerd/conformance/adapter.ts
  - custom-gatekeepers/gatekeeper-inferops/connection.json
  - custom-gatekeepers/gatekeeper-inferops/__tests__/conformance.test.ts
  - custom-gatekeepers/gatekeeper-inferops/__tests__/conformance-adapter.ts
  - scripts/connection-package.schema.json
  - scripts/connection-package.test.ts
updated: 2026-10-03
---

# Connection packages and reviewed fork updates

## Overview

The package pattern's first two pieces exist: a **shared conformance suite** any gatekeeper can run
through a small adapter, and a **package contract** (`connection.json`) checked against a schema
and against the package's own source. The InferOps gatekeeper
(`custom-gatekeepers/gatekeeper-inferops`) is the reference package: it carries a contract with
status `reference` and passes the suite for its `project/board` kind. The kit's synthetic
gatekeeper passes the same suite, which is what shows it is reusable without copying.

Nothing else from the [design](../design/connection-extensions.md) is implemented: no scaffolder,
no manifest loading at deploy or dev time, no file classification, no upgrade or reconciliation
CLI. Part of [#73](https://github.com/factory-level/inferos/issues/73), under
[#51](https://github.com/factory-level/inferos/issues/51).

## Components

| Path | Responsibility |
| --- | --- |
| `packages/gatekeeper-kit/src/conformance.ts` | `defineConformanceSuite(adapter, { describe, it, beforeEach })`, exported as `@gadgets/gatekeeper-kit/conformance`. Registers the shared cases through the calling test file's own vitest functions, so it runs in that package's pool (workerd for every gatekeeper today). Imports neither vitest nor `cloudflare:*`. `ConformanceAdapter<F>` maps the suite's steps onto one gatekeeper. |
| `packages/gatekeeper-kit/__tests__/workerd/conformance/adapter.ts` | The adapter for the kit's synthetic gatekeeper (`ConformanceAccount`/`ConformanceResource` over `FakeProvider`). `conformance.test.ts` registers the shared suite through it and keeps the kit-only cases (connect races, stages, cursors, journals, fences) local. |
| `custom-gatekeepers/gatekeeper-inferops/__tests__/conformance-adapter.ts`, `conformance.test.ts` | The adapter for a demo account's `DEMO` board binding over `MockInferOps`, driven through `TestHooks` as the overseer drives it. Provider faults come from the test worker's `MockInferOps` subclass (`failNextWrite("unavailable" | "lost")`), exported under the production name so every binding's client opens it. |
| `custom-gatekeepers/gatekeeper-inferops/connection.json` | The package contract: entrypoints and Durable Objects; per resource kind (`project/board`, `project/dispatch`, `knowledge/wiki`) its URL pattern, gatekeeper class, session type, scope, enabling switches, observer strategy, read calls and write calls (each with its concurrency check, idempotency mechanism and revert rule); approval behaviour; every provider error code with its meaning and whether a retry can succeed; simulation limits; configuration names (never values); the InferOps revision the board DTO schema is pinned to; and which conformance cases run where. |
| `scripts/connection-package.schema.json` | JSON Schema (draft 2020-12) for `connection.json`, format `schemaVersion: 1`. Closed objects throughout, so a credential cannot carry a value. Status is `scaffold`, `reference` or `production`. |
| `scripts/connection-package.test.ts` | `node --test` (part of `@gadgets/scripts`' `test` task): finds every `connection.json` one level under `packages/` and `custom-gatekeepers/`, validates it with the schema (zod's `fromJSONSchema`), and checks it against source: each `urlPattern` is declared in `src/` and names its `kind`; every entrypoint, Durable Object and resource gatekeeper is a class in `src/`; every session is an interface and every listed read and write method exists; every configuration name is read in `src/`; each pinned contract file's `source.revision` equals the recorded provider revision; each conformance test file imports and registers the suite; conformance names only listed kinds. |

## Data and Control Flow

A package's test file calls `defineConformanceSuite(adapter, { describe, it, beforeEach })`. For
each case the suite calls `adapter.setup()` for a fresh connected binding, drives it through the
adapter, and fails with a `ConformanceError` naming the broken property. Operations an overseer can
be refused return the refusal message (or `null`) instead of rejecting, so no RPC rejection goes
unhandled.

| Case | Hook | What must hold |
| --- | --- | --- |
| Resource scope | `scope` | An out-of-scope target is refused with exactly the refusal an unknown one gets. |
| Observation | — | A read is authorized as an observation before it returns. |
| Sharing (two cases) | — | A collaborator who cannot see the target is refused at admission or excluded from the observation; one who can is admitted and not excluded. |
| Approval | — | A write is submitted to the approval queue and has no effect until applied; applied, it lands once. |
| Apply once | — | An approval delivered twice applies once and answers the repeat as success. |
| Stale revision | `staleRevision` | A write whose target moved on after proposal is refused at apply and never lands. |
| Server error retry | `faults` | A provider 5xx before commit leaves the write retryable; a retry lands it once. |
| Lost response retry | `faults` | A committed write whose response was lost is reported failed, and a retry (replayed or refused) never adds a second effect. |
| Revocation (two cases) | — | After revocation reads fail, and a write approved before it does not land. |

An adapter that omits an optional hook gets that case registered as skipped, with its
`notExpressed` reason in the name.

| Gatekeeper | Runs | Skipped |
| --- | --- | --- |
| Kit synthetic | all but stale revision (10) | stale revision: the fake provider has no revisions |
| InferOps `project/board` | all (11) | — |

The InferOps contract records the cases its other kinds cover in their own suites
(`dispatch.test.ts`, `wiki.test.ts`) and the ones not tested for them (revocation and server-error
retry for `project/dispatch` and `knowledge/wiki`, which share the board's data source and
credentials), and that a connected person's revocation is covered by `account.test.ts` rather than
the suite.

The suite found that revoking a demo account did not stop its bindings: `MockInferOps.forget()`
deleted the account's data, and the next call re-seeded fresh demo data, so a held session kept
reading and an action approved before revocation applied into the new copy. `forget()` now leaves a
tombstone, and every later call is refused `UNAUTHORIZED`.

## Configuration

None at runtime. `connection.json` lists the package's configuration names; the schema test fails
when one is not read in `src/`.

## Divergences from Design

- The design's manifest open question is answered for the package contract only:
  `connection.json` with `schemaVersion` (a breaking format change raises it, and the schema refuses
  versions it does not know) and a provider compatibility pin (`compatibility.provider.revision`
  plus the generated contract files pinned to it). Nothing loads it yet, so "manifest loading fails
  closed on disabled, unlisted or incompatible entries" is not implemented.
- Upgrade-failure cases ("upgrade failures pass a shared real-contract fixture suite") are not in
  the suite; there is no upgrade mechanism to test.
- The second connector is the kit's synthetic gatekeeper, which predates this work; nothing was
  scaffolded "through the same pattern" because no scaffolder exists.
- Skills, SOPs and setup or troubleshooting material are not part of the package contract yet.

## Open Questions

- The InferOps HTTP API is unversioned (`apiVersion: null`); only the board DTO has a generated,
  pinned contract. Issue, run, repository and knowledge endpoints are not pinned.
- How file classification and three-way reconciliation are recorded (design open questions) is
  untouched.
- Whether `project/dispatch` and `knowledge/wiki` should get their own adapters, or the suite a way
  to run one adapter per kind.

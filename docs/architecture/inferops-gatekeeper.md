---
title: InferOps gatekeeper
covers:
  - custom-gatekeepers/gatekeeper-inferops
  - packages/bundled-blueprints/blueprints/inferops-kanban
  - packages/gatekeeper-kit
  - packages/workshop-shared/src/gatekeeper.ts
  - packages/workshop-backend/src/user.ts
  - scripts/release/manifest-lib.ts
updated: 2026-10-02
---

# InferOps gatekeeper

## Overview

`custom-gatekeepers/gatekeeper-inferops` (package `@inferos/gatekeeper-inferops`, vendor id
`inferops`) implements the reviewed agent-facing API from the
[design](../design/inferops-gatekeeper.md) over **mock data**. Its `src/types.d.ts` is the design's
`inferops-gatekeeper-api.d.ts` verbatim: `InferOpsProjectSession` (`readBoard`, `openIssue`) and
`InferOpsIssueSession` (`read`, `transition`). The gatekeeper code is written against a data-source
contract (`src/inferops-client.ts`) that `src/mock-inferops.ts` implements; replacing that one
module with an InferOps HTTP client is the path to live data. The bundled
`inferops.kanban` blueprint renders a bound board as a Kanban gadget.

## Components

| Path | Responsibility |
| --- | --- |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops.ts` | Vendor (auto-provisioned accounts, no OAuth), account (`GatekeeperUser`), verifier, project-board gatekeeper facet, sessions, configurator RPC. |
| `custom-gatekeepers/gatekeeper-inferops/src/inferops-client.ts` | `InferOpsClient` data-source contract and `InferOpsError` codes (`NOT_FOUND`, `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`, `IDEMPOTENCY_CONFLICT`, `INVALID_REQUEST`). |
| `custom-gatekeepers/gatekeeper-inferops/src/mock-inferops.ts` | `MockInferOps` Durable Object per (host, account), seeded from `src/fixtures/demo-board.json`; the only module that holds project data. |
| `custom-gatekeepers/gatekeeper-inferops/src/resources.ts` | Resource grammar `inferops://<host>/project/board/<KEY>` (default host `demo.local`). |
| `custom-gatekeepers/gatekeeper-inferops/src/simulation.ts` | Board ordering and read-time overlay of pending transitions. |
| `custom-gatekeepers/gatekeeper-inferops/src/configurator/project-ui.tsx` | Project picker built by the shared `build:configurator` task. |
| `packages/bundled-blueprints/blueprints/inferops-kanban` | Kanban gadget expecting a `board` binding of type `InferOpsProjectSession`. |
| `scripts/release/manifest-lib.ts` | Lists the gatekeeper as taking no default OAuth inputs and as install-once. |

## Data and Control Flow

- **Accounts.** `GatekeeperVendor.describe()` sets `autoProvisionsAccount`; `createAccount()` mints
  an `InferOpsAccount` whose only prop is a random `accountId`. It declares no singleton and no
  management UI, so the Workshop reaches it only through URL-addressed resources. Provisioning
  follows the admin's per-vendor mode; the gatekeeper asserts no ambience.
- **Binding.** `InferOpsAccount.getGatekeeperClassFor(url)` parses the URL, checks the project
  exists for the account, and returns `InferOpsProjectGatekeeper` with props
  `{accountId, host, projectKey}`. Sessions read scope only from those props; no method takes a
  project, host or account. The mock serves only `demo.local` and refuses other hosts.
- **Reads.** `readBoard()` and `InferOpsIssueSession.read()` overlay pending transitions, then call
  `authorizeObservation` before returning. `openIssue(id)` is not an observation (UUID existence) and
  fails with the same `NOT_FOUND: No such issue in this project.` for an unknown issue and for an
  issue of another project.
- **Transitions.** `transition(toStateId, expectedRevision)` checks state membership
  (`INVALID_STATE`), workflow (`WORKFLOW_MISMATCH`) and the simulated revision (`STALE_REVISION`),
  records a pending action in the facet's KV, then calls `submitAction` (no auto-approvable kinds).
  Until decided, reads show the issue in the target state at `expectedRevision + 1`, so moves chain.
  `applyAction` calls the data source with idempotency key `<facet instance id>:<action id>`; the
  data source rechecks scope, state, workflow and revision, and a replayed key returns the stored
  result without re-applying. A stale apply fails with a message telling the approver to discard the
  move. `rejectAction` deletes the record, which ends the simulation. `revertAction` moves the issue
  back only if it is still where the move left it.
- **Observers.** Strategy B: `addObserver` asks the collaborator's own `InferOpsVerifier` whether
  their account can open the bound project; `removeObserver` is a no-op.
- **Kanban gadget.** Its Durable Object proxies `loadBoard()` to `env.board.readBoard()` and
  `moveIssue()` to `env.board.openIssue(id).transition(stateId, revision)` (pipelined, then
  disposed), returning failure codes as data. The client renders columns, drag and drop, and a
  per-card "Move to…" select, reloads on `STALE_REVISION`, and shows a not-connected notice when the
  binding is absent.

## Configuration

`cloudflare.config.ts` uses the shared gatekeeper factory (`allow_irrevocable_stub_storage`,
migration `v0`: `MockInferOps`, `InferOpsProjectGatekeeper`); `wrangler.jsonc` is generated. The
worker needs no secrets or vars. Discovery under `custom-gatekeepers/` binds it as
`GATEKEEPER_INFEROPS`. The release manifest gives it no deploy inputs and marks it install-once.

## Divergences from Design

- InferOps is mocked: authentication, the external API contract and companion InferOps endpoints are
  not implemented. Accounts are auto-provisioned per user rather than connected to an InferOps
  identity, so "permission mapping" is the mock's per-account project list.
- The simulated revision assumes InferOps increments revisions by one per transition, which the mock
  does; a real client must confirm or replace this.
- No "pending" marker is exposed on `Issue`, so the agent-facing API stays verbatim; the Kanban
  gadget marks moves it requested itself until the next refresh.

## Open Questions

- Agree the external InferOps authentication and API contract, including service versus user authority.
- Does the existing transition endpoint provide sufficient idempotency for approved action retries, or is a companion InferOps change required?

## Evidence

`custom-gatekeepers/gatekeeper-inferops/__tests__/` (workerd) covers board reads and observations,
cross-project denial, invalid state, workflow mismatch, stale revision at proposal and at apply,
duplicate apply replay, rejection clearing the simulation, revert, and observer admission.
`packages/bundled-blueprints/blueprints/inferops-kanban/__tests__/` covers the gadget's server and
board rules. See [source ledger](../wiki/research-sources.md) for sibling repository revisions.

---
title: Local coding workflows and agent dispatch
status: draft
updated: 2026-10-02
---

# Local coding workflows and agent dispatch

Tracking epic: [#48](https://github.com/factory-level/inferos/issues/48); roadmap: [#1](https://github.com/factory-level/inferos/issues/1); companion InferOps runner work: [factory-level/inferops#2327](https://github.com/factory-level/inferops/issues/2327). Decision record: [ADR 0002](../adr/0002-local-coding-scope.md).

## Purpose

From a local InferOS customer environment, let a human or an authorized native or external agent invoke an approved coding workflow against an allowlisted local repository. A supported signed-in coding tool runs locally, plans, edits and tests, and returns a reviewable local diff or patch with actual test evidence.

The capability sits behind `CODING_WORKBENCH_ENABLED` (see [feature capabilities](feature-capabilities.md)). This is a draft target and implementation backlog; no code, deployment, acceptance or provider proof is complete.

## Requirements

### No LLM API key

- Planning, implementation, model-assisted review and orchestration require no LLM API key.
- Local execution may still use the coding subscription provider's network service. Local does not mean offline inference.
- Platform authentication and repository authorization remain necessary. They are not LLM API keys.

### Ownership

- InferOS owns local setup, feature resolution, workflow controls and adapter selection.
- InferOps owns task identity, authorized dispatch intent, task/run/attempt correlation, leases and business transitions. Native execution stays with the selected runner; telemetry is not a second authority over task state.
- InferMind supplies authorized wiki, SOP and Master-page context and post-change documentation proposals. Graph research or a cloud embedding provider must not block local coding.
- The official signed-in coding tool owns subscription authentication. InferOS does not collect or copy subscription credentials or reinterpret them as generic API tokens.
- The local checkout and Git own source revisions and reviewable changes. Partial work must remain recoverable.

### Reuse the existing runner

InferOps already contains `apps/_inferops-cli/src/runner/codex.ts`, project dispatch/run/lease contracts and `inferops runner codex`. Extend that implementation through a thin adapter or shared runner seam. Do not create a second work ledger, another authoritative task board, a second general workflow engine, or separate user and developer command systems.

The existing runner's direct backend client is a baseline to adapt, not proof of the proposed Gatekeeper boundary. Its current clone, push and draft-PR path is not sufficient for a local-only patch workflow.

### Feature and safety

- `CODING_WORKBENCH_ENABLED=false` denies new workflow dispatch in server and domain entrypoints, the CLI, tools and the UI. Stale clients and direct requests are tested.
- Enabled is availability, not activation or access. Deploying the customer OS must not install credentials or start local coding work automatically.
- Existing work has an explicit disable, drain and cancel policy. Read-only diagnostics, audit and recoverable artifacts are preserved. Hiding the UI must not orphan a running child.
- The child environment is adapter-specific and constrained. The current runner copies most environment variables after deleting named platform and Git tokens; add an allowlist and explicit rejection or removal of incompatible API-billing configuration for subscription-only mode. Test with `OPENAI_API_KEY` and other provider variables present. This is a code gap, not a claim that a live run billed an API.
- A worktree is not a sandbox. Enforce approved working roots, a restricted process environment and runtime permissions. Coding children get no production credentials, no unreviewed repository startup hooks and no unrestricted platform credential.
- Gatekeepers govern platform access. An external or local host does not inherit complete CloudflareOS containment merely by installing a plugin.
- Retain diffs and test evidence on failure or disconnect until an explicit cleanup or retention policy applies. Redact shared logs. Uncertain completion reconciles; it does not spawn duplicate work.

## Behavior

1. Resolve the local profile and flag. Inspect the installed supported coding runtime and its signed-in readiness without printing credentials.
2. Register and allowlist a repository and an explicit local coding workflow with approved command templates, context selection, time and concurrency limits, and result expectations. Arbitrary remote shell strings and model-chosen repository roots are not trusted configuration.
3. Authenticate the invoking human or agent separately from the coding subscription identity. Dispatch authority is required; ordinary issue-edit or knowledge-write rights are insufficient.
4. Submit a revision-bound, idempotent dispatch through the governed platform path. Bind tenant, workspace, project, repository, source revision, workflow revision and caller identity.
5. Claim the existing execution record before running. Execute in a dedicated checkout or worktree on the local machine. Preserve lease fencing, heartbeat and external session identity.
6. Run planning, coding and bounded verification using the selected official coding tool and deterministic test commands. Return local artifacts first. Optional commit, push or PR actions require distinct permission.
7. Report queued, running, waiting for input, quota or login blocked, failed, cancelled or unknown truthfully, mapped onto existing durable states with an explicit compatibility migration where needed. A successful enqueue is not completion, and model text is not test evidence.
8. Pause on subscription exhaustion or login failure. Never silently select API billing, a hosted runner or a different account.
9. Keep review, merge, deploy and acceptance separate. Neither agent dispatch nor coding success authorizes production deployment or permission expansion.

A human can invoke the local path without a second model-funded supervisor. An external agent calls the same scoped operation.

## Non-Goals

- A hosted coding service or remote runner fleet.
- Subscription inference inside Workers, or a commercial-hosting eligibility matrix.
- Reuse of AutoClaude code or a polished AutoClaude-style GUI. AutoClaude is workflow inspiration only.
- A required push or PR for local acceptance. GitHub publication is a later, separately authorized action.
- Replacing or closing the [personal ChatGPT connection](chatgpt-connection.md), which stays a separate optional track.
- A dependency on Harness HG or on native [agent deployments](agent-deployments.md).

## Acceptance and delivery

Delivery slices:

- Adopt the existing Codex runner behind a minimal local runner/workflow contract and feature gate.
- Add local checkout/worktree and patch-result mode without a required GitHub push or PR or a model API key.
- Expose one authorized dispatch/status/result path to humans and native or external agents through the single CLI/tool contract.
- Add actual test-result artifacts, credential and billing preflight, and recovery and disable conformance tests.
- Add setup, operate and recovery skills and SOPs and a minimal local OS control surface.
- Prove the first signed-in coding adapter end to end. A second adapter is qualified later and is not the first local demo gate.

Acceptance:

- A clean local customer environment runs one real task through the coding workflow to a local diff or patch plus captured test results, without an LLM API key anywhere in that workflow.
- An authorized agent invokes the same workflow; an otherwise valid agent without dispatch permission is denied.
- `HARNESS_HG_ENABLED=false` does not prevent local coding, and native subscription inference is not required.
- Disabled flag, wrong tenant or repository, duplicate dispatch, stale revision, expired login or quota, cancellation, restart, lost lease and partial-result retention have executed tests.
- No automatic push, merge, production deploy, identity elevation, API-billing fallback or remote-runner fallback.
- The exact runtime, version and auth mode and the actual local execution evidence are recorded. Mocked auth and historical PR tests are not labeled as a new live proof.

## Open Questions

- The shape of the adapter or shared runner seam, and whether it lives in InferOps, InferOS or a shared package.
- The mapping of the reported states onto the existing durable run states, and the compatibility migration it needs.
- The environment allowlist for each coding adapter in subscription-only mode.
- The retention and cleanup policy for diffs and test evidence.
- Which signed-in coding tool is the first proven adapter.

## Related

- [Feature capabilities](feature-capabilities.md)
- [Local development](local-development.md)
- [Repository setup skills](repo-setup-skills.md)
- [InferOps gatekeeper](inferops-gatekeeper.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Pillars](platform-pillars.md)

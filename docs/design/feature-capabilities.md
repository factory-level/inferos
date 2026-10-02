---
title: Customer feature capabilities
status: draft
updated: 2026-10-02
---

# Customer feature capabilities

Tracking: [capability flags #33](https://github.com/factory-level/inferos/issues/33); roadmap: [#1](https://github.com/factory-level/inferos/issues/1). Decision record: [ADR 0001](../adr/0001-customer-capability-flag-vocabulary.md).

## Purpose

Give every customer InferOS one versioned configuration contract that says which capabilities the installation offers, and have humans, coding agents, CI, the server, tools and the UI all read the same resolved result.

This is a draft target. Current code accepts only the legacy flags `composableViews`, `durableViews` and `customCloudflareCode` described in [consumer configuration](consumer-configuration.md). The eight names below are the intended vocabulary, not names the code accepts today.

## Requirements

### Vocabulary

| Flag | Responsibility |
| --- | --- |
| `INFEROPS_ENABLED` | Enable the tenant-scoped InferOps integration. It does not provision a tenant or grant resources. |
| `INFEROPS_CANVAS_STATE_MACHINE` | Enable stateful Operate flow behavior. A persisted canvas layout alone is not flow execution. InferOps owns business transitions; native CloudflareOS primitives own runtime execution. |
| `HARNESS_HG_ENABLED` | Enable the HG platform integration. Native deployments, other adapters and local coding stay independent of it. |
| `INFEROPS_AUTH` | Select the InferOps-backed identity integration. When it is off, another supported authentication mode is required; there is never an anonymous authorization bypass. |
| `PUBLISH_CLOUDFLAREOS_WIDGET` | Enable an explicit widget publication path with artifact, destination and audience review. Flag-on is not a public release. |
| `PUBLISH_CLOUDFLAREOS_APP` | Enable an explicit application publication path, separate from agent activation and from business data sharing. |
| `AGENT_DEPLOYMENTS` | Enable the reviewed native persona/skill [agent deployment](agent-deployments.md) lifecycle and scoped capability bindings. |
| `CODING_WORKBENCH_ENABLED` | Enable [local coding workflow](local-coding-workflows.md) invocation by authorized humans and agents using a supported signed-in coding tool, without an LLM API key. No hosted workbench and no required push or PR. |

Provider and runtime adapter versions, resource references, policies, publication destinations and secret references are separate configuration fields. Do not add a boolean for every provider.

### Migration and compatibility

- `inferos.config.json` stays versioned, with the exact foundation pin and nonsecret inputs.
- Implement an explicit migration and compatibility mapping from `composableViews`, `durableViews` and `customCloudflareCode`. The migration preserves existing customer configuration.
- Do not map a durable layout to state-machine execution, and do not treat custom code activation as an agent permission.
- Keep a low-level flag where its meaning differs from the new vocabulary.
- Unknown keys, invalid types, incompatible combinations and unsupported runtime capabilities fail clearly.
- Report truthfully which flags and schema versions the installation supports.

### Resolution

- Resolve baseline defaults, then the selected profile, then explicit customer overrides, and report provenance per field.
- Preserve existing explicit customer settings. No profile or rollout silently expands authority.
- Installation capability and feature rollout are independent. A rollout cannot enable code that is not present in the installation.
- Code generation, development and deployment consume the same resolved configuration. There is no undocumented second configuration path for users versus developers.

### Dependencies

- `INFEROPS_CANVAS_STATE_MACHINE` requires the InferOps integration and valid configured flow and runtime dependencies.
- Native deployments do not require HG.
- Local coding requires neither HG nor native ChatGPT subscription inference.
- Validate each dependency explicitly. Never turn on another flag silently.

### Enforcement

- Enforce feature availability at authoritative server operations, declared tools, the CLI and the UI.
- Conflicting flags, missing bindings, unsupported adapters, and direct or stale-client calls fail clearly without implicit activation or scope expansion.

## Behavior

### What a flag means

A flag states availability. Five states stay distinct: installed, enabled, account-connected, resource-granted, and activated or published. Turning a feature on does not create identities, copy data, bind credentials or start spend. Publication keeps its artifact, destination and audience explicit, and local coding does not require cloud publication.

### Disabling and re-enabling

Disabling a runtime feature follows an explicit admission, drain and cancel policy. Retained definitions, history and authorized diagnostics are preserved. Running work is not orphaned, and disabling does not imply deletion. Re-enabling does not restore revoked grants. Scope revocation stays effective after reload, after a feature is disabled and re-enabled, and after a copied view or artifact is imported.

## Non-Goals

- A claim that current code accepts the eight names.
- A boolean per provider.
- Flags that act as credentials, grants, activations, deployments or publications.
- Separate user and developer configuration systems.

## Acceptance and delivery

Tracking issue: [#33](https://github.com/factory-level/inferos/issues/33).

- A versioned migration preserves existing customer config and reports the desired flag and schema support accurately.
- Every flag has a named owner, default, dependencies, server/tool/CLI/UI enforcement path, disable and retention semantics, and an evidence fixture.
- Conflicting flags, missing bindings, unsupported adapters and direct or stale-client calls fail clearly without implicit activation or scope expansion.
- Two different customer fixtures preserve settings and custom code through an upgrade.
- Local coding works with HG disabled, with no native ChatGPT-inference requirement and no LLM API key; publication remains optional.
- Scope revocation remains effective after reload, disabled and re-enabled features, and copied view or artifact import.

## Open Questions

- The exact mapping from each legacy flag to the new vocabulary, and which legacy flags are retained because their semantics differ.
- The named owner and default for each flag.
- The drain or cancel policy for each runtime feature when it is disabled.

## Related

- [Consumer configuration](consumer-configuration.md) (current legacy flags, profiles and styling)
- [Pillars](platform-pillars.md)
- [Local coding workflows](local-coding-workflows.md)
- [Agent deployments](agent-deployments.md)
- [Agent platform integrations](agent-platform-integrations.md)
- [Connection extensions](connection-extensions.md)
- [Customer onboarding](customer-onboarding.md)

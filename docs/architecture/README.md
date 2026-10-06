# Architecture

Current implementation and explicit gaps against the paired draft designs.

Create documents from [`_template.md`](_template.md).

## Index

| Document | Covers | Summary |
| --- | --- | --- |
| [Platform pillars](platform-pillars.md) | Workshop, shared API, router | Overall scope and boundaries |
| [Cloudflare-like local development](local-development.md) | `scripts/run-dev-server.ts`, `scripts/run-local.ts`, `scripts/local`, `scripts/worker-config.ts`, `packages/workshop-backend/scripts`, `packages/router`, `packages/integration-tests` | Give a consuming repository a repeatable, agent-operable environment before it customizes an InferOS deployment. |
| [Personal ChatGPT connection](chatgpt-connection.md) | `assistant-plugins/openai`, `packages/workshop-backend/src/openai-plugin.ts`, `packages/workshop-backend/src/ai-models.ts`, `packages/workshop-frontend/src/features/openai` | ChatGPT plan usage through a local Bun companion, with an explicit API-key fallback; no Cloudflare-hosted connection. |
| [Reusable native agent authoring](agent-authoring.md) | `packages/workshop-shared/src/api.ts`, `packages/workshop-shared/src/agent-artifact.ts`, `packages/workshop-backend/src/agent-spawner-binding.d.ts`, `packages/workshop-backend/src/blueprint-archive.ts`, `packages/gatekeeper-scheduler`, `packages/gatekeeper-context/src/agent-skill.ts`, `docs/blueprints.md` | Native authoring APIs and an AI Trader registry inventory; the artifact revision contract is proposed (types and digest helper only). |
| [InferOS repository setup skills](repo-setup-skills.md) | `scripts/run-dev-server.ts`, `scripts/generate-worker-configs.ts`, `scripts/release/manifest-lib.ts`, `.agents/skills` | Let a coding agent configure and maintain a consuming repository with a ready-to-customize local environment and explained deployment settings. |
| [InferOps gatekeeper](inferops-gatekeeper.md) | `packages/gatekeeper-kit`, `packages/workshop-shared/src/gatekeeper.ts`, `packages/workshop-backend/src/user.ts`, `packages/mcp-shared` | Expose scoped InferOps project/board/issue reads and approved issue transitions as native capabilities. |
| [InferOps canvas and transactional widgets](inferops-canvas.md) | `packages/workshop-frontend/src/GadgetUI.tsx`, `packages/workshop-frontend/src/components/GadgetPresence.tsx`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/overseer.ts`, `packages/ui` | Make operational data easy to load, compose and act on through a simple canvas, starting with Kanban and later maps. |
| [Operate mode](operate-mode.md) | `packages/workshop-shared/src/operate-session.ts`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/user.ts`, `packages/workshop-backend/src/server.ts` | One operate session per person: a page state replayed from an ordered event log, live across tabs, plus an owner-only workspace for its operate chat. |
| [Vertical extension research and decision matrix](vertical-extension-research.md) | `docs/blueprints.md`, `packages/gatekeeper-kit`, `packages/gatekeeper-context`, `packages/gatekeeper-scheduler`, `packages/mcp-shared` | Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork. |
| [Consumer configuration](consumer-configuration.md) | `scripts/consumer`, bootstrap skill, admin configuration/API, Workshop theme | Bootstrap, wrapper blueprints, profile initialization and theme fallback; remaining adapters tracked |
| [Customer OS onboarding](customer-onboarding.md) | `scripts/consumer/intake.ts`, `scripts/consumer/intake.schema.json`, `scripts/consumer/fixtures/intake` | Reviewed intake to wrapper configuration, requirement dispositions and drafted gap issues; no upgrade or deploy command |
| [Customer feature capabilities](feature-capabilities.md) | `scripts/consumer/config.ts`, `scripts/consumer/runtime.ts`, `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts`, `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts` | Schema version 2 vocabulary; `INFEROPS_ENABLED`, `INFEROPS_AUTH` and `CODING_WORKBENCH_ENABLED` supported, five capabilities unsupported |
| [Connection packages and reviewed fork updates](connection-extensions.md) | `packages/gatekeeper-kit/src/conformance.ts`, `custom-gatekeepers/gatekeeper-inferops/connection.json`, `scripts/connection-package.schema.json`, `scripts/connection-package.test.ts` | Shared gatekeeper conformance suite and the `connection.json` package contract; the InferOps gatekeeper is the reference package. Scaffolding, manifest-gated discovery and reviewed three-way wrapper upgrades are implemented by #137/#138. |
| [Local coding workflows and agent dispatch](local-coding-workflows.md) | `custom-gatekeepers/gatekeeper-inferops/src/coding-workbench.ts`, `custom-gatekeepers/gatekeeper-inferops/src/configurator/dispatch-ui.tsx`, `scripts/consumer/config.ts`, `scripts/dev-server-config.ts` | Governed coding dispatch through the InferOps gatekeeper behind `CODING_WORKBENCH_ENABLED`; the runner itself is InferOps' |
| [Native agent deployments](agent-deployments.md) | `packages/workshop-shared/src/agent-deployment.ts` | Accepted contract only (types, lifecycle table, grant carry-forward); `AGENT_DEPLOYMENTS` still reported unsupported |

## Designs with no implementation yet

These draft designs from the 2026-10-02 baseline have no architecture page because no code implements them. Each gets one with the change that adds its first code.

| Design | Current state |
| --- | --- |
| [External-agent platform integrations](../design/agent-platform-integrations.md) | Provider-neutral design/fixtures only (#79/#80); all HG/#81 work is deferred. No bridge code. `HARNESS_HG_ENABLED` is accepted by the configuration schema and reported unsupported. Tracked by [#52](https://github.com/factory-level/inferos/issues/52). |

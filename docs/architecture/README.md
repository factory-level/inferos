# Architecture

Current implementation and explicit gaps against the paired draft designs.

Create documents from [`_template.md`](_template.md).

## Index

| Document | Covers | Summary |
| --- | --- | --- |
| [Platform pillars](platform-pillars.md) | Workshop, shared API, router | Overall scope and boundaries |
| [Cloudflare-like local development](local-development.md) | `scripts/run-dev-server.ts`, `scripts/run-local.ts`, `scripts/local`, `scripts/worker-config.ts`, `packages/workshop-backend/scripts`, `packages/router`, `packages/integration-tests` | Give a consuming repository a repeatable, agent-operable environment before it customizes an InferOS deployment. |
| [Personal ChatGPT connection](chatgpt-connection.md) | `assistant-plugins/openai`, `packages/workshop-backend/src/openai-plugin.ts`, `packages/workshop-backend/src/ai-models.ts`, `packages/workshop-frontend/src/features/openai` | ChatGPT plan usage through a local Bun companion, with an explicit API-key fallback; no Cloudflare-hosted connection. |
| [Reusable native agent authoring](agent-authoring.md) | `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/agent-spawner-binding.d.ts`, `packages/gatekeeper-scheduler`, `docs/blueprints.md` | Bring AI Trader’s reusable authoring discipline into InferOS while keeping execution on native Gadgets, bindings, callbacks and schedules. |
| [InferOS repository setup skills](repo-setup-skills.md) | `scripts/run-dev-server.ts`, `scripts/generate-worker-configs.ts`, `scripts/release/manifest-lib.ts`, `.agents/skills` | Let a coding agent configure and maintain a consuming repository with a ready-to-customize local environment and explained deployment settings. |
| [InferOps gatekeeper](inferops-gatekeeper.md) | `packages/gatekeeper-kit`, `packages/workshop-shared/src/gatekeeper.ts`, `packages/workshop-backend/src/user.ts`, `packages/mcp-shared` | Expose scoped InferOps project/board/issue reads and approved issue transitions as native capabilities. |
| [InferOps canvas and transactional widgets](inferops-canvas.md) | `packages/workshop-frontend/src/GadgetUI.tsx`, `packages/workshop-frontend/src/components/GadgetPresence.tsx`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/overseer.ts`, `packages/ui` | Make operational data easy to load, compose and act on through a simple canvas, starting with Kanban and later maps. |
| [Operate mode](operate-mode.md) | `packages/workshop-shared/src/operate-session.ts`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/user.ts`, `packages/workshop-backend/src/server.ts` | One operate session per person: a page state replayed from an ordered event log, live across tabs, plus an owner-only workspace for its operate chat. |
| [Vertical extension research and decision matrix](vertical-extension-research.md) | `docs/blueprints.md`, `packages/gatekeeper-kit`, `packages/gatekeeper-context`, `packages/gatekeeper-scheduler`, `packages/mcp-shared` | Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork. |
| [Consumer configuration](consumer-configuration.md) | `scripts/consumer`, bootstrap skill, admin configuration/API, Workshop theme | Bootstrap, wrapper blueprints, profile initialization and theme fallback; remaining adapters tracked |
| [Customer OS onboarding](customer-onboarding.md) | `scripts/consumer/intake.ts`, `scripts/consumer/intake.schema.json`, `scripts/consumer/fixtures/intake` | Reviewed intake to wrapper configuration, requirement dispositions and drafted gap issues; no upgrade or deploy command |
| [Customer feature capabilities](feature-capabilities.md) | `scripts/consumer/config.ts`, `scripts/consumer/runtime.ts`, `custom-gatekeepers/gatekeeper-inferops/src/enablement.ts` | Schema version 2 vocabulary; `INFEROPS_ENABLED` and `INFEROPS_AUTH` supported, six capabilities unsupported |

## Designs with no implementation yet

These draft designs from the 2026-10-02 baseline have no architecture page because no code implements them. Each gets one with the change that adds its first code.

| Design | Current state |
| --- | --- |
| [Local coding workflows](../design/local-coding-workflows.md) | No code. `CODING_WORKBENCH_ENABLED` is accepted by the configuration schema and reported unsupported ([feature capabilities](feature-capabilities.md)). Tracked by [#48](https://github.com/factory-level/inferos/issues/48). |
| [Connection packages and reviewed fork updates](../design/connection-extensions.md) | No connection-package, scaffolder or upgrade code. Its precursors are the fork's `custom-gatekeepers/` root ([local development](local-development.md)) and the wrapper Worker manifest ([consumer configuration](consumer-configuration.md#consumer-workers)). Tracked by [#51](https://github.com/factory-level/inferos/issues/51). |
| [External-agent platform integrations](../design/agent-platform-integrations.md) | No code. `HARNESS_HG_ENABLED` is accepted by the configuration schema and reported unsupported. Tracked by [#52](https://github.com/factory-level/inferos/issues/52). |
| [Native agent deployments](../design/agent-deployments.md) | No code. `AGENT_DEPLOYMENTS` is accepted by the configuration schema and reported unsupported. Tracked by [#53](https://github.com/factory-level/inferos/issues/53). |

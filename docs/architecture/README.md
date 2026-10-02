# Architecture

Current implementation and explicit gaps against the paired draft designs.

Create documents from [`_template.md`](_template.md).

## Index

| Document | Covers | Summary |
| --- | --- | --- |
| [Platform pillars](platform-pillars.md) | Workshop, shared API, router | Overall scope and boundaries |
| [Cloudflare-like local development](local-development.md) | `scripts/run-dev-server.ts`, `scripts/run-local.ts`, `scripts/worker-config.ts`, `packages/router`, `packages/integration-tests` | Give a consuming repository a repeatable, agent-operable environment before it customizes an InferOS deployment. |
| [Personal ChatGPT connection](chatgpt-connection.md) | `packages/workshop-backend/src/ai-models.ts`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/auth/config.ts` | Allow the owner of a personal Cloudflare InferOS install to use eligible ChatGPT subscription inference through official Sign in with ChatGPT. |
| [Reusable native agent authoring](agent-authoring.md) | `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/agent-spawner-binding.d.ts`, `packages/gatekeeper-scheduler`, `docs/blueprints.md` | Bring AI Trader’s reusable authoring discipline into InferOS while keeping execution on native Gadgets, bindings, callbacks and schedules. |
| [InferOS repository setup skills](repo-setup-skills.md) | `scripts/run-dev-server.ts`, `scripts/generate-worker-configs.ts`, `scripts/release/manifest-lib.ts`, `.agents/skills` | Let a coding agent configure and maintain a consuming repository with a ready-to-customize local environment and explained deployment settings. |
| [InferOps gatekeeper](inferops-gatekeeper.md) | `packages/gatekeeper-kit`, `packages/workshop-shared/src/gatekeeper.ts`, `packages/workshop-backend/src/user.ts`, `packages/mcp-shared` | Expose scoped InferOps project/board/issue reads and approved issue transitions as native capabilities. |
| [InferOps canvas and transactional widgets](inferops-canvas.md) | `packages/workshop-frontend/src/GadgetUI.tsx`, `packages/workshop-frontend/src/components/GadgetPresence.tsx`, `packages/workshop-shared/src/api.ts`, `packages/workshop-backend/src/overseer.ts`, `packages/ui` | Make operational data easy to load, compose and act on through a simple canvas, starting with Kanban and later maps. |
| [Vertical extension research and decision matrix](vertical-extension-research.md) | `docs/blueprints.md`, `packages/gatekeeper-kit`, `packages/gatekeeper-context`, `packages/gatekeeper-scheduler`, `packages/mcp-shared` | Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork. |
| [Consumer configuration](consumer-configuration.md) | `scripts/consumer`, bootstrap skill, admin configuration/API, Workshop theme | Bootstrap, wrapper blueprints, profile initialization and theme fallback; remaining adapters tracked |

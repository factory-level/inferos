---
title: InferOS platform pillars
status: draft
updated: 2026-11-02
---

# InferOS platform pillars

Tracking roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Build a configurable foundation for sandboxed personal applications and native AI agents, with a ready-to-customize local environment and an uncluttered operational canvas over InferOps data.

This is a draft specification and implementation backlog. It does not claim the planned integrations or skills have shipped. The supplied ChatGPT share URL could not be fetched; the explicit requirements and agreed plan in this working session are the requirements baseline.

## Requirements

| Pillar | Intended outcome |
| --- | --- |
| [Cloudflare-like local development](local-development.md) | Give a consuming repository a repeatable, agent-operable environment before it customizes an InferOS deployment. |
| [Personal ChatGPT connection](chatgpt-connection.md) | Allow the owner of a personal Cloudflare InferOS install to use eligible ChatGPT subscription inference through official Sign in with ChatGPT. |
| [Reusable native agent authoring](agent-authoring.md) | Bring AI Trader’s reusable authoring discipline into InferOS while keeping execution on native Gadgets, bindings, callbacks and schedules. |
| [InferOS repository setup skills](repo-setup-skills.md) | Let a coding agent configure and maintain a consuming repository with a ready-to-customize local environment and explained deployment settings. |
| [InferOps gatekeeper](inferops-gatekeeper.md) | Expose scoped InferOps project/board/issue reads and approved issue transitions as native capabilities. |
| [InferOps canvas and transactional widgets](inferops-canvas.md) | Make operational data easy to load, compose and act on through a simple canvas, starting with Kanban and later maps. |
| [Operate mode](operate-mode.md) | Run operations from what Build published, on three distinct surfaces: full-page apps, widgets for screens and the operate chat, and an optional ChatGPT-style full chat that each console can offer. Each operator role gets its own console of views, and Build stays with admins and leads. |
| [Vertical extension research and decision matrix](vertical-extension-research.md) | Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork. |
| Workspaces, canvases and widgets ([product design](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/workspaces-and-canvases.md)) | A workspace of named canvas pages with nested objects and widget instances; widget progression and canvas progression as distinct families; deterministic Build with an explicit target and a dedicated Canvas Builder; shared canvases with draft and published states. |
| Workflows ([product design](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/workflows.md)) | Definition, trigger, run, delegate and result kept distinct; Scheduled, Shared with me, Saved and Recent views; sharing, duplication and save-or-expire; runs that continue without an open canvas. |
| Agents and Dot ([product design](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/agent-operations.md)) | Agents configured by a Company Admin from gatekeeper capabilities; two execution-authority contexts; one personal Dot per user on CopilotKit/OpenDots that acts only through gatekeepers. |
| CRM module ([product design](https://github.com/factory-level/inferops/tree/develop/docs/human/architecture/domain-boundaries.md)) | The first business module, bootstrapped from trycompai/crm, resolving the same canonical InferOps record as canvases and global pages. |

## 2026-11-02 baseline

The InferLab product design decided on 2026-11-02 ([InferOps `docs/human/`](https://github.com/factory-level/inferops/tree/develop/docs/human)) sets the product-level scope these pillars serve. InferOS is each company's environment. One shared role model applies across InferOS, InferOps, InferMind, the CRM module and Dot: Superuser (InferLab internal; onboards companies), Admin (a company; configures its data, access, agents, workspaces and workflows), Operator (a company; daily work through the permitted tools), System (schedules, backups, expiry, callbacks under assigned authority) and Agent (agents and Dot, under the user's permissions or assigned system-workflow authority). Building, approving, publishing and read-only viewing are permissions, so Build and Use map to the Admin's build permission and the Operator role; existing owner and admin labels map to Admin and member labels to Operator. The five product surfaces are InferOS, the InferOps global pages, the InferMind global view, Build and Workflows; a custom canvas must never become the only way to find a record. The agent self-improvement loop is removed from the product. The work this implies for InferOS (I06 to I11) is recorded in InferOps' repository map; the rows above that predate the baseline are unchanged and the architecture documents record the divergences.

## Behavior

A consuming repository pins InferOS as a submodule, owns its configuration and extensions, and uses InferOS-owned skills to start a native pnpm/Workers environment. An author creates and proves a native agent artifact, binds it to a supported model account and scoped InferOps capabilities, and builds a Kanban canvas through guarded composition operations. A board transition remains a domain transaction behind an approved gatekeeper action. Human and agent activity is visible without weakening the sandbox or sharing boundary.

The delivery sequence begins with local topology, ChatGPT deployment feasibility, native authoring inventory and the InferOps API contract. Fixtures then unlock connector and canvas work. Setup skills package these paths for consuming repositories. Performance and cloud parity evidence precede release claims. Maps and additional vertical recipes follow the first complete Kanban path.

## Non-Goals

No wholesale kernel fork, replacement workflow runtime, copied trading domain, generic schema designer, arbitrary canvas styling or initial maps implementation. The roadmap includes executable bootstrap tooling and the full feature implementation backlog. A created configuration file does not satisfy runtime feature acceptance.

## Open Questions

- Personal Cloudflare hosting eligibility for ChatGPT subscription usage needs authoritative resolution.
- InferOps API credentials, transition idempotency and shared canvas storage ownership need contract agreement.
- Numeric performance targets follow a measured baseline, with no fabricated benchmark claims.

## Related

- [Current architecture](../architecture/platform-pillars.md)
- [Implementation roadmap](../wiki/implementation-roadmap.md)
- [Vertical decision matrix](../wiki/vertical-decision-matrix.md)
- [Research sources](../wiki/research-sources.md)

The [consumer configuration contract](consumer-configuration.md) specifies the explicit feature flags, profile/style application, durable views and wrapper-owned Cloudflare extensions required for a complete bootstrap.

The 2026-10-02 baseline adds draft designs for [customer feature capabilities](feature-capabilities.md), [local coding workflows](local-coding-workflows.md), [customer onboarding](customer-onboarding.md), [connection extensions](connection-extensions.md), [agent platform integrations](agent-platform-integrations.md) and [agent deployments](agent-deployments.md). This document's own content predates that baseline and has not yet been revised to match it.

The release scope is now set by the MVP decision of 2026-10-02 in [#1](https://github.com/factory-level/inferos/issues/1): InferOps Kanban and the InferMind Wiki are the customer-facing MVP, and InferOS is the configurable private shell that boots and hosts them. #1's ordered walkthrough and evidence checklist are canonical for release, and they take precedence over the delivery sequence in [Behavior](#behavior). The pillars above remain the long-term scope; the parts #1 does not mark release-critical are post-release. The [implementation roadmap](../wiki/implementation-roadmap.md) tracks the walkthrough against the wave milestones.

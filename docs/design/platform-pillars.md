---
title: InferOS platform pillars
status: draft
updated: 2026-10-02
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
| [Vertical extension research and decision matrix](vertical-extension-research.md) | Make extension choices from documented native capabilities and concrete workflow requirements instead of assuming every vertical requires a kernel fork. |

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

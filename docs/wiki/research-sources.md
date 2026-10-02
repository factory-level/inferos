---
title: Research source ledger
updated: 2026-10-01
---

# Research source ledger

Dated sources, repository revisions and explicit evidence limits.

## Steps

1. Prefer implementation at a pinned revision for current behavior.
2. Treat open issues and draft specs as intent, not shipped functionality.
3. Recheck dated provider documentation when implementing APIs or eligibility decisions.
4. Add test evidence alongside the source when a proposed compatibility claim becomes proven.

## Repository evidence

| Repository | Inspected revision | Scope |
| --- | --- | --- |
| InferOS | `1045d2e1ceac7be29e1a6f056c936fb31aa00851` | Model/auth, native API, gatekeeper, presence, local config and release paths named in architecture docs |
| AI Trader | `943c28666dc6dd5093ef411684b18023f93e3cc0` | Registry revision/qualification source and authoring issues |
| InferOps | `29b01a024c377b9c37b8754e7001b290e15d1509` | Widget definition/resolution, project board DTO/backend/client and personal canvas pins |
| cloudflare-os-starter | Main inspected 2026-10-01 | README and docs/customization.md; external wrapper/operator pattern, not a shipped InferOS feature |

The starter README blob SHA was `e1085a7b87f17323a2ced7c58bc384202e9db151`; customization doc blob SHA was `d720a78e2c270f5bfffeab4763b0ba81ea57a7f4`. These are content identifiers, not commit SHAs. Its moving main links must be rechecked before reuse.

The supplied ChatGPT share URL failed to fetch. It is not cited as read evidence. Explicit user requirements and the agreed plan were used instead. An attempted Zendesk API fetch also failed; support rows use the successfully inspected ITSM source as representative evidence and still require the actual support-provider investigation.

## Primary references

Reviewed 2026-10-01. Sources establish the facts described in the linked wiki topics; recommendations and workflow mappings are our engineering inferences. API limitations, support policies and legal requirements need fresh verification at implementation time.

1. [developers.cloudflare.com/workers/local-development/](https://developers.cloudflare.com/workers/local-development/)
2. [developers.cloudflare.com/workers/local-development/bindings-per-env/](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
3. [github.com/cloudflare/cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)
4. [developers.openai.com/siwc/token-sharing-open-source](https://developers.openai.com/siwc/token-sharing-open-source)
5. [developers.openai.com/siwc/token-sharing-open-source/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
6. [developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
7. [developers.openai.com/siwc/token-sharing-open-source/preview-limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
8. [developers.openai.com/siwc/token-sharing-open-source/models-and-inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
9. [developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
10. [github.com/factory-level/ai-trader/issues/34](https://github.com/factory-level/ai-trader/issues/34)
11. [github.com/factory-level/ai-trader/issues/42](https://github.com/factory-level/ai-trader/issues/42)
12. [github.com/factory-level/ai-trader/issues/43](https://github.com/factory-level/ai-trader/issues/43)
13. [github.com/factory-level/ai-trader/issues/80](https://github.com/factory-level/ai-trader/issues/80)
14. [github.com/cloudflare/cloudflare-os-starter/blob/main/docs/customization.md](https://github.com/cloudflare/cloudflare-os-starter/blob/main/docs/customization.md)
15. [github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/domains/project/backend/board.ts](https://github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/domains/project/backend/board.ts)
16. [github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/domains/project/shared/board.dto.ts](https://github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/domains/project/shared/board.dto.ts)
17. [github.com/factory-level/inferops/issues/1698](https://github.com/factory-level/inferops/issues/1698)
18. [github.com/factory-level/inferops/issues/1627](https://github.com/factory-level/inferops/issues/1627)
19. [github.com/factory-level/inferops/issues/1166](https://github.com/factory-level/inferops/issues/1166)
20. [github.com/factory-level/inferops/issues/1152](https://github.com/factory-level/inferops/issues/1152)
21. [github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/_libs/widgets/shared/define-widget.ts](https://github.com/factory-level/inferops/blob/29b01a024c377b9c37b8754e7001b290e15d1509/_libs/widgets/shared/define-widget.ts)
22. [learn.microsoft.com/en-us/dynamics365/field-service/overview](https://learn.microsoft.com/en-us/dynamics365/field-service/overview)
23. [developer.atlassian.com/cloud/jira/service-desk/rest/intro/](https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/)
24. [docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
25. [reference.opcfoundation.org/specs/OPC-10000-2/full](https://reference.opcfoundation.org/specs/OPC-10000-2/full)
26. [hl7.org/fhir/security.html](https://hl7.org/fhir/security.html)
27. [www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html)
28. [learn.microsoft.com/en-us/dynamics365/field-service/inspections-overview](https://learn.microsoft.com/en-us/dynamics365/field-service/inspections-overview)
29. [developers.google.com/youtube/v3/guides/authentication](https://developers.google.com/youtube/v3/guides/authentication)
30. [developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide)
31. [shopify.dev/docs/apps/build/webhooks/verify-deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
32. [developers.cloudflare.com/workers/local-development/local-data/](https://developers.cloudflare.com/workers/local-development/local-data/)
33. [developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

## Confidence and remaining research

High confidence: inspected native boundaries, generated config ownership, existing board/pin shapes and the distinction between human presence and proposed agent activity. Provisional: wrapper schema reuse, external API auth/idempotency, reusable artifact compatibility and performance budgets. Unresolved: ChatGPT personal Workers eligibility, production medical/industrial requirements, actual providers for many secondary-vertical rows and live behavior of proposed adapters.

No new provider login, cloud deployment, model inference, clinical workflow or industrial control was executed for this documentation release. No software performance results are claimed. The follow-up research issues require provider-specific and fixture/live evidence before production claims.

---
title: Priority vertical research
updated: 2026-10-04
---

# Priority vertical research

Deeper extension boundaries for field operations, IT, DevOps, industrial and medical workflows.

## Steps

1. Separate the operational view from the system that commits transactions.
2. Identify the user role, scope, connectivity and failure tolerance.
3. Reuse native presentation/approval/scheduling primitives, then test the external boundary.
4. Record unsupported requirements and avoid treating a successful UI demo as end-to-end readiness.

## Field operations

[Microsoft’s Field Service overview](https://learn.microsoft.com/en-us/dynamics365/field-service/overview) demonstrates that work orders involve scheduling, resources and mobile operation, not simply moving cards. Its [inspection documentation](https://learn.microsoft.com/en-us/dynamics365/field-service/inspections-overview) includes structured inspection responses and mobile/offline behavior. These are representative requirements, not a decision to depend on Dynamics.

Proposed composition: a work-order Gadget/Blueprint and dispatch board, a typed gatekeeper for assignments/inspection submissions, and provider-owned work-order records. Use skills for domain vocabulary and procedure. Offline capture needs a durable client queue, stable operation IDs, versioned forms and reconciliation; the current Workshop’s persistent WebSocket interaction does not prove an offline mobile product. Location views need scope-aware viewport queries and a later maps adapter. Validate assignments against current technician availability at execution, not just proposal time.

First proof: two technicians, overlapping dispatch edits, a disconnected inspection and repeated submission. Confirm territory isolation and attachment ownership. Open questions: mobile device support, location retention, actual dispatch optimizer, offline conflict policy and photo upload limits.

## IT

[Jira Service Management’s REST documentation](https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/) distinguishes provider roles/permissions, OAuth scopes and paginated resources. A connector must retain those boundaries; a user-selected queue or project label is not proof of access.

Proposed composition: native triage/context tools, ticket projection and a gatekeeper mapping allowed ticket transitions. Access requests require a distinct provisioning action in the identity provider; approval text alone cannot enforce separation of duties. Asset reconciliation needs stable source identifiers and a conflict policy. Generic MCP may cover some operations, but verify annotations, endpoint trust and action scope rather than trusting tool labels.

First proof: a requester attempts self-approval, a ticket changes after proposal and an agent supplies another queue’s ID. All must fail or require renewed review without leaking content. Open questions: target ITSM/identity provider, role mapping, audit retention and which operations are reversible.

## DevOps

[GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) provide deployment protection rules and environment controls. A native approval is an additional application decision; it must not bypass provider protection or release a different commit than the reviewer saw.

Proposed composition: scoped telemetry observations, a runbook skill and native callable/scheduled callbacks, plus gatekeepers for incident and deployment actions. Keep remote execution in an explicitly bounded provider or service. The existing Cloudflare observability gatekeeper filters Worker-scoped telemetry, but account-level traces have a different granularity; do not generalize a Worker binding into full-account access.

First proof: identify a service incident, propose a release of a fixed commit and handle provider approval denial or timeout. Retry with the same operation identity. Open questions: CI/CD provider, production environment policy, on-call system, long-running operation status and deployment rollback semantics.

## Industrial

The [OPC UA security model](https://reference.opcfoundation.org/specs/OPC-10000-2/full) makes authentication, authorization and deployment security part of the industrial integration. It does not establish that a public Worker can directly reach a plant device or replace local safeguards.

Proposed composition: read-only asset projections through a site gateway/historian, native maintenance coordination and scoped CMMS actions. An external gateway owns device protocols, network access and buffering. Clearly mark stale or sampled measurements. Control requests require independent specialist review and local safety/interlock enforcement; cloud model output must not become a real-time safety loop. This is an architectural constraint, not a certified safety design.

First proof: synthetic asset streams with gaps, reordered observations and site separation. Control exploration remains a separate, synthetic-only work item until the control-system owner supplies validation requirements. Open questions: protocols, private network path, sampling rate, latency tolerance, availability and safety classification.

## Medical

Where HIPAA applies, [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html) requires appropriate business-associate arrangements and risk analysis for cloud processing of ePHI; encryption alone does not remove those obligations. This research does not establish any vendor contract or certify this stack.

[FHIR’s security guidance](https://hl7.org/fhir/security.html) treats security/privacy controls as responsibilities of a deployment and its surrounding systems; a FHIR-shaped payload is not itself an authorization or compliance guarantee.

Proposed first composition: synthetic administrative scheduling/intake worklists, a narrowly scoped EHR/scheduling gatekeeper and minimal data projections. Preserve patient/encounter identity, source provenance and role scope. Keep clinical decision support separate from administrative tooling: it needs its own clinical validation, intended-use assessment and human review requirements. Do not silently send sensitive records to a newly selected model/provider.

First proof: synthetic patients, appointment concurrency, wrong-patient reference, revoked staff role and redacted diagnostics. Open questions: jurisdiction, actual contracts, minimum necessary data, consent, retention/deletion, clinical intended use and model-provider eligibility.

## Wave 5 evidence boundary

The Field Service, Jira Service Management, GitHub environment, OPC UA, FHIR and HHS references were reopened on 2026-10-04; see [source ledger](research-sources.md). They substantiate representative constraints, not provider selection, deployment eligibility or certification. Current InferOS mechanism evidence is pinned in [the capability inventory](extension-capabilities.md); each matrix area has explicit follow-up ownership. #32 supplies synthetic preparation, while real provider/customer acceptance remains deferred.

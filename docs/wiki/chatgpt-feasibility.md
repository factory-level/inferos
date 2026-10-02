---
title: ChatGPT subscription feasibility findings
updated: 2026-10-01
---

# ChatGPT subscription feasibility findings

Official protocol evidence and the unresolved personal Cloudflare deployment question.

## Steps

1. Resolve the target hosting eligibility before treating subscription inference as deliverable on Cloudflare Workers.
2. Establish the official registration/callback/session topology for that target.
3. Verify model discovery and a terminally successful inference request.
4. Adapt native tools and error handling without changing their authority boundary.

## Hosting decision

**Current decision: unresolved for the requested personal Cloudflare installation.** The official [overview](https://developers.openai.com/siwc/token-sharing-open-source) describes open-source, locally hosted apps and directs remotely hosted/paid apps to an interest process. Subscription usage does not grant ChatGPT conversation access. A persistent opaque host ID identifies an installation, while client registration is associated with the authorizing account/workspace.

The [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) documents local loopback sign-in followed by secure transfer of selected credentials to a VM with its own host identity and refresh ownership. That is evidence for the documented VM procedure, not proof that a Worker deployment qualifies or can use the same procedure. Do not mark a laptop proof as completion of the Cloudflare requirement.

## Integration findings

The [registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) is the source for OAuth flow and state/PKCE handling. The [account/session guide](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) should govern account selection and session lifecycle. The implementation must add per-owner session isolation, serialized refresh updates and disconnect/revocation behavior rather than storing an OAuth token as an unchanging model API key.

The [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) require streamed, nonstored HTTP requests with necessary context supplied in the input array. They reject several ordinary API fields, including max_output_tokens and temperature; HTTP previous_response_id is unsupported. Function/custom tool encoding is constrained, and hosted MCP/tool_search cannot replace native OS tools. Recheck the full list during implementation rather than copying a permanently frozen whitelist here.

The [model/inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) uses the selected OAuth token for model discovery and inference. Completion must wait for response.completed. Partial deltas can precede a usage failure; response.incomplete and interrupted streams need separate handling.

## Local code gap

`packages/workshop-backend/src/ai-models.ts` selects the existing OpenAI Responses provider. Inspection of the installed pi-ai provider found max_output_tokens generation. That dependency behavior requires adaptation and regression tests; supplying an OAuth token alone is insufficient. Keep API-key behavior supported through its current route.

## Required evidence

Record provider eligibility evidence, date and target topology; credential ownership and deletion behavior; successful model discovery; one completed target-host request; a native read and approved write; post-delta failures; cancellation; refresh races; account revocation; and no tokens in logs, browser state or exported artifacts. These are future acceptance checks, not tests executed by this documentation change.

---
title: ChatGPT subscription feasibility findings
updated: 2026-10-04
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

## Local implementation audit — 2026-10-04

The old “OAuth token alone” gap is superseded by merged local companion #40. [Current architecture](../architecture/chatgpt-connection.md) describes its loopback-only capability, per-owner registrations, token refresh/revocation, request shaping, completion checks and explicit API-key fallback. No hosted implementation is inferred.

| Issue / requirement | Local implementation and fake-backed test evidence | Remaining gate |
| --- | --- | --- |
| #12 registration/topology | Loopback callback, PKCE/state/nonce, ID token validation and companion bridge | Eligible Workers topology and actual owner sign-in/completed request |
| #13 account lifecycle | Protected per-owner credential files, exclusive process lock, serialized refresh, signout/refresh races, account-switch cancellation, visible models | Hosted storage/refresh ownership and signed-in isolation proof |
| #14 inference | Unsupported request fields/tools rejected, local function history preserved, only terminal completion succeeds; incomplete/usage failures/cancellation covered | Live native observation and approved write with eligible hosted subscription inference |
| Existing API-key behavior | Separate explicit disconnected-only fallback; quota/network errors do not silently select it | Future changes must retain regression coverage and disclose billing source |

The companion suite is `pnpm --filter @gadgets/assistant-plugin-openai test:run` (`src/plugin.test.ts`, Bun). Wave 5 execution: **39 tests passed, 166 assertions, zero failures** on the pinned baseline. Its mocked OAuth/provider replies cannot establish eligibility, real account access, absence of secrets in every runtime sink, or live operation proof. Review new egress/storage paths if a hosted design is ever approved.

The official overview and VM procedure were reopened on 2026-10-04 and still do not establish a personal Cloudflare Workers topology. #12 remains unresolved. #13/#14 stay open for their hosted target while preserving the implemented local feature. No provider login or account-credential transfer was attempted.

## Required evidence

Record provider eligibility evidence, date and target topology; credential ownership and deletion behavior; successful model discovery; one completed target-host request; a native read and approved write; post-delta failures; cancellation; refresh races; account revocation; and no tokens in logs, browser state or exported artifacts. These are future acceptance checks, not tests executed by this documentation change.

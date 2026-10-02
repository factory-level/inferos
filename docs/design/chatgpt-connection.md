---
title: Personal ChatGPT connection
status: draft
updated: 2026-10-01
---

# Personal ChatGPT connection

Tracking epic: [#3](https://github.com/factory-level/inferos/issues/3); roadmap: [#1](https://github.com/factory-level/inferos/issues/1).

## Purpose

Allow the owner of a personal Cloudflare InferOS install to use eligible ChatGPT subscription inference through official Sign in with ChatGPT.

## Requirements

- Resolve eligibility and supported OAuth/session topology for a personally owned Cloudflare Workers deployment before production implementation.
- Keep Workshop sign-in, ChatGPT account authorization, model selection and external-service capabilities separate.
- Use official OAuth and Responses interfaces; keep refresh credentials server-side and isolated by owner/account/workspace.
- Offer explicit connect, account/model selection, disconnect and recovery states; never silently fall back to paid API usage.
- Preserve native sandbox execution, observations and approval queues for every tool call.

## Behavior

First record a supported, unsupported or unresolved deployment decision with official evidence. A supported implementation connects an account, records a stable opaque host identity, discovers eligible models and streams an ordinary native agent turn. Account state must distinguish disconnected, ready, refreshing, reauthorization required and usage unavailable. Refresh rotation is serialized per session; disconnect invalidates use and clears stored credentials. The inference adapter handles partial output followed by failure, interruption and cancellation. Local functions still pass through InferOS authority and approval checks. A local-only proof is labeled local-only and does not close the Cloudflare acceptance criterion.

## Non-Goals

No ChatGPT conversation import, private backend scraping, copied Codex auth files, generalized identity rewrite or hosted OpenAI replacement for the OS sandbox.

## Acceptance and delivery

### Prove official ChatGPT subscription support for a personal Cloudflare install

Tracking issue: [#12](https://github.com/factory-level/inferos/issues/12) (`chatgpt-feasibility`).

- Record official eligibility and supported deployment/auth topology, including whether remote hosting approval is needed.
- Demonstrate registration, sign-in and one completed eligible request on the approved target; explicitly distinguish any local-only proof.
- Review PKCE/state/nonce, host identity, callback origin, storage and refresh ownership.
- Publish a go/no-go/unresolved decision; do not substitute API-key billing or private endpoints.

### Implement subscription account lifecycle and eligible model discovery

Tracking issue: [#13](https://github.com/factory-level/inferos/issues/13) (`chatgpt-account`).

- Implement connect/select/disconnect and redacted account status through existing capabilities.
- Discover models using the selected account token; keep Workshop user and ChatGPT workspace identities distinct.
- Serialize refresh rotation and handle revoked credentials, expired state and account changes.
- Test user isolation, disconnect during refresh, stale callback replay and absence of tokens in browser/logs/exports.

### Adapt native inference and tool turns for ChatGPT plan usage

Tracking issue: [#14](https://github.com/factory-level/inferos/issues/14) (`chatgpt-inference`).

- Use official subscription-compatible request shaping and tool encoding; preserve existing API-key provider behavior.
- Run a native tool observation and proposed/approved write without bypassing the OS.
- Treat only response.completed as success; test post-delta usage failures, incomplete streams and cancellation.
- Verify history replay, unsupported field exclusion, usage errors and explicit billing-source presentation.

## Open Questions

- Official OSS documentation distinguishes locally hosted from remotely hosted applications; is a personal Workers install eligible, and which redirect/token-transfer topology is approved?
- Which stable host lifecycle and credential-storage mechanism fit a multi-tenant Worker without cross-user token reuse?

## Related

- [Current architecture](../architecture/chatgpt-connection.md)
- [Pillars](platform-pillars.md)
- [Roadmap and issues](../wiki/implementation-roadmap.md)
- [Research evidence](../wiki/research-sources.md)

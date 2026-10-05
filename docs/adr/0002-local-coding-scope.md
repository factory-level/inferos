---
title: Local coding scope
status: proposed
date: 2026-10-02
---

# 0002. Local coding scope

## Context

Issue [#48](https://github.com/factory-level/inferos/issues/48) previously carried a broader coding scope with provider research attached. On 2026-10-02 the owner narrowed it.

InferOps already has a working base: `apps/_inferops-cli/src/runner/codex.ts`, project dispatch, run and lease contracts, and `inferops runner codex`, with claim-before-work, lease generations, heartbeats, session recovery and host-owned login. Its gaps for this purpose are a clone, push and draft-PR path where a local patch is wanted, no adapter seam, a child environment that copies most variables, and no independently captured test evidence.

## Decision

The coding capability is local execution plus authorized agent dispatch, behind `CODING_WORKBENCH_ENABLED`.

A human or an authorized native or external agent invokes an approved workflow against an allowlisted local repository. A supported signed-in coding tool runs on the local machine and returns a reviewable local diff or patch with actual test results. No LLM API key is required anywhere in the workflow.

The existing InferOps runner is extended through a thin adapter or shared runner seam. No second work ledger, task board or general workflow engine is created.

The following are not requirements or blockers: a hosted coding service, a remote runner fleet, subscription inference inside Workers, a commercial-hosting eligibility matrix, AutoClaude code reuse, an AutoClaude-style GUI, and a push or PR for local acceptance.

## Consequences

- The first build target is small: start the local OS, dispatch one approved coding workflow as a human and as an authorized agent, receive a local patch and real test results, and prove an unauthorized agent is denied.
- Dispatch authority is its own permission. Issue-edit or knowledge-write rights do not carry it.
- The runner needs a patch-result mode, an environment allowlist that rejects API-billing configuration in subscription-only mode, and captured test artifacts.
- Subscription exhaustion or login failure pauses the work. There is no fallback to API billing, a hosted runner or another account.
- GitHub publication, review, merge and deploy are later, separately authorized steps.
- Local does not mean offline: the coding tool still reaches its provider's network service.

## Alternatives Considered

- Hosted coding workbench or remote runner fleet: larger build, and it raises provider-eligibility questions that the local path avoids.
- A new execution ledger in InferOS: duplicates the task, run and lease records InferOps already owns.
- Subscription inference inside Workers: depends on the unresolved personal ChatGPT connection track ([#3](https://github.com/factory-level/inferos/issues/3)), which stays separate and optional.
- Require a PR as the result: makes GitHub authorization a precondition for a local proof.

## Related

- Design: [local coding workflows](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Cloudflare%20Deployment.md%23Local%20coding%20workflows)
- Design: [feature capabilities](obsidian://open?vault=authored&file=software%2FInferOS%2FInferOS%20Feature%20Flags.md%23Capability%20contract%20and%20migration%20review)

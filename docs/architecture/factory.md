---
title: Software factory sandboxes and local CI
design: https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/local-development.md
covers:
  - scripts/local/factory.ts
  - scripts/ci
  - load
  - .github/workflows/ci.yml
  - .github/workflows/_verify.yml
  - .github/workflows/factory.yml
  - .github/actions
  - .agents/skills/factory-ci
updated: 2026-11-12
---

# Software factory sandboxes and local CI

## Overview

InferOS's factory combines isolated local sandboxes with a reproducible release graph. The local
entry point is `pnpm local factory`; the release graph runs with
`pnpm factory:ci --run-id <id> [--keep-going]` and writes per-node evidence under
`.factory/runs/<id>/`. GitHub Actions uses the same scripts through reusable and composite
workflows. Nothing in the local graph deploys to Cloudflare.

## Release graph

`scripts/ci/pipeline.ts` runs these nodes in order: verify, security, build, local-deploy, bindings,
DAST, and performance. Each node has one gate, writes its command/evidence records, and exits
nonzero on failure. The pipeline records node outcomes in `state.json`; `--keep-going` continues
after a failed node without changing the final red result. `ci.yml` calls `_verify.yml` for the
existing lint and build/test checks. `factory.yml` runs the full local graph on a hosted GitHub
runner and uploads its evidence artifact.

## Stage smoke

`pnpm local factory stage-smoke` is the separate node 10 stage acceptance journey. It uses only the
reserved `grokbot-owner` and `grokbot-operate` personas, reads the `grokbot.knowledge` Wiki through
each persona's connection, and drives an owner board transition through simulate, approve, and
restore. The nine required oracles are:

1. `owner.signIn`
2. `owner.wikiReads`
3. `owner.boardRenders`
4. `owner.simulated`
5. `owner.applied`
6. `owner.restored`
7. `operate.signIn`
8. `operate.wikiReads`
9. `operate.knowledgeWriteRefused`

The negative write oracle passes only when the proposal is explicitly refused with `FORBIDDEN`, or
an apply result has `FORBIDDEN` with `notApplied`. Wiki edits use `RECONCILE_ONLY`, whose refusal
does not prove non-application; for that kind only, `FORBIDDEN` with `unknown` is accepted when an
independent owner read matches the original page id, version, title, body, and sections. The report
records the observed status, kind, code, outcome, and the applicable branch. Network, HTTP, timeout,
missing-page, auth, stale revision, uncertain action state for any other kind, changed post-read, or
failed cleanup is a failure. It never treats an unrelated authorization or infrastructure failure
as proof of access control.

The stage smoke runs the browser flow and sign-in probe in the pinned Artillery/Playwright
container. The container receives credential variable names, not values in command arguments or
evidence. Local tests and emulated stages are not deployment proof. The factory's `stage-probe`
sandbox is the only sandbox allowed to receive the narrowly scoped stage smoke credentials; cloud,
model-provider, and production credentials remain forbidden.

A loopback or emulated stage must be named by exactly the origin InferOS answers as, which
`.factory/sandbox.json` records: `http://localhost:<port>` for `up dev`, or the emulator's
`http://127.0.0.1:<port>`. The other loopback host on the same port reaches the same server, but
sign-in can't finish there: the sign-in popup's nonce is kept in storage for the stage's origin,
and InferOS sends the popup back to its own origin, whose handoff page finds none ("This link isn't
valid"), so the stage's tab waits for a token that never comes. `stage-probe` therefore fails
`stage:origin`, naming the URL to use, and `stage-smoke` doesn't start the browser flow (FAC-145).

## References

- [Design: local development](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/local-development.md)
- Historical source PR [#286](https://github.com/factory-level/inferos/pull/286)
- [Stage setup runbook](../wiki/grokbot-dev-os.md)

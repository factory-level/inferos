---
title: One InferOps account connection serves every board and Wiki the person can open
status: proposed
date: 2026-11-03
---

# 0015. One InferOps account connection serves every board and Wiki the person can open

## Context

Each InferOps resource is its own binding today: one board, one project's dispatch, one workspace's Wiki, and so on. Its scope is fixed into the binding's props when it is created, and no session method takes a project, host, account or workspace (`inferops-gatekeeper.md`, "Sessions read scope only from those props"; [ADR 0005](0005-inferops-uri-authority.md): "the resolved workspace id is fixed into the binding's props"). A canvas widget finds its binding by exact resource URL and never selects one from a URI (`inferops-canvas.md`).

On dev-os a canvas with the GROK board and an InferMind Wiki therefore needed two connections, made one at a time through the chat, each with its own account choice. They came from two personas, and switching persona broke one of them. The owner decided on 2026-11-03 that one connection should serve both: "same app, just different URLs", as literally one binding.

The board (`grokbot.operations`, an InferOps workspace) and the Wiki (`grokbot.knowledge`, an InferMind workspace) are in different workspaces of different products, so the one binding cannot be per workspace. It has to be per person and organization.

Constraints that still hold: each person acts with their own authority and the gatekeeper narrows, never widens ([ADR 0004](0004-inferops-gatekeeper-user-authority.md)); a URI names a target and grants nothing; a refusal must not reveal what exists outside the person's reach; and nothing is created from a URL.

## Decision

- **A new, additive resource kind** `inferops://<tenant>/account` (`inferops://demo.local/account` for the demo). Its props are the connected account and the tenant label. The six existing kinds are unchanged, and existing bindings keep working.
- **One session, `InferOpsAccountSession`** (agent binding `INFEROPS`):
  - `listWorkspaces()` and `findBoards(query)` are observations over the person's own workspaces.
  - `openBoard(ref)` returns the existing `InferOpsProjectSession`, and `openWiki(ref)` the existing `InferOpsWikiSession`.
  - These are the only methods that take a reference; the sessions they return take none.
- **Narrowing moves to open time.** Each `open*` call:
  - parses the reference with its own kind's parser, so a dispatch, workflow, table, members or page reference is refused;
  - requires the tenant label to equal the binding's;
  - resolves `<workspace>` among the person's own workspaces of the right product;
  - confirms the project or Wiki exists with the person's own token.
  Every refusal has the same message as a missing project or Wiki.
- **Actions carry their scope.**
  - Each proposed action records its resolved `{kind, host, workspaceId, projectKey?}`, and its fingerprint covers that.
  - Approving it resolves the workspace again and refuses when it changed.
  - Action ids and idempotency keys stay unique across the whole binding.
  - Pending actions are kept per scope, so one board's pending moves never show on another.
  - The approval text names the board or Wiki.
- **Sharing uses data-set tracking.** One set per board and per Wiki opened. A collaborator is checked against each set as it is first touched and excluded where their own account cannot open it.
- **The canvas resolves the exact connection first, then the account connection** for the reference's tenant. Both are exact lookups over connections the workspace already holds, and the kernel lookup is unchanged.
- **Not included:** coding dispatch, workflow policy, custom tables and members keep their own bindings. Operate and host boards keep exact board bindings (`excludeFromOperateChat`). The local stopgap connection is refused for this kind.

## Consequences

- One Set up per person and organization serves every board and Wiki widget on a canvas and in an agent. A canvas no longer depends on which persona made each widget's connection.
- Scope is checked when a reference is opened and again when an action is applied, rather than once at creation. More checks run per use. The account binding's scope is everything the person's own account can open in the organization, which is never more than that account's InferOps permissions.
- Disabling the board or Wiki kind in admin settings does not reach an account binding already made, because that policy is checked when a binding is created. Disabling the account kind is the switch for it.
- Sharing an account binding can block approval of Wiki proposals for every Wiki it serves while a collaborator observes. That is safe, and it is documented.
- The gatekeeper's board and Wiki bindings are refactored to take their scope as an argument. Fingerprints of existing bindings stay byte-identical, so pending actions keep verifying.

## Relation to earlier decisions

- Partly supersedes [ADR 0005](0005-inferops-uri-authority.md): for this kind only, the workspace id is not fixed into the binding's props. It is resolved per reference and fixed into each opened session and each action.
- Refines [ADR 0004](0004-inferops-gatekeeper-user-authority.md): authority remains the person's own and the gatekeeper still narrows, only later.
- Design: factory-level/inferops `docs/human/architecture/inferos/inferops-gatekeeper.md` ("InferOps account") and `inferops-canvas.md`, proposed in factory-level/inferops#2531.

## Alternatives considered

- **One account choice, several bindings made in one step.** This keeps today's model. It was rejected by the owner, who wants literally one binding.
- **A kernel lookup over URL patterns a gatekeeper declares.** Rejected: it lets a vendor claim which URLs it serves, and the kernel would have to call a vendor-specific narrowing method.
- **The kernel creating a binding per reference automatically.** Rejected: it creates connections from a URL.
- **A tenantless `inferops://account`.** Rejected: it does not fit the grammar, and two accounts of different organizations would collide.

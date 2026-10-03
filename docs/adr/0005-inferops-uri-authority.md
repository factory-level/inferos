---
title: InferOps board URLs use InferOps' own tenant.workspace authority
status: proposed
date: 2026-10-02
---

# 0005. InferOps board URLs use InferOps' own tenant.workspace authority

## Context

InferOS bound InferOps boards with `inferops://<host>/project/board/<KEY>`, where `<host>` was the host and port of the InferOps API (for example `localhost:8080`). The workspace came from a selection stored on the account, not from the URL. InferOps' own documents and widgets use the same scheme with a different authority: `inferops://<tenant>.<workspace>/<domain>/<widget>/<id>` (`_libs/widgets/shared/inferops-uri.ts` on InferOps `develop`), and they resolve the workspace slug against the reader's workspace list and do not check the tenant label.

So the same board had two addresses, a board link copied out of an InferOps document could not be bound in InferOS, and a URL carried a deployment address, which is configuration rather than a target. The owner decided on 2026-10-02 to adopt the InferOps grammar ([#24](https://github.com/factory-level/inferos/issues/24), [#25](https://github.com/factory-level/inferos/issues/25)).

Constraints: a URL must never grant anything ([ADR 0004](0004-inferops-gatekeeper-user-authority.md): each person acts with their own authority), the deployment must never come from a URL, and a refusal must not reveal whether a workspace or project exists outside the person's reach.

## Decision

- Board URLs are `inferops://<tenant>.<workspace>/project/board/<KEY>`: exactly two lowercase InferOps slug labels. One or three labels, uppercase, a port or user info make it not a board URL.
- The InferOps API is the deployment's configuration (`INFEROPS_BASE_URL`, else the InferLab origin). Nothing in a URL is used as an address.
- `<workspace>` is resolved against the signed-in person's own workspaces by slug. The connect flow reads the slugs once from InferOps (`GET /workspaces`) and stores them beside the memberships InferLab reported; a listed workspace outside those memberships is ignored. The resolved workspace id is fixed into the binding's props, and that workspace's credentials are used. A slug the person does not hold is refused with the same message as a missing project.
- `<tenant>` is checked for syntax only. InferLab's identity carries the tenant id, never its slug, so there is nothing to compare it with; this mirrors InferOps. If the identity ever carries the tenant slug, the label must match it.
- `demo.local` stays the built-in demo data and is never resolved against InferOps.
- The local-development stopgap (`INFEROPS_API_TOKEN` + `INFEROPS_WORKSPACE_ID`) gains `INFEROPS_WORKSPACE_SLUG`: a URL whose workspace label is that slug uses the stopgap connection, for accounts with no identity only.
- The project key grammar is unchanged (uppercase, up to 16 characters).

## Consequences

- A board link from an InferOps document binds unchanged, and canvas references, fixtures and blueprints use one address per board.
- The account no longer stores a selected workspace; the configurator builds the URL from an organization label, a workspace slug and a project, and lists projects for the workspace the URL would name.
- Connecting now makes one extra request (`GET /workspaces`). If it fails the connect fails and the new session is signed out, rather than storing an account whose workspaces cannot be named.
- A workspace joined or renamed after connecting is reachable by URL only after a reconnect.
- Bindings minted before this change keep working when they carry a workspace id (connected accounts) or name `demo.local`; stopgap bindings that named the API host must be re-added.
- The tenant label is cosmetic: two URLs that differ only in tenant label resolve to the same workspace for the same person.

## Alternatives Considered

- Keep the deployment host in the URL and the workspace on the account: two addresses per board, and the workspace selection on the account races between configurators.
- Verify the tenant label through InferLab's public `GET /auth/tenant?slug=` (slug to id) and compare with the identity's tenant id: a request per binding for a label that authorizes nothing; left as an open question.
- Resolve workspace slugs on every binding instead of storing them: an extra request per binding and per observer check, and the stored membership list from InferLab stays the authority either way.
- Fail open (store the account without slugs when `GET /workspaces` fails): the person would connect and then be refused on every board with no hint why.

## Related

- Design: [`../design/inferops-gatekeeper.md`](../design/inferops-gatekeeper.md#resource-grammar)
- Design: [`../design/inferops-canvas.md`](../design/inferops-canvas.md)
- Architecture: [`../architecture/inferops-gatekeeper.md`](../architecture/inferops-gatekeeper.md)
- [ADR 0004](0004-inferops-gatekeeper-user-authority.md)

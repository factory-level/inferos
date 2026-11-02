---
title: InferOS keeps no design of its own
status: proposed
date: 2026-11-02
---

# 0010. InferOS keeps no design of its own

## Context

Design for InferOS was in three places: `docs/design/` here, notes in the vision-manager vault, and since 2026-11-02 the InferLab product design in the InferOps repository's `docs/human/`. InferOps [ADR 0006](https://github.com/factory-level/inferops/blob/develop/docs/agent/adr/0006-docs-human-is-the-design-authority.md) made `docs/human/` the authority and retired the vault as historical input. A first draft kept `docs/design/` here under that authority, which left two design trees that could disagree. The owner's direction on 2026-11-02 was to "centralize the product design in inferops completely", with `docs/human/` existing only in InferOps as the target design state, and the reference enforced against `factory-level/inferops` `develop`.

## Decision

The target design state for InferOS is InferOps `docs/human/` on `develop`, its default branch. The specifications in `docs/design/` moved to [`docs/human/architecture/inferos/`](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/README.md), unchanged apart from links, issue references and renamed InferOps paths, at `364deb91c` plus their 2026-11-02 notes. InferOS has no `docs/design/` or `docs/human/`.

This repository keeps what is built (`docs/architecture/`), its decisions (`docs/adr/`) and its runbooks (`docs/wiki/`). Every architecture doc names its target design in a `design:` front matter URL on InferOps `develop`. A change to intent is proposed as a pull request in InferOps; a gap between code and design is recorded under "Divergences from Design" in the covering architecture doc.

Enforcement has two halves, because this repository is public and InferOps is private:

- `pnpm docs:check`, run by the required CI `Docs` job, fails on a `docs/design/` or `docs/human/` folder, a missing or malformed `design:`, or a link into InferOps `docs/` on any ref other than `develop`. It cannot read InferOps, so it checks only the form of a reference.
- InferOps CI (`scripts/check-inferos-design-refs.mjs`) reads this repository's `main` and fails when a reference does not resolve in its tree, so renaming or removing a target fails that InferOps pull request.

## Consequences

- Links to the design resolve only for people with InferOps access. The specifications as they stood here stay readable in Git history at `364deb91c`.
- A customer wrapper's agent works from `docs/wiki/` and `docs/architecture/`, which remain in the pinned submodule. It does not need the design to bootstrap.
- A change to InferOS's intent takes two pull requests, one in each repository. The InferOps one merges first, or a reference here does not resolve.
- A broken reference merged here turns InferOps CI red until it is fixed here, and it is caught only after the merge.
- Open pull requests that edit `docs/design/` have to move those edits to InferOps.

## Alternatives Considered

- Keep InferOS-specific design here, under the product design: leaves two trees that can disagree.
- Make the vault the authority for InferOS design: the vault is historical input now, and the design would still live outside InferOps.
- Give this repository's CI a credential to read InferOps: a public repository's CI should not hold access to a private one for a documentation check.

## Related

- Design: [InferOS specifications](https://github.com/factory-level/inferops/blob/develop/docs/human/architecture/inferos/README.md)

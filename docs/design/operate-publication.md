---
title: Operate space and publication review
status: draft
updated: 2026-10-04
---

# Operate space and publication review

Review artifact for [#155](https://github.com/factory-level/inferos/issues/155). This is a proposed design, not an approved contract or runtime implementation. The owner authorized design only in Wave 5. Existing pinned installs and explicit upgrades are implemented by #136/#149; the separate publication-destination flags (#68, draft #134) remain deferred.

## Proposed ownership

Reuse an existing workspace as the operate-space container, with its existing owner/collaborator authority, installed gadgets, screens, flows and consoles. Do not create another task store, credential store or shared conversation. A console references installed artifacts; neither the container nor an assignment grants resource access. A person's single Operate session remains in that person's dedicated owner-only workspace and may reference several accessible spaces. Deleting a space removes its shared definitions/installs through existing workspace lifecycle rules; it does not delete anyone's session or source Build workspace. Session references become unavailable.

Build/Use is an authoring boundary, not a complete company-role model. Publication and installation need explicit authoring authority on the appropriate source and destination. IAM administration is separate; a builder is not automatically a company IAM administrator. Source memberships and explicit denies remain authoritative.

## Four distinct operations

| Operation | Proposed behavior | Existing mechanism / missing piece |
| --- | --- | --- |
| Publish | Snapshot the explicitly selected app/widget/workflow kind, files and binding requirements into a new blueprint version; no customer state, tokens or history | Existing blueprint versioning; missing review journey |
| Install | Create an independent destination install pinned to that version, resolving bindings under the destination user's authority | Existing install capability and version-specific binding snapshots |
| Assign | Reference an accessible compatible install from a console/screen/flow | Existing composition mechanisms; review all placement-kind checks before claiming completeness |
| Upgrade | Explicitly select a version, review the change and required rebindings, then invoke the existing upgrade mechanism | Existing `upgradeInstall`; missing user-facing review and migration policy |

Publishing never upgrades an install implicitly. A source change does not alter the running version. Version-specific binding snapshots are authoritative for new versions; preserve the documented current-binding-list compatibility behavior of pre-#149 versions. If publication succeeds and installation fails, report both outcomes and the published version; retry the installation against that version rather than republishing. Recover status before retrying an ambiguous result.

## Review surface

The proposed Build review page shows kind, source/version, target space, installed/candidate version, required resources, validation results and the intended operation. Separate Publish, Install, Assign and Upgrade actions; no combined button with hidden authority changes. A use-only viewer sees the installed version and unavailable resources, not authoring controls.

| State | Required behavior |
| --- | --- |
| No candidate | Return to Build without inventing sample data |
| Missing/revoked binding | Identify the missing capability without disclosing inaccessible data; use the existing connect/rebind flow |
| Wrong kind | Reject before mutation and preserve the draft |
| Pending operation | Disable duplicate submission; recover actual status after reconnect |
| Offline/stale review | Mark the result stale; revalidate authority and selected version before applying |
| Failed installation/upgrade | Preserve the last usable installed version according to the existing mechanism; show the actual failure rather than claiming rollback |
| Mock dependency | Show it explicitly; proposed production publication rule is rejection, subject to the decision below |

## Data compatibility and rollback decision

A previous code version is not a data backup. Wave 5 does not introduce automatic database rollback, arbitrary migration execution or a promise that downgrades are safe. Proposed first release: allow only upgrades whose documented persistence contract remains compatible; require a separately reviewed migration/recovery procedure for incompatible changes. The review must identify how compatibility is declared and verified before implementation. Unknown compatibility is not a successful validation result.

## Review decisions remaining in #155

1. Confirm workspace-backed space ownership and exact publication/installation permissions, including cross-owner installation.
2. Decide the persistence-compatibility declaration and recovery contract. Approve a migration design before permitting data-changing upgrades.
3. Confirm reject-versus-warn for mock dependencies and how a dependency is truthfully identified. Do not infer a runtime model kind from a display name. Synthetic test installations remain explicitly test-only.
4. Confirm first UI scope: review and explicit install/upgrade; assignment through current console composition, without reopening #68/#134.

## Ordered implementation slices after review

1. Kernel: only the missing container metadata/validation demonstrated by a current-code gap audit; exported types documented, authority tests and architecture update together. Do not add parallel install or approval machinery.
2. UI: publication review, binding recovery and version/upgrade visibility using the approved capabilities; keyboard, focus, names and failure-state tests.
3. Evidence: publish v1, install it, edit Build, prove Operate still runs v1, explicitly upgrade to v2; refuse wrong kind, use-only authoring, revoked bindings and incompatible persistence. Record backend truth after duplicate clicks or reconnect. This design alone closes none of these runtime checks.

## Sources

[Current canvas/install architecture](../architecture/inferops-canvas.md), [Operate architecture](../architecture/operate-mode.md), [Operate design](operate-mode.md). Product inputs read via Obsidian CLI on 2026-10-04: `InferOS IAM Surface`, `Draft InferOS Publication Review Page`, `Draft Roles and authority contract`, `InferOS Mock Models`. Their assertions that all pinned publication or role enforcement is unbuilt are older than the merged Wave 4 mechanisms; their intended UI and company-role requirements are still proposals.

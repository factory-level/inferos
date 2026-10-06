---
title: Operate space and publication review
status: accepted
updated: 2026-10-05
---

# Operate space and publication review

Design for [#155](https://github.com/factory-level/inferos/issues/155). Proposed 2026-10-04; **accepted by the owner on 2026-10-05**, with the four review decisions answered under [Decisions](#decisions-2026-10-05). It is not yet a runtime implementation; implementation is resuming in the ordered slices below. Existing pinned installs and explicit upgrades are implemented by #136/#149; the separate publication-destination flags (#68, draft #134) remain deferred.

## Ownership

A space is a workspace (decided 2026-10-05). Reuse an existing workspace as the operate-space container, with its existing owner/collaborator authority, installed gadgets, screens, flows and consoles. Do not create another task store, credential store or shared conversation. A console references installed artifacts; neither the container nor an assignment grants resource access. A person's single Operate session remains in that person's dedicated owner-only workspace and may reference several accessible spaces. Deleting a space removes its shared definitions/installs through existing workspace lifecycle rules; it does not delete anyone's session or source Build workspace. Session references become unavailable.

Build/Use is an authoring boundary, not a complete company-role model. Publication and installation need explicit authoring authority on the appropriate source and destination. IAM administration is separate; a builder is not automatically a company IAM administrator. Source memberships and explicit denies remain authoritative.

## Four distinct operations

| Operation | Behavior | Existing mechanism / missing piece |
| --- | --- | --- |
| Publish | Snapshot the explicitly selected app/widget/workflow kind, files and binding requirements into a new blueprint version; no customer state, tokens or history | Existing blueprint versioning; missing review journey |
| Install | Create an independent destination install pinned to that version, resolving bindings under the installer's own authority. Anyone with build access to the target space may install, across owners, provided they can read the source blueprint | Existing install capability and version-specific binding snapshots |
| Assign | Reference an accessible compatible install from a console/screen/flow | Existing composition mechanisms; review all placement-kind checks before claiming completeness |
| Upgrade | Explicitly select a version, review the change and required rebindings, check the `dataContract` rule, then invoke the existing upgrade mechanism. Anyone with build access to the target space may upgrade | Existing `upgradeInstall`; missing user-facing review and migration policy |

Publishing never upgrades an install implicitly. A source change does not alter the running version. Version-specific binding snapshots are authoritative for new versions; preserve the documented current-binding-list compatibility behavior of pre-#149 versions. If publication succeeds and installation fails, report both outcomes and the published version; retry the installation against that version rather than republishing. Recover status before retrying an ambiguous result.

## Review surface

The Build review page shows kind, source/version, target space, installed/candidate version, required resources, validation results and the intended operation. Separate Publish, Install, Assign and Upgrade actions; no combined button with hidden authority changes. A use-only viewer sees the installed version and unavailable resources, not authoring controls.

| State | Required behavior |
| --- | --- |
| No candidate | Return to Build without inventing sample data |
| Missing/revoked binding | Identify the missing capability without disclosing inaccessible data; use the existing connect/rebind flow |
| Wrong kind | Reject before mutation and preserve the draft |
| Data contract differs or is missing | Refuse the upgrade as *needs migration* (different value) or *unknown data contract* (missing value), before mutation; the installed version keeps running |
| Pending operation | Disable duplicate submission; recover actual status after reconnect |
| Offline/stale review | Mark the result stale; revalidate authority and selected version before applying |
| Failed installation/upgrade | Preserve the last usable installed version according to the existing mechanism; show the actual failure rather than claiming rollback |
| Mock dependency | In a normal space, reject the install or upgrade and name the dependency. In a space marked test-only, allow it and show the test badge (see decision 3) |

## Data compatibility and rollback decision

A previous code version is not a data backup. Wave 5 does not introduce automatic database rollback, arbitrary migration execution or a promise that downgrades are safe. First release (decided 2026-10-05): compatibility is declared by an integer `dataContract` on each version, and only an upgrade between equal values is allowed (decision 2). Any other upgrade needs a separately reviewed migration/recovery procedure, which is not part of this release. Unknown compatibility is not a successful validation result.

## Decisions (2026-10-05)

The owner answered the four review decisions on [#155](https://github.com/factory-level/inferos/issues/155) on 2026-10-05.

1. **A space is a workspace.** Anyone with build access to the target space may install into it and upgrade installs in it, including when the source belongs to another owner. The installer must be able to read the source blueprint, and every binding resolves under the installer's own authority; nothing is granted by the source owner, the container or an assignment.
2. **Each version declares an integer `dataContract`.** An upgrade is allowed only when the installed and target versions declare equal values. A different value is refused as *needs migration*. A missing value on either version counts as unknown and is refused too. The value must be an integer; anything else is treated as missing. Data-changing upgrades wait for a separately approved migration design.
3. **Mock dependencies are rejected in normal spaces**, and the refusal names the dependency. A dependency is identified as a mock from its binding and model metadata (the binding's resource type and the model's provider/kind), never from a display name or title. A space explicitly marked **test-only** (a flag on the space) may install mock dependencies and shows a **test badge** wherever the space and its installs are shown. Synthetic test installations stay in test-only spaces.
4. **First UI scope** is the review page plus explicit install and upgrade. Assignment uses the existing console composition. It does not reopen #68/#134.

## Ordered implementation slices after review

1. Kernel: only the missing container metadata/validation demonstrated by a current-code gap audit (expected: the test-only space flag, the per-version `dataContract`, the mock-dependency check from binding/model metadata, and the cross-owner source-readable check); exported types documented, authority tests and architecture update together. Do not add parallel install or approval machinery.
2. UI: publication review, explicit install and upgrade, binding recovery, version/upgrade visibility and the test badge, using the approved capabilities; keyboard, focus, names and failure-state tests.
3. Evidence: publish v1, install it, edit Build, prove Operate still runs v1, explicitly upgrade to v2; refuse wrong kind, use-only authoring, revoked bindings, a different or missing `dataContract`, a mock dependency in a normal space (naming it), and a cross-owner install whose source the installer cannot read; allow a mock dependency in a test-only space with its badge. Record backend truth after duplicate clicks or reconnect. This design alone closes none of these runtime checks.

## Sources

[Current canvas/install architecture](../architecture/inferops-canvas.md), [Operate architecture](../architecture/operate-mode.md), [Operate design](operate-mode.md). Product inputs read via Obsidian CLI on 2026-10-04: `InferOS IAM Surface`, `Draft InferOS Publication Review Page`, `Draft Roles and authority contract`, `InferOS Mock Models`. Their assertions that all pinned publication or role enforcement is unbuilt are older than the merged Wave 4 mechanisms; their intended UI and company-role requirements are still proposals.

---
title: Agent artifact revisions are identified by a canonical manifest digest
status: accepted
date: 2026-10-05
---

# 0006. Agent artifact revisions are identified by a canonical manifest digest

Proposed 2026-10-03. Accepted as proposed by the owner on 2026-10-05 ([#15](https://github.com/factory-level/inferos/issues/15)).

## Context

[#16](https://github.com/factory-level/inferos/issues/16) needs a qualification bound to exact artifact and dependency revisions, and [#17](https://github.com/factory-level/inferos/issues/17) needs import to reject tampered artifacts. Today a Blueprint has an implicit `version` that increments on every update, and a `.gadget` v1 archive carries no digest. The archive's content is a gzip-compressed Yjs snapshot, so the same files can produce different bytes.

AI Trader's registry (factory-level/ai-trader `libs/backend/registry`) already enforces the rules this needs. Each revision has a `<kind>/<name>@<N>` name and one SHA-256 identity. The receiver recomputes the hash. Pins carry hashes. Qualification names the hash. It hashes one canonical JSON blob of base64 file contents. Its `canonicalJson` silently encodes a `Date` as `{}` and an `undefined` array element as nothing.

The design's two open questions were the smallest authoring API, and digest canonicalisation and compatibility. The owner asked for contract PRs this wave. This record decides the second. The first is in the [design](../design/agent-authoring.md#operation-mapping).

## Decision

1. **Digest.** A revision's digest is `sha256:<hex>` over the UTF-8 bytes of the canonical JSON of its `ArtifactManifest`. The manifest holds the format, kind, each file path with the SHA-256 of that file's exact bytes, the sorted pins (each with its digest), the model requirement and the binding requirements. Name, number, display text, author, timestamps, qualification and environment values are excluded.
2. **Canonical JSON** is the integer subset of RFC 8785: keys sorted by UTF-16 code unit, `undefined` members omitted, no whitespace, `JSON.stringify` string escaping and no Unicode normalisation. Anything else throws, including fractional or unsafe numbers, `Date`, `bigint` and `undefined` inside an array. `canonicalArtifactJson()` in `packages/workshop-shared/src/agent-artifact.ts` is the tested reference.
3. **Files are hashed after decoding.** The digest is computed over the files, never over archive bytes, so re-encoding a Yjs snapshot cannot change identity.
4. **`.gadget` format version 2** carries the revision in the archive's metadata JSON (name, number, digest, manifest, qualification), with the existing 24-byte prefix and version `2`. Version 1 readers already refuse an unknown version, so an old Workshop rejects a revision archive instead of importing it unverified. Import recomputes the digest from the decoded files and refuses a mismatch.
5. **Qualification is bound to one digest** and invalidated by any change, since any change to a file, pin, model requirement or binding requirement changes the digest. A digest is qualified only by at least one deterministic check with every deterministic check passing. Live-model checks are recorded as evidence and never gate publication.
6. **The manifest format is versioned** (`inferos-artifact/1`). An unknown format is refused, and changing what the digest covers is a new format.

## Consequences

- Qualification and pin checks are exact comparisons of strings. A dependent's digest changes whenever a dependency changes.
- Identical content published under two numbers, or renamed, keeps one digest and its qualification.
- Workshops that predate version 2 cannot import revision archives. Version 1 export and import are unchanged.
- Every implementation must reproduce the canonical rule exactly. The reference helper and its tests are the arbiter.
- Qualification is evidence from the author's harness, checked for binding and completeness, not a server-run proof.

## Alternatives Considered

- **Digest over the archive bytes:** the Yjs and gzip encodings are not canonical, so identical files could be refused.
- **Sidecar file (`.gadget` plus `.gadget.json`):** a v1 reader ignores it and imports the archive without verification. Two files can also be separated or swapped.
- **A new binary field in the prefix for a 32-byte digest:** this binds only the archive bytes, which is the first alternative, and the manifest still has to travel in the metadata anyway.
- **AI Trader's single `gadget-files-v1` blob:** hashes base64 text inside JSON and limits size to 1 MiB, and pins and requirements live outside it. A per-file digest lets a diff name the changed files without the content.
- **Full RFC 8785 including fractional numbers:** nothing in the manifest needs them, and refusing them avoids number-formatting disagreements between runtimes.
- **Every check gates, as in AI Trader:** a live-model check would make publication nondeterministic.

## Related

- Design: [`../design/agent-authoring.md`](../design/agent-authoring.md)
- Architecture: [`../architecture/agent-authoring.md`](../architecture/agent-authoring.md)
- Blueprint archive format: [`../blueprints.md`](../blueprints.md)

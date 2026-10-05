---
title: InferOS brain
covers:
  - docs/architecture
  - scripts/check-docs.sh
  - scripts/check-obsidian-designs.ts
  - .github/workflows/obsidian-design.yml
updated: '2026-10-05'
---

# InferOS brain

Use the Obsidian CLI to find, read, and update InferOS knowledge in the `authored`
vault. Obsidian holds intended behavior and design; the repository holds code,
implementation architecture, and ADRs. Run `obsidian help` for available commands.
Obsidian must be running, and every vault command must specify `vault=authored`.

## Find context before working

1. Read the notes listed in the relevant architecture topic's `obsidian_designs`
   front matter. Each entry has a vault-relative `note` path and optional `sections`
   listing exact heading names; omit `sections` to reference the whole note. These
   references identify intended design, not complete implementation.
2. Search InferOS tags, note titles, and mentions across the vault. Include related
   tags and nested tags you discover. Start with `software/InferOS/`, but follow
   relevant results anywhere in the vault.
3. Read the full relevant notes, including the context around referenced sections.
   Follow links and backlinks to related decisions, requirements, and open questions.
4. Then do additional conceptual searches: search for the task's concepts,
   synonyms, components, and workflows, even when the notes never say InferOS.
   For example, an agent permissions task may need searches for capabilities,
   approval, identity, sandboxing, and delegation. Refine searches using vocabulary
   from the notes you read.
5. Use the relevant findings to guide the work and cite the owning notes or
   sections. Distinguish recorded decisions from drafts, open questions, and your
   own inferences. If the vault is unavailable, report the missing context.

```sh
obsidian vault=authored tags
obsidian vault=authored search query="tag:inferos"
obsidian vault=authored search query="file:InferOS"
obsidian vault=authored search query="InferOS"
obsidian vault=authored read path="software/InferOS/InferOS IAM.md"
obsidian vault=authored links path="software/InferOS/InferOS IAM.md"
obsidian vault=authored backlinks path="software/InferOS/InferOS IAM.md"
obsidian vault=authored search:context query="capabilities"
obsidian vault=authored search:context query="approval"
```

## Keep knowledge current

When the task changes intended behavior, update the relevant Obsidian note through
the CLI. Read it before editing, preserve unrelated content and existing metadata,
and read it back afterward to verify the change. Keep InferOS titles, tags, links,
and architecture references consistent with the notes you find.

Extend existing notes first. Create a note only when no existing note fits, using
`InferOS <Topic>` under `software/InferOS/` and the vault's existing tag conventions.
Preserve draft status and unresolved questions unless the user resolves them.
Update repository architecture docs for implementation changes; record differences
from intended design there rather than silently rewriting the design to match code.

Run `pnpm docs:check` to validate repository links and reference structure. CI does
not access the vault; verify note paths and headings through the CLI when changing
references. `docs/design/` is retired and retains only its explanatory README.

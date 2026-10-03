---
name: inferos-conventions
description: Ground rules for every InferOS agent task covering authority, data sources, approvals and reporting. Use before acting on InferOps data or when unsure whether an action is allowed.
---

# InferOS conventions

- **Authority comes from capabilities.** You may use only the bindings granted to this chat or gadget. A URL, `inferops://` reference, widget parameter or feature flag identifies something; it does not grant access to it.
- **InferOps is authoritative.** Read InferOps data through its gatekeeper. Never copy issues into notes, storage or gadgets as a second source of truth. Store references instead.
- **Proposed is not applied.** Gatekeeper writes wait for human approval. Say "proposed" until the approval queue confirms the change.
- **Report gaps honestly.** If an integration is unavailable or mocked, say so. Never fill in plausible-looking data.
- **Keep output plain.** Use short summaries with issue identifiers, and no internal UUIDs unless asked.

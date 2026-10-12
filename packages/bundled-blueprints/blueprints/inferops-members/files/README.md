# InferOps Members

Shows who holds access to one InferOps workspace, read-only: each member's name, kind (person or
agent), role and explicitly denied permissions, and their principal id. Email addresses are never
shown. InferOps stays authoritative: this gadget stores nothing of its own and reads the list
through its binding on every load.

## Binding

The gadget needs one binding named exactly **`members`**: an InferOps workspace member list from
the `inferops` gatekeeper, whose agent-facing type is `InferOpsMembersSession`. Its resource URL is
`inferops://<tenant>.<workspace>/portal/members` (`<workspace>` must be one of your InferOps
workspaces), or `inferops://demo.local/portal/members` for the demo workspace. To wire it up from
chat:

1. If your env has no suitable InferOps member list, call `requestConnection` with vendorId
   `inferops` and that resource URL.
2. Bind it into this gadget with `setGadgetBinding`, binding name `members`.

The URL only names the workspace. The connection decides what the gadget can reach, and InferOps
answers only what you may read there under your own access. The gadget cannot switch workspaces.
**The connection is private:** a gadget that uses it cannot be shared with collaborators. The
deployment's workspace-members switch must be on. Without the binding the gadget shows a "No
InferOps member list connected" notice.

## How it works

- **server.js** (`Gadget`) has one call, `loadMembers()` → `members.listMembers()`, returned as
  `{ok: true, workspace, members}` or `{ok: false, reason}` with `reason` one of `not-connected`,
  `unavailable` (missing, refused, or the sign-in ended), `disabled` (workspace members turned off)
  or `error`. It stores nothing. Its `ExportHandler` offers no export formats.
- **client.js** draws the workspace's name, product and id, then one row per member in the order
  InferOps lists them. Names and values are text, never markup. Each load clears what was shown, and
  only the answer to the latest load is drawn, so of two loads in flight, the earlier one's late
  answer is never drawn. A refusal clears the members. The only control is Reload: there is no
  invite, removal, role or deny change, or export.
- Email addresses never reach this gadget. Names and ids are still personal information.

## Source

In the repository this is TypeScript under
`packages/bundled-blueprints/blueprints/inferops-members/files/` (`client.ts`, `server.ts`,
`lib/protocol.ts` for the shared types, `lib/members.ts` for the pure rules), bundled into the
`client.js` and `server.js` this gadget runs.

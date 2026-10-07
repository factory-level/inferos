# InferOps Records

Shows the rows of one InferOps custom table, read-only. InferOps stays authoritative: this gadget
stores nothing of its own and reads the table through its binding on every load.

## Binding

The gadget needs one binding named exactly **`table`**: an InferOps custom table from the
`inferops` gatekeeper, whose agent-facing type is `InferOpsTableSession`. Its resource URL is
`inferops://<tenant>.<workspace>/object/table/<tableId>` (the table's id in lowercase; `<workspace>`
must be one of your workspaces and `<tenant>` your own organization), or
`inferops://demo.local/object/table/70000000-0000-4000-8000-000000000001` for the demo table. To wire
it up from chat:

1. If your env has no suitable InferOps table, call `requestConnection` with vendorId `inferops`
   and that resource URL.
2. Bind it into this gadget with `setGadgetBinding`, binding name `table`.

The URL only names the table. The connection decides what the gadget can reach, and the gadget
cannot switch tables. **The connection is private:** a gadget that uses it cannot be shared with
collaborators. Without the binding the gadget shows a "No InferOps table connected" notice.

## How it works

- **server.js** (`Gadget`) has one call, `loadRows()` → `table.listRecords({ limit: 50 })`, returned
  as `{ok: true, table, records}` (the definition read with the rows) or `{ok: false, reason}` with
  `reason` one of `not-connected`, `unavailable` (missing, refused, or the sign-in ended),
  `disabled` (custom tables turned off) or `error`. It stores nothing.
- **client.js** draws the rows with the definition they came with: one column per visible column,
  then one per relation showing how many links a row has. Labels and values are text, never markup.
  Each load clears what was shown, and only the answer to the latest load is drawn, so of two loads in flight,
  the earlier one's late answer is never drawn. A refusal clears the rows.
- Columns the table's owner marked personal never reach this gadget.
- Print and PDF exports hide the controls.

## Source

In the repository this is TypeScript under
`packages/bundled-blueprints/blueprints/inferops-records/files/` (`client.ts`, `server.ts`,
`lib/protocol.ts` for the shared types, `lib/records.ts` for the pure rules), bundled into the
`client.js` and `server.js` this gadget runs.

# InferOps Kanban

Shows one InferOps project board as Kanban columns and lets the user move issues between workflow
states. InferOps stays authoritative: this gadget stores nothing of its own and reads the board
through its binding on every load.

## Binding

The gadget needs one binding named exactly **`board`**: an InferOps project board from the
`inferops` gatekeeper, whose agent-facing type is `InferOpsProjectSession`. Its resource URL is
`inferops://<tenant>.<workspace>/project/board/<KEY>`, InferOps' own address for a board (for
example `inferops://acme.operations/project/board/ENG`, where `operations` must be one of your
workspaces), or `inferops://demo.local/project/board/DEMO` for the demo data (which also has `ENG`). To wire it up from chat:

1. If your env has no suitable InferOps board, call `requestConnection` with vendorId `inferops`
   and that resource URL.
2. Bind it into this gadget with `setGadgetBinding`, binding name `board`.

The URL only names the project. The connection itself decides what the gadget can reach, and the
gadget cannot switch projects. Without the binding the gadget shows a "No InferOps board connected"
notice instead of failing.

## How it works

- **server.js** (`Gadget`) proxies two calls to `this.env.board`:
  - `loadBoard()` → `board.readBoard()`, returned as `{ok, board}` or a not-connected/error result.
  - `moveIssue(issueId, toStateId, expectedRevision)` →
    `board.openIssue(issueId).transition(toStateId, expectedRevision)`, pipelined in one round trip,
    with the issue capability disposed afterwards. Gatekeeper failures come back as `{ok: false,
    code, message}` with `code` one of `STALE_REVISION`, `WORKFLOW_MISMATCH`, `INVALID_STATE`,
    `NOT_FOUND`, `NOT_CONNECTED` or `ERROR`.
- **client.js** renders columns in the order the board returns them (state group, then position)
  and cards sorted by priority. A card moves by drag and drop, or with its "Move to…" menu, which is
  the keyboard and screen-reader path; only states of the issue's own workflow are offered.
- Moves are approved by the user before they reach InferOps. The board already shows a proposed
  move in its target column, and cards moved from this board carry a "Move requested" badge until
  the next Refresh. On `STALE_REVISION` the board reloads and asks the user to try again.
- Always pass the `revision` read from the board as `expectedRevision`; never compute one.
- Print and PDF exports hide the controls and wrap the columns.

## Source

In the repository this is TypeScript under
`packages/bundled-blueprints/blueprints/inferops-kanban/files/` (`client.ts`, `server.ts`,
`lib/protocol.ts` for the shared types, `lib/board.ts` for the pure board rules), bundled into the
`client.js` and `server.js` this gadget runs.

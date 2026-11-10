# InferOps Dot

Talk to your own Dot in one InferOps workspace: ask it, follow its answer as it comes, and see each
change it proposes and where that change stands. InferOps runs the Dot as you, and every change it
proposes waits for your decision under **Needs your approval**. This gadget decides nothing, and
the Dot makes no change by itself.

## Binding

The gadget needs one binding named exactly **`dot`**: your Dot from the `inferops` gatekeeper,
whose agent-facing type is `InferOpsDotSession`. Its resource URL is
`inferops://<tenant>.<workspace>/chatbot/dot`, where `<workspace>` must be one of your InferOps
workspaces. To wire it up from chat:

1. If your env has no Dot connection, call `requestConnection` with vendorId `inferops` and that
   resource URL.
2. Bind it into this gadget with `setGadgetBinding`, binding name `dot`.

A Dot needs your own InferLab sign-in: a shared connection has none. **The connection is
private:** a gadget that uses it can't be shared with collaborators. The deployment's Dot switch
must be on. Without the binding, the gadget shows a "No Dot connected" notice.

## How it works

- **server.js** (`Gadget`) keeps one thing: the id of the conversation it is having. It never keeps
  a message, because InferOps holds the conversation. Its calls:
  - `open()` reads that conversation back. With none yet, or one that is gone, it shows an empty
    conversation.
  - `ask(prompt, progress)` asks one turn. The first question starts a conversation. The answer is
    relayed as it comes, through `progress`.
  - `cancel()` stops the running turn.
  - `startOver()` forgets the id, so the next question starts a new conversation. The old one stays
    in InferOps.

  Each call answers `{ok: false, reason}` rather than throwing. `reason` is one of `not-connected`,
  `refused`, `unavailable`, `busy`, `not-found`, `disabled` or `error`. Its `ExportHandler` offers no
  export formats.
- **client.js** draws the conversation as InferOps holds it, each message as text and never markup,
  and redraws it from InferOps after every turn. While the Dot answers, the answer fills in, tool
  steps are named, and a proposed change is noted.
- **Changes the Dot proposed** are listed with where they stand:
  - waiting for your decision (decide it under Needs your approval);
  - being made;
  - made;
  - declined;
  - not made (with the reason);
  - expired;
  - uncertain: it may or may not have been made, so check in InferOps before asking for it again.

  Nothing here approves or declines.
- **Notices for each state:**
  - no Dot connected;
  - refused: your access, or a connection with no Dot;
  - unavailable: the Dot can't run now. A company with its own database lands here today;
  - still answering;
  - not found;
  - turned off;
  - an error, with Try again.
- The only controls are Ask, Stop and Start over.

## Source

In the repository this is TypeScript under
`packages/bundled-blueprints/blueprints/inferops-dot/files/`: `client.ts`, `server.ts`,
`lib/protocol.ts` for the shared types, and `lib/dot.ts` for the pure rules. It's bundled into the
`client.js` and `server.js` this gadget runs.

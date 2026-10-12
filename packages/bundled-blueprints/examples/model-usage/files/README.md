# Model usage (demo data)

A read-only preview of a model-usage view, on **synthetic demo figures** bundled in this gadget. It
shows, for one demo workspace over a fixed window, the input and output tokens and the cost of each
model and provider, with a workspace total.

It is a presentation example (MVP-28). It reads no real usage, bill, provider or gateway, has no
bindings, proves no tenant authorization, and sets or enforces no budget.

## What it shows

- A banner saying the data is a demo fixture.
- Source, scope (workspace total, no per-person figures), window (UTC) and freshness. Figures last
  updated more than 24 hours before the window's end are marked stale.
- Three kinds of cost kept apart: **Estimated** (from token counts and a price table),
  **Provider-reported** (as the provider or gateway reported it) and **Billed** (as an invoice
  charged it; no billing source is connected, so always Unknown). Amounts are USD, tokens are counts.
- A missing figure reads **Unknown**, never 0. A cost total is Unknown when any model lacks that
  figure, because a partial sum would read as the whole.
- States: loading, ready, no usage in the window, stale, and could-not-load.

## How it works

- **server.js** (`Gadget`) has two calls. `listWorkspaces()` returns the demo workspaces' names and
  ids. `loadUsage(workspaceId)` returns that one workspace's figures, `{ok: false, reason:
  "unknown-workspace"}` for an id it does not know, or `{ok: false, reason: "unavailable"}`. The
  workspace is chosen here, so the client never receives another workspace's rows. It stores
  nothing and offers no export formats.
- **client.js** draws the picker, the facts and the table, every value as text. The only controls are
  the workspace picker and Reload. Only the latest load's answer is drawn.
- **lib/fixture.ts** holds the synthetic data, **lib/source.ts** picks one workspace's figures from
  it (what `server.js` serves), and **lib/usage.ts** holds the pure rules (totals, formatting,
  freshness, load generations).

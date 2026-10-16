# Tech support page (demo data)

A read-only preview of a tech-support page, on **synthetic demo data** bundled in this gadget. For one
demo installation it shows four support metric tiles, a read-only support board, and the support
runbook page.

It is a presentation example (MVP-28, programmed-mock only). It reads no InferOps board, InferMind
Wiki, Analytics Engine dataset or account, and has no bindings.

## What it does not prove

- **Not the real page.** It is not the real screen template, and not the real `inferops.project-board`
  or `inferops.wiki` widgets. A screen template cannot hold a gadget today, so this page draws its own
  read-only board and runbook.
- **No live connections.** No support connection, live metric, `approvals/v1` source, or console
  placement.
- **No authorization.** Picking a demo installation selects fixture data. The `denied` state is a
  fixture state, and it shows only how a refusal is presented.

The real denial controls here are:
- **`bindings: {}`:** the gadget reaches nothing;
- **installation selection at the source:** a load returns only the requested installation's page;
- **no write surface:** the Durable Object has only the two read methods. The page has no control but
  the picker and Reload.

## What it shows

- A banner saying the data is a demo fixture, and a line saying nothing on the page can change an
  issue or the runbook.
- **Support metrics.**
  - **People active today** (shaped like `activity/v1` actors).
  - **Coding runs failed, last 24 hours** (InferOps run statuses). Runs with an unknown outcome are
    not counted.
  - **Actions rejected, last 24 hours** and **Median time to decision** have no data source yet, and
    never show a number.
  - Each figured tile shows its source, window and freshness. It is stale when last updated more
    than an hour before the page was read.
- **Support board.** The support project's columns and issues, as text: identifier and title,
  priority, due date and block reason.
  - Every column is shown, even an empty one, and nothing can be moved or opened.
  - The board is stale when last updated more than 15 minutes before the page was read.
- **Support runbook.** One Wiki page drawn as text: headings, paragraphs and numbered steps, with no
  links or embeds, and its version and edit time.
- **Region states.** Each region is ready, stale, refused (`denied`), or could-not-load. The board and
  the runbook can also be empty, and the runbook can be missing. A tile has no empty state: `0 people`
  is a measurement. A missing figure reads **Unknown**, never 0. No tile, column or issue is marked
  healthy, degraded, or with a severity colour.

## How it works

- **server.js** (`Gadget`) has two calls.
  - `listInstallations()` returns the demo installations' names and ids.
  - `loadSupportPage(installationId)` returns that one installation's page, or
    `{ok: false, reason: "unknown-installation"}`.
  - It stores nothing and offers no export formats.
- **client.js** draws the page, every value as a text node. Switching installations clears every
  region, and only the latest load's answer is drawn.
- **lib/fixture.ts** holds the synthetic data. **lib/source.ts** picks one installation's page from it.
  **lib/page.ts** holds the pure rules: freshness, counts, the empty predicates, the issue line and
  load generations.

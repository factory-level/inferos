# System metrics (demo data)

A read-only preview of a System Metrics view, on **synthetic demo figures** bundled in this gadget.
It shows three panels for one demo installation: **Activity**, **Agent runs** and **Runtime
health**.

It is a presentation example (MVP-28, programmed-mock only). It reads no Analytics Engine dataset,
InferOps run, Workers Observability figure or Cloudflare account, has no bindings, proves no tenant
authorization, and sets no threshold, alert or health verdict.

## What it shows

- A banner saying the data is a demo fixture.
- **Activity**, shaped like `activity/v1` events: people active, and window totals (not per day) of
  `user.authenticated`, `workspace.opened`, `gadget.created`, `connection.created` and
  `connection.removed`. There is no total row, because event types do not add up.
- **Agent runs**, shaped like InferOps coding-run statuses: counts per status (`queued`, `running`,
  `succeeded`, `failed`, `cancelled`, `unknown`), each with what it means, and a total. `unknown` is
  never counted as failed. There is no run duration, and platform-agent runs are not included.
- **Runtime health**, shaped like Workers Observability per-Worker figures: requests, errors, the
  error rate and the p95 wall time per Worker, over at most seven days. There is no installation
  total: p95 does not add up, and proxied requests would be counted twice.
- Each panel has its own source, scope (installation total, no per-person figures), window (UTC) and
  freshness. A panel is stale when it was last updated more than its own limit before its window's
  end: 24 hours for activity, 1 hour for runs, 15 minutes for health.
- A missing figure reads **Unknown**, never 0, and a reported 0 reads as `0 <unit>`. A total is
  Unknown when any part of it is. A panel is "empty" only when every figure is a reported zero;
  an error rate with no requests reads **No requests**.
- Panel states: ready, stale, empty (stale or not), and could-not-load, each panel on its own. The
  view draws measurements only: no Worker or panel is marked healthy or degraded.

## How it works

- **server.js** (`Gadget`) has two calls. `listInstallations()` returns the demo installations' names
  and ids. `loadMetrics(installationId)` returns that one installation's three panels, each
  `reported` or `unavailable`, or `{ok: false, reason: "unknown-installation"}` for an id it does not
  know. The installation is chosen here, so the client never receives another installation's
  figures. It stores nothing and offers no export formats.
- **client.js** draws the picker and the three panels, every value as text. The only controls are the
  installation picker and Reload. Switching clears every panel, and only the latest load's answer is
  drawn.
- **lib/fixture.ts** holds the synthetic data, **lib/source.ts** picks one installation's figures from
  it (what `server.js` serves), and **lib/metrics.ts** holds the pure rules (freshness, totals, the
  error rate, formatting, the empty predicate, load generations).

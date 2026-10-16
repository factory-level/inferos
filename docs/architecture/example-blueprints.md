---
title: Example blueprints and the MVP-28 demo views
covers:
  - packages/bundled-blueprints/examples
  - packages/bundled-blueprints/src/example-archive.ts
  - packages/bundled-blueprints/src/cli
updated: 2026-10-16
---

# Example blueprints and the MVP-28 demo views

## Overview

`packages/bundled-blueprints/examples/` holds blueprints as reviewable source that are **not
bundled**. The source is committed but not automatically installed or promoted: the Workshop
backend's build reads only `BUNDLED_BLUEPRINTS_DIR` (`blueprints/`), and
`admin-settings.ts` `#promoteBundledFormats` promotes only what that build bundled. An example
reaches a Workshop only when someone builds its archive and imports it there by hand, through the
existing blueprint import (`importBlueprint`).

The first example is `model-usage` (`example.model-usage`), the presentation half of MVP-28's FinOps
view. It is a read-only model-usage view over **synthetic demo figures** bundled in the gadget,
with no bindings.

The second is `system-metrics` (`example.system-metrics`), the presentation half of MVP-28's System
Metrics view: Activity, Agent runs and Runtime health for one demo installation, on synthetic
figures, with no bindings.

## Components

| Path | Responsibility |
| --- | --- |
| `packages/bundled-blueprints/examples/README.md` | What an example is and how to install one by hand. |
| `packages/bundled-blueprints/examples/model-usage/` | The model-usage demo view: `blueprint.json`, `files/` (client, server, `lib/`) and `__tests__/`. |
| `packages/bundled-blueprints/examples/system-metrics/` | The System Metrics demo view, in the same layout. |
| `packages/bundled-blueprints/src/example-archive.ts` | `buildExampleArchive(dir)`: the bundled build's manifest parser, source reader (TypeScript bundling and import checks) and archive codec, for one example. `EXAMPLES_DIR`. |
| `packages/bundled-blueprints/src/cli/build-example.ts` | `pnpm --filter @gadgets/bundled-blueprints build:example <dir> <out.gadget>`: writes the archive; installs nothing. |
| `packages/bundled-blueprints/__tests__/examples.test.ts` | Examples stay outside `blueprints/` and out of the generated bundled module; each builds a valid archive; `model-usage` and `system-metrics` have no bindings. |

The package's tsconfig programs and vitest `gadgets` project include `examples/*`, so an example is
type-checked and tested like a bundled blueprint.

## Data and Control Flow

`model-usage` has one load per workspace:

1. **The client** (a sandboxed iframe) lists the demo workspaces, then asks the Durable Object for **one** workspace.
2. **The Durable Object** delegates to `lib/source.ts`. That module returns only the requested demo workspace's figures (copies), `unknown-workspace` for any other id, or `unavailable`. The client never receives another workspace's rows to filter. This selection holds only within the fixture; it is not tenant authorization.
3. **The client draws** the figures as text:
   - a permanent DEMO banner;
   - source, scope, window and freshness, with figures marked stale when they were last updated more than 24 hours before the window's end;
   - token counts, and three separate cost columns: Estimated, Provider-reported and Billed. Billed is always Unknown, since no billing source exists.
4. **Totals.** A missing figure is "Unknown", never 0, and a cost total is Unknown when any model lacks that figure.
5. **Not offered:** budgets, allowance changes and exports.

`system-metrics` has the same frame and one load per installation. `lib/source.ts` returns only the
requested demo installation, as three panels that are each `reported` or `unavailable` on their own:

- **Activity**, shaped like `activity/v1` events: people active and window totals of five event types.
- **Agent runs**, shaped like InferOps coding-run statuses: counts for the six statuses and a total;
  `unknown` is never counted as failed.
- **Runtime health**, shaped like Workers Observability per-Worker figures: requests, errors, error
  rate and p95 wall time, over at most seven days, with no installation total.

Each panel carries its own source, window and freshness. It is stale when it was last updated more
than its own limit before its window's end (`lib/metrics.ts` `STALE_AFTER_MS`: 24 h, 1 h and 15 min).
A missing figure is "Unknown", a reported zero is drawn as zero, and a panel is drawn as empty only
when every figure is a reported zero. The view draws no threshold, alert or health verdict, and offers
no export or storage.

## Configuration

None. No flag, binding, admin setting or format curation is involved. Installing the example is a
manual import into one Workshop.

## Divergences from Design

MVP-28 asks for FinOps, System Metrics and tech-support experiences with live data read through a
gatekeeper under the viewer's own authority, installed at pinned versions in every distribution.
These examples cover presentation only:

- synthetic data;
- no gatekeeper resource (the InferOps metrics resources depend on MVP-19);
- for System Metrics: window totals rather than per day, no run duration, coding runs only, no
  governed actions, and no health verdict (that needs an owner SLO);
- no live check;
- no per-person or session figures;
- no budget limit;
- not bundled, so no distribution or placement.

## Open Questions

- Whether either view moves into `blueprints/` (shipping it to every deployment) once a real source exists, and where it is placed among the consoles.

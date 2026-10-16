# Example blueprints

Blueprints kept as reviewable source but **not bundled**. Nothing here is in `blueprints/`, so the
Workshop backend's build never reads it: no deployment installs an example into BLUEPRINTS KV/R2 or
promotes it into the Outputs formats (`admin-settings.ts` promotes every bundled blueprint, enabled).
`__tests__/examples.test.ts` checks that.

An example is installed by hand into one Workshop. Build its archive, then import it there the way
any exported `.gadget` is imported (the Workshop's blueprint import, `importBlueprint`):

```
pnpm --filter @gadgets/bundled-blueprints build:example examples/model-usage /tmp/model-usage.gadget
```

The layout is the same as a bundled blueprint's (`blueprint.json`, `files/`, `__tests__/`), and the
archive is built with the same reader, codec and checks, so an example could later be moved into
`blueprints/`. Doing that ships it to every deployment, which is a product decision, not a refactor.

| Example | What it is |
| --- | --- |
| [`model-usage/`](model-usage/files/README.md) | A read-only model-usage view on synthetic demo figures (MVP-28 presentation only). |
| [`system-metrics/`](system-metrics/files/README.md) | A read-only System Metrics view (activity, agent-run status, runtime health) on synthetic demo figures (MVP-28 presentation only). |

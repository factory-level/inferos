# Scenario `widget-launch-gate`, version 1

FAC-15's end-to-end proof: one authored React/Refine widget through the whole governed loop, on
synthetic fixtures, in one repeatable run. Its data is `widget-launch-gate.ts`. The runner is
`__tests__/widget-launch-gate-scenario.test.ts`, and the report is
`.wrangler/tmp/scenario-reports/widget-launch-gate-v1.json`.

**What it is not:** a live-provider proof, a deployed (dev-os) proof, or a browser proof. The report says
`source: "mock"` and `liveProviderProof: false`.

## Fixture

- **People:** a publisher who holds `configuration:publish` in the InferOps workspace `operations`, and an
  operator with `use` on the publisher's console workspace. Both are synthetic password accounts,
  each with an InferOps account connected through the fake InferOps.
- **The widget:** `WIDGET_SOURCES`, a React and Refine (`@refinedev/core`) TSX widget with a local
  in-memory data provider. Its data never leaves its frame. Its `tools.json` declares one command,
  `moveIssue` (`inferops.issue.transition`), which the publisher binds to the console's own board
  connection (the fake InferOps board `ENG`).

## Cases, in order

1. **`loopback-only`:** the run refuses any non-loopback target.
2. **`generate`:** the widget's TSX is compiled by the real build Durable Object when its blueprint is
   published. The case records the published version.
3. **`publish`:** the publisher's console offers the widget and is published. InferOps' widget index
   then lists one definition for the company, written as the publisher.
4. **`find`:** the operator's own widget search (`searchWidgets`) with `SEARCH_INTENT` returns that
   definition.
5. **`embed-wiki`:** opened without an operate session, the console workspace resolves the published
   console's instance for a Wiki embed (`resolveEmbeddedWidget`).
6. **`embed-operate`:** the operator places the widget on their own canvas
   (`OperateSession.saveWidgetPlacement`), and it is listed back.
7. **`agent-read-filter`:** the operate agent finds, describes and reads the widget, then shows it
   with another filter in the operator's overlay only. Nothing is saved until the operator keeps it.
8. **`agent-act`:** the operate agent requests the widget's declared board command on the operator's
   behalf. It waits, unapplied, for a decider of the console's workspace (the publisher, never the
   person who asked), is approved, and is applied once: exactly one board write.

**The verdict** is PASS only when every case passes, in this order, and no outbound request went
unanswered.

## Known gaps (recorded for FAC-15's go/no-go)

- **G-1:** the widget's data is local. Governed data inside an authored widget's frame isn't built.
- **G-2:** the agent's act is a declared command on the board connection, not the widget's own
  governed command.
- **Search:** the fake InferOps ranks by keyword. A real deployment's embedding ranking isn't run here.

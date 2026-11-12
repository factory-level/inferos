// The bundled InferOps blueprints whose binding has its own switch (FAC-143): the InferOps Records
// gadget's `table` and the InferOps Workflow policy gadget's `policy`. Each blueprint declares its
// binding's pattern and an example URL in its own blueprint.json; this proves that the gatekeeper
// offers exactly that pattern, binds that URL, and only while the binding's switch is on. It catches
// a blueprint and the gatekeeper drifting apart, which the per-resource tests (table.test.ts,
// workflow-policy.test.ts), written against the gatekeeper's own constants, would not.
//
// Fixtures are synthetic only (the demo.local mock).

import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import records from "../../../packages/bundled-blueprints/blueprints/inferops-records/blueprint.json";
import workflow from "../../../packages/bundled-blueprints/blueprints/inferops-workflow-policy/blueprint.json";

type Vars = { INFEROPS_ENABLED?: string; INFEROPS_TABLES_ENABLED?: string; INFEROPS_WORKFLOW_POLICY_ENABLED?: string };
const vars = env as unknown as Vars;

afterEach(() => {
  delete vars.INFEROPS_ENABLED;
  delete vars.INFEROPS_TABLES_ENABLED;
  delete vars.INFEROPS_WORKFLOW_POLICY_ENABLED;
});

for (const [blueprint, binding, flag] of [
  [records.blueprintId, records.bindings.table, "INFEROPS_TABLES_ENABLED"],
  [workflow.blueprintId, workflow.bindings.policy, "INFEROPS_WORKFLOW_POLICY_ENABLED"],
] as const) {
  it(`${blueprint}: its declared binding is offered and binds only with its switch on`, async () => {
    const account = { accountId: crypto.randomUUID() };
    const hooks = env.TEST_HOOKS.getByName(account.accountId);
    vars[flag] = "true";
    expect(await hooks.supportedPatterns(account)).toContain(binding.typeUrlPattern);
    expect((await hooks.supportedResources(account)).find(r => r.urlPattern === binding.typeUrlPattern))
      .toMatchObject({ excludeFromOperateChat: true });
    expect(await hooks.configuratorFor(account, binding.typeUrlPattern)).toBeNull();
    expect(await hooks.bindAccount("supported", account, binding.resourceUrl)).toBeNull();

    // A neighbouring unsupported kind must not become bindable with the switch on.
    expect(await hooks.bindAccount("unsupported", account, "inferops://demo.local/unknown/resource/DEMO"))
      .not.toBeNull();

    for (const value of [undefined, "false"]) {
      if (value === undefined) delete vars[flag];
      else vars[flag] = value;
      expect(await hooks.supportedPatterns(account)).not.toContain(binding.typeUrlPattern);
      expect(await hooks.configuratorFor(account, binding.typeUrlPattern)).toContain("Unsupported");
      expect(await hooks.bindAccount("disabled", account, binding.resourceUrl)).toContain("DISABLED");
    }

    // InferOps off as a whole is off for this binding too, whatever its own switch says.
    vars[flag] = "true";
    vars.INFEROPS_ENABLED = "false";
    expect(await hooks.supportedPatterns(account)).not.toContain(binding.typeUrlPattern);
    expect(await hooks.bindAccount("inferops-off", account, binding.resourceUrl)).toContain("DISABLED");
  });
}

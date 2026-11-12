// FAC-120: a workflow trigger's reference is read exactly as InferOps writes it, and anything else
// is no reference at all. Nothing in one authorizes a run.
import { describe, expect, it } from "vitest";
import { parseWorkflowTriggerRef, workflowTriggerRef } from "./workflow-trigger-ref";

const REF = { company: "acme", workspace: "operations", inferosWorkspaceId: "ws-1", hookId: 7, definitionId: "def-1", revision: 2 };
const LINK = 'inferops://acme.operations/inferos/workflow-trigger/ws-1/7?definition="def-1"&revision="2"';

describe("a workflow trigger reference", () => {
  it("round-trips InferOps' canonical form, and reads its two parameters in either order", () => {
    expect(workflowTriggerRef(REF)).toBe(LINK);
    expect(parseWorkflowTriggerRef(LINK)).toEqual(REF);
    expect(parseWorkflowTriggerRef('inferops://acme.operations/inferos/workflow-trigger/ws-1/7?revision="2"&definition="def-1"')).toEqual(REF);
  });

  it("is no reference when anything is missing, extra, unquoted, out of range or of another kind", () => {
    for (let bad of [
      LINK.replace("inferops://", "https://"),
      LINK.replace("acme.operations", "acme"),
      LINK.replace("acme.operations", "a.b.c"),
      LINK.replace("acme.operations", "Acme.operations"),
      LINK.replace("workflow-trigger", "widget"),
      LINK.replace("/ws-1/7", "/ws-1/7/x"),
      LINK.replace("/7?", "/0?"),
      LINK.replace("/7?", "/7.5?"),
      LINK.replace("/ws-1/", "/../"),
      LINK.replace('revision="2"', 'revision="0"'),
      LINK.replace('revision="2"', "revision=2"),
      LINK.replace('&revision="2"', ""),
      `${LINK}&tenant="other"`,
      `${LINK}&revision="3"`,
      LINK.replace('definition="def-1"', 'definition="a b"'),
      `${LINK}${"x".repeat(2000)}`,
      42,
      null,
    ]) {
      expect(parseWorkflowTriggerRef(bad)).toBeNull();
    }
  });
});

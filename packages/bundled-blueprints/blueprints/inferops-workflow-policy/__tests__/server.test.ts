// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget } from "../files/server.ts";
import type { InferOpsWorkflowPolicySession, WorkflowPolicyHead } from "../files/lib/protocol.ts";

const HEAD: WorkflowPolicyHead = {
  projectId: "10000000-0000-4000-8000-000000000002", workflow: "content", configured: false, revision: "0",
  policy: null, compiledHash: null, legacyUpgraded: false,
};

/** A `policy` binding that counts its reads, failing with `error`. */
function fakeBinding(error?: Error) {
  let reads = 0;
  const binding: InferOpsWorkflowPolicySession = {
    readWorkflowPolicy: async () => {
      reads++;
      if (error) throw error;
      return HEAD;
    },
  };
  return { binding, reads: () => reads };
}

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the Workflow policy gadget must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadgetWith = (policy?: InferOpsWorkflowPolicySession) => new Gadget(NO_STORAGE, { policy });

describe("InferOps Workflow policy server", () => {
  it("reports a missing binding instead of throwing", async () => {
    expect(await gadgetWith().loadPolicy()).toEqual({ ok: false, reason: "not-connected" });
  });

  it("reads the policy once, returning the head as the binding read it, and stores nothing", async () => {
    const fake = fakeBinding();
    expect(await gadgetWith(fake.binding).loadPolicy()).toEqual({ ok: true, head: HEAD });
    expect(fake.reads()).toBe(1);
  });

  it.each([
    ["NOT_FOUND: No such workflow policy is available to you.", "unavailable"],
    ["UNAUTHORIZED: Your InferLab session has ended. Reconnect InferOps.", "unavailable"],
    ["DISABLED: InferOps workflow policies are turned off for this deployment.", "disabled"],
    ["UNAVAILABLE: InferOps returned a workflow policy this gatekeeper cannot read. Try again later.", "error"],
  ])("returns %s as %s, not a thrown error", async (message, reason) => {
    const result = await gadgetWith(fakeBinding(new Error(message)).binding).loadPolicy();
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toHaveProperty("head");
  });

  it("offers no export formats, so the Workshop's defaults are off too", async () => {
    const handler = new ExportHandler({} as ExecutionContext, {});
    expect(await handler.getExportFormats()).toEqual([]);
    expect(handler).not.toHaveProperty("export");
  });
});

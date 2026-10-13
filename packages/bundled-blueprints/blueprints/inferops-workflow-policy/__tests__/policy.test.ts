// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classify, finishLoad, guardText, initialState, laneName, ruleText, startLoad, subjectText, subjectsText,
  transitionSubjectsText,
} from "../files/lib/policy.ts";
import type { LoadPolicyResult } from "../files/lib/protocol.ts";

const READY: LoadPolicyResult = {
  ok: true,
  head: {
    projectId: "p1", workflow: "content", configured: false, revision: "0", policy: null,
    compiledHash: null, legacyUpgraded: false,
  },
};

describe("load generations", () => {
  it("draws only the answer to the latest load", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    // The first load answers late, after the second began: ignored.
    expect(finishLoad(second, first.generation, READY)).toBe(second);
    expect(finishLoad(second, second.generation, READY).view).toEqual({ kind: "ready", result: READY });
  });

  it("clears the policy when a load starts, and when a load fails", () => {
    const ready = finishLoad(startLoad(initialState), 1, READY);
    expect(startLoad(ready).view).toEqual({ kind: "loading" });
    const refused = finishLoad(startLoad(ready), 2, { ok: false, reason: "unavailable", message: "gone" });
    expect(refused.view).toEqual({ kind: "failed", ok: false, reason: "unavailable", message: "gone" });
  });
});

describe("refusals", () => {
  it("reads the code the gatekeeper leads with, and drops it from the message", () => {
    expect(classify(new Error("NOT_FOUND: No such workflow policy is available to you.")))
      .toEqual({ ok: false, reason: "unavailable", message: "No such workflow policy is available to you." });
    expect(classify(new Error("InferOpsError: UNAUTHORIZED: Your InferLab session has ended.")).reason)
      .toBe("unavailable");
    expect(classify(new Error("FORBIDDEN: no.")).reason).toBe("unavailable");
    expect(classify(new Error("DISABLED: InferOps workflow policies are turned off for this deployment.")).reason)
      .toBe("disabled");
    expect(classify(new Error("UNAVAILABLE: InferOps returned a workflow policy this gatekeeper cannot read.")).reason)
      .toBe("error");
    expect(classify("boom")).toEqual({ ok: false, reason: "error", message: "boom" });
  });
});

describe("policy text restates each field as written", () => {
  it("names each subject kind without resolving it", () => {
    expect(subjectText({ principalId: "40000000-0000-4000-8000-000000000004" }))
      .toBe("principal 40000000-0000-4000-8000-000000000004");
    expect(subjectText({ kind: "service_account" })).toBe("every agent");
    expect(subjectText({ kind: "user" })).toBe("every person");
    expect(subjectText({ role: "owner" })).toBe("role owner");
    expect(subjectsText([{ role: "owner" }, { principalId: "x" }])).toBe("role owner, principal x");
  });

  it("keeps a rule's effect and actions in order, and an open transition says who decides", () => {
    expect(ruleText({ id: "r", effect: "deny", subjects: [], actions: ["publish", "approve"] })).toBe("Deny publish, approve");
    expect(ruleText({ id: "r", effect: "allow", subjects: [], actions: ["read"] })).toBe("Allow read");
    expect(transitionSubjectsText([])).toBe("Anyone the lanes' rules allow");
    expect(transitionSubjectsText([{ role: "owner" }])).toBe("role owner");
  });

  it("writes guards and lane references as given", () => {
    expect(guardText({ kind: "required-field", field: "description" })).toBe("required field: description");
    expect(guardText({ kind: "actor-kind", actorKind: "user" })).toBe("actor must be: person");
    expect(guardText({ kind: "not-blocked" })).toBe("not-blocked");
    const lanes = [{ id: "l1", name: "Ideas", group: "backlog" }];
    expect(laneName(lanes, "l1")).toBe("Ideas");
    expect(laneName(lanes, "*")).toBe("Any lane");
    expect(laneName(lanes, "unknown-id")).toBe("unknown-id");
  });
});

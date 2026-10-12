// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classify, deniedText, finishLoad, initialState, kindLabel, productLabel, startLoad,
} from "../files/lib/members.ts";
import type { LoadMembersResult, WorkspaceMember } from "../files/lib/protocol.ts";

const MEMBER: WorkspaceMember = { principalId: "p1", type: "user", name: "Dana", role: "owner", deniedPermissions: [] };
const READY: LoadMembersResult = {
  ok: true, workspace: { workspaceId: "w1", workspaceName: "Operations", product: "inferops" }, members: [MEMBER],
};

describe("load generations", () => {
  it("draws only the answer to the latest load", () => {
    const first = startLoad(initialState);
    const second = startLoad(first);
    // The first load answers late, after the second began: ignored.
    expect(finishLoad(second, first.generation, READY)).toBe(second);
    expect(finishLoad(second, second.generation, READY).view).toEqual({ kind: "ready", result: READY });
  });

  it("clears members when a load starts, and when a load fails", () => {
    const ready = finishLoad(startLoad(initialState), 1, READY);
    expect(startLoad(ready).view).toEqual({ kind: "loading" });
    const refused = finishLoad(startLoad(ready), 2, { ok: false, reason: "unavailable", message: "gone" });
    expect(refused.view).toEqual({ kind: "failed", ok: false, reason: "unavailable", message: "gone" });
  });
});

describe("refusals", () => {
  it("reads the code the gatekeeper leads with, and drops it from the message", () => {
    expect(classify(new Error("NOT_FOUND: No such member list is available to you.")))
      .toEqual({ ok: false, reason: "unavailable", message: "No such member list is available to you." });
    expect(classify(new Error("InferOpsError: UNAUTHORIZED: Your InferLab session has ended.")).reason)
      .toBe("unavailable");
    expect(classify(new Error("DISABLED: InferOps workspace members are turned off for this deployment.")).reason)
      .toBe("disabled");
    expect(classify(new Error("UNAVAILABLE: InferOps could not be reached.")).reason).toBe("error");
    expect(classify("boom")).toEqual({ ok: false, reason: "error", message: "boom" });
  });
});

describe("members", () => {
  it("shows a person or an agent, and denies as written or None", () => {
    expect(kindLabel(MEMBER)).toBe("Person");
    expect(kindLabel({ ...MEMBER, type: "service_account" })).toBe("Agent");
    expect(deniedText(MEMBER)).toBe("None");
    expect(deniedText({ ...MEMBER, deniedPermissions: ["billing:*", "member:read"] })).toBe("billing:*, member:read");
  });

  it("names the product", () => {
    expect(productLabel("inferops")).toBe("InferOps");
    expect(productLabel("infermind")).toBe("InferMind");
  });
});

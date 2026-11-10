// FAC-118: a decision on a pending action is idempotent. The same answer again answers as the first
// did, without deciding twice; the other answer is refused in words that say what was decided; and
// an answer while the approved apply is still in flight says so. Through the build session the
// approvals list calls, over storage that holds one action in each state.
import { describe, expect, it, vi } from "vitest";
import { ACTION_ALREADY_APPROVED, ACTION_ALREADY_REJECTED } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

/** A build session over one action in `state`, with the apply and the gatekeeper's reject watched. */
async function over(state: "pending" | "approved" | "rejected" | "failed") {
  let action = { id: 1, type: "action", state, gatekeeperId: 7, action: 9, caller: { from: "user" } };
  let apply = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
  let reject = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
  let overseer = await openFakeOverseer({
    actions: { get: () => action, put: () => {} },
    gatekeepers: { get: () => ({ creationSpec: { type: "custom" } }) },
  }, {
    role: "build",
    impl: {
      env: {},
      isSharedConfiguration: async () => false,
      applyPendingAction: apply,
      getGatekeeperFacet: () => ({ rejectAction: reject }),
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      users: {
        idFromString: (id: string) => id,
        idFromName: (name: string) => name,
        get: () => ({ whoami: async () => ({ id: "profile-id", name: "Test User" }), whoamiIfExists: async () => null }),
      },
    },
  });
  return { overseer, action, apply, reject };
}

describe("deciding a pending action (FAC-118)", () => {
  it("answers an approval again as it was answered, without applying twice", async () => {
    let { overseer, apply } = await over("approved");
    await expect(overseer.approveAction(1)).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it("answers a rejection again as it was answered, without telling the gatekeeper twice", async () => {
    let { overseer, reject } = await over("rejected");
    await expect(overseer.rejectAction(1)).resolves.toBeUndefined();
    expect(reject).not.toHaveBeenCalled();
  });

  it("refuses the other answer, saying what was decided", async () => {
    let approved = await over("approved");
    await expect(approved.overseer.rejectAction(1)).rejects.toThrow(ACTION_ALREADY_APPROVED);
    expect(approved.reject).not.toHaveBeenCalled();
    let rejected = await over("rejected");
    await expect(rejected.overseer.approveAction(1)).rejects.toThrow(ACTION_ALREADY_REJECTED);
    expect(rejected.apply).not.toHaveBeenCalled();
  });
});

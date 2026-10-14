// An agent cannot start a flow (MVP-37: agent start is not authorized). Every path an agent's
// operate event takes converges on UserDurableObject.dispatchOperateEvent, which refuses an
// agent-attributed startFlow before anything is applied, stored or logged; the operate agent's
// page hook (Overseer.operatePage) reaches it below the tool's own parameter schema.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from "@gadgets/workshop-shared/api";
import type { OperateEvent } from "@gadgets/workshop-shared/operate-session";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Well formed, as a published console's "Intake" would send it: the reducer accepts it from a person.
const VALID: OperateEvent = {
  type: "startFlow", workspaceId: "intakedesk", flowId: "intake", title: "Intake",
  steps: ["intake", "triage", "confirm"],
};
// A use-role employee's forged start of a private flow (the F2 red receipt's event).
const FORGED: OperateEvent = {
  type: "startFlow", workspaceId: "intakedesk", flowId: "private", title: "Forged",
  steps: ["forged-step-1", "forged-step-2"],
};

const refusal = async (operation: PromiseLike<unknown>) => {
  try { await operation; return "accepted"; } catch (error) { return getOperateSessionErrorCode(error) ?? "uncoded"; }
};

const pageAndLog = async (user: DurableObjectStub<UserDurableObject>) =>
  ({ page: await user.getOperatePage(), events: await user.listOperateEvents(0, 50) });

describe("an agent's startFlow", () => {
  it("is refused by the user DO itself, storing nothing, while a person's is applied (N-7)", async () => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const before = await pageAndLog(user);
    expect(before.page.seq).toBe(0);
    for (const event of [VALID, FORGED]) {
      expect(await refusal(user.dispatchOperateEvent(event, null, "agent")))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
      expect(await refusal(user.dispatchOperateEvent(event, 0, "agent")))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
    expect(await pageAndLog(user)).toEqual(before);

    // The guard is the actor's: the same event from a person reaches the reducer. (The person path
    // is checked against an authoritative definition before this, in OperateSessionImpl.dispatch.)
    expect((await user.dispatchOperateEvent(VALID, 0, "person")).state.flow).toMatchObject({ flowId: "intake", index: 0 });
    // A running flow is still the agent's to step through and leave.
    expect((await user.dispatchOperateEvent({ type: "goToStep", index: 1 }, null, "agent")).state.flow?.index).toBe(1);
    expect((await user.dispatchOperateEvent({ type: "exitFlow" }, null, "agent")).state.flow).toBeNull();
  });

  it("is refused through the operate agent's page hook, for a forged and a valid start alike (N-6)", async () => {
    const ownerId = env.TEST_USER.newUniqueId();
    const owner = env.TEST_USER.get(ownerId);
    const before = await pageAndLog(owner);
    const stub = env.TEST_OVERSEER.getByName(`flow-start-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      // The inspection seam of operate-agui.test.ts, here reaching the owner's real user DO.
      const impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = ownerId.toString();
      impl.users = env.TEST_USER;
      impl.storage.operateSession.put(true);
      for (const event of [FORGED, VALID]) {
        expect(await refusal(impl.operatePage(event))).toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
      }
      // Reading the page still works.
      expect((await impl.operatePage()).seq).toBe(0);
    });
    const after = await pageAndLog(owner);
    expect(after).toEqual(before);
    expect(after.events.filter(record => record.actor === "agent")).toEqual([]);
  });
});

// Tickets-specific rules the shared suite does not state: which status changes may be proposed.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BindingProps } from "./worker";

function open() {
  const props: BindingProps = { accountId: crypto.randomUUID(), workspace: "demo", queueId: "support" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  return { props, hooks, session: hooks.startSession(props) };
}

describe("status changes", () => {
  it("refuses a closed ticket and a no-op at proposal, submitting nothing", async () => {
    const { hooks, session } = open();
    const closed = await session.readTicket("T-3");
    await expect(session.setStatus("T-3", "open", closed.revision)).rejects.toThrow(/INVALID_STATE/);
    const pending = await session.readTicket("T-2");
    await expect(session.setStatus("T-2", "pending", pending.revision)).rejects.toThrow(/INVALID_STATE/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses a status outside the vocabulary and a malformed revision", async () => {
    const { session } = open();
    await expect(session.setStatus("T-1", "done" as never, "1")).rejects.toThrow();
    await expect(session.setStatus("T-1", "closed", "one")).rejects.toThrow(/INVALID_REQUEST/);
  });

  it("closes a ticket once approved, and describes the change to the approver", async () => {
    const { props, hooks, session } = open();
    await session.setStatus("T-1", "closed", "1");
    const [action] = (await hooks.log()).actions;
    expect(action?.title).toBe("Set ticket T-1 to closed");
    expect(await hooks.apply(props, action!.id)).toBeNull();
    expect(await session.readTicket("T-1")).toMatchObject({ status: "closed", revision: "2" });
  });
});

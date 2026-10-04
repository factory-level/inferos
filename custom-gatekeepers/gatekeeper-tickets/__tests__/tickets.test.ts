// Tickets-specific rules the shared suite does not state: which status changes may be proposed.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BindingProps } from "./worker";

/**
 * The message an RPC call was refused with, or null. Never hand an RPC promise to
 * `expect(...).rejects`: inspecting it reads properties, and every property of an RPC promise is a
 * pipelined call that rejects with the same error and is never handled.
 */
async function refusal(call: PromiseLike<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function open() {
  const props: BindingProps = { accountId: crypto.randomUUID(), workspace: "demo", queueId: "support" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  return { props, hooks, session: hooks.startSession(props) };
}

describe("status changes", () => {
  it("refuses a closed ticket and a no-op at proposal, submitting nothing", async () => {
    const { hooks, session } = open();
    const closed = await session.readTicket("T-3");
    expect(await refusal(session.setStatus("T-3", "open", closed.revision))).toMatch(/INVALID_STATE/);
    const pending = await session.readTicket("T-2");
    expect(await refusal(session.setStatus("T-2", "pending", pending.revision))).toMatch(/INVALID_STATE/);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("refuses a status outside the vocabulary and a malformed revision", async () => {
    const { session } = open();
    expect(await refusal(session.setStatus("T-1", "done" as never, "1"))).not.toBeNull();
    expect(await refusal(session.setStatus("T-1", "closed", "one"))).toMatch(/INVALID_REQUEST/);
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

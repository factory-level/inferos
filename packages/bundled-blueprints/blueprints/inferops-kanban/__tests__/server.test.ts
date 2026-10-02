// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
import type { Board, InferOpsProjectSession } from "../files/lib/protocol.ts";

const BOARD: Board = {
  project: { id: "p", identifier: "DEMO", name: "Demo" },
  columns: [],
};

/** A `board` binding that records the calls the gadget makes, failing transitions with `error`. */
function fakeBinding(error?: Error) {
  const calls: string[] = [];
  let disposed = 0;
  const binding: InferOpsProjectSession = {
    readBoard: async () => BOARD,
    openIssue: (issueId: string) => {
      calls.push(`open ${issueId}`);
      const issue = {
        read: async () => { throw new Error("unused"); },
        transition: async (toStateId: string, revision: string) => {
          calls.push(`transition ${toStateId} @${revision}`);
          if (error) throw error;
        },
        [Symbol.dispose]: () => { disposed++; },
      };
      return Object.assign(Promise.resolve(issue), issue);
    },
  };
  return { binding, calls, disposed: () => disposed };
}

function gadgetWith(board?: InferOpsProjectSession) {
  return new Gadget({} as DurableObjectState, { board });
}

describe("InferOps Kanban server", () => {
  it("reports a missing binding instead of throwing", async () => {
    const gadget = gadgetWith();

    expect(await gadget.loadBoard()).toEqual({ ok: false, reason: "not-connected" });
    expect(await gadget.moveIssue("i", "s", "1")).toMatchObject({ ok: false, code: "NOT_CONNECTED" });
  });

  it("loads the board through the binding", async () => {
    const { binding } = fakeBinding();

    expect(await gadgetWith(binding).loadBoard()).toEqual({ ok: true, board: BOARD });
  });

  it("moves through the pipelined issue capability and releases it", async () => {
    const fake = fakeBinding();

    expect(await gadgetWith(fake.binding).moveIssue("i1", "s2", "4")).toEqual({ ok: true });
    expect(fake.calls).toEqual(["open i1", "transition s2 @4"]);
    expect(fake.disposed()).toBe(1);
  });

  it("returns a stale revision as a code the client can act on", async () => {
    const fake = fakeBinding(new Error("STALE_REVISION: DEMO-1 is at revision 5, not 4."));

    expect(await gadgetWith(fake.binding).moveIssue("i1", "s2", "4")).toEqual({
      ok: false, code: "STALE_REVISION", message: "DEMO-1 is at revision 5, not 4.",
    });
    expect(fake.disposed()).toBe(1);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
import type { InferOpsTableSession, TableDescription, TableRecord } from "../files/lib/protocol.ts";

const TABLE: TableDescription = { label: "Assets", version: 2, columns: [], relations: [] };
const RECORDS: TableRecord[] = [{ id: "r1", tableVersion: 2, values: {}, links: [] }];

/** A `table` binding that records the options it was read with, failing with `error`. */
function fakeBinding(error?: Error) {
  const reads: unknown[] = [];
  const binding: InferOpsTableSession = {
    describeTable: async () => { throw new Error("unused"); },
    listRecords: async options => {
      reads.push(options);
      if (error) throw error;
      return { table: TABLE, records: RECORDS };
    },
    getRecord: async () => { throw new Error("unused"); },
  };
  return { binding, reads };
}

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the Records gadget must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadgetWith = (table?: InferOpsTableSession) => new Gadget(NO_STORAGE, { table });

describe("InferOps Records server", () => {
  it("reports a missing binding instead of throwing", async () => {
    expect(await gadgetWith().loadRows()).toEqual({ ok: false, reason: "not-connected" });
  });

  it("reads at most 50 rows, returning the definition read with them, and stores nothing", async () => {
    const fake = fakeBinding();
    expect(await gadgetWith(fake.binding).loadRows()).toEqual({ ok: true, table: TABLE, records: RECORDS });
    expect(fake.reads).toEqual([{ limit: 50 }]);
  });

  it.each([
    ["NOT_FOUND: No such table or row is available to you.", "unavailable"],
    ["UNAUTHORIZED: Your InferLab session has ended. Reconnect InferOps.", "unavailable"],
    ["DISABLED: InferOps custom tables are turned off for this deployment.", "disabled"],
    ["UNAVAILABLE: The table changed while it was read. Try again.", "error"],
  ])("returns %s as %s, not a thrown error", async (message, reason) => {
    const result = await gadgetWith(fakeBinding(new Error(message)).binding).loadRows();
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toHaveProperty("records");
  });
});

// A write receipt is a capability (FAC-97 part 2): the only way to read an action's status is to hold
// the receipt `ApprovalQueue.submitAction` returned. This proves it from the source: the kernel mints a
// receipt in one place, and no API method takes an action or receipt id and answers with a status.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const overseer = read("../src/overseer.ts");
const api = read("../../workshop-shared/src/api.ts");
const gatekeeper = read("../../workshop-shared/src/gatekeeper.ts");

describe("a write receipt", () => {
  it("is minted only by the approval queue's submitAction, over the id that call itself created", () => {
    const calls = [...overseer.matchAll(/actionReceipt\(/g)].length;
    // The definition, and one call.
    expect(calls).toBe(2);
    const submit = overseer.slice(overseer.indexOf("async submitAction(action: number, description: ActionDescription): Promise<ActionReceipt>"));
    const body = submit.slice(0, submit.indexOf("\n  }\n"));
    expect(body).toMatch(/let id = this\.impl\.submitActionNow\(/);
    expect(body).toMatch(/return actionReceipt\(this\.impl, this\.gatekeeperId, id\)/);
  });

  it("has no lookup: no API method answers with a receipt or its status", () => {
    for (const [name, source] of [["api.ts", api], ["gatekeeper.ts", gatekeeper]] as const) {
      // Every method declaration whose result is a receipt or a receipt status.
      const answering = [...source.matchAll(/^\s+(\w+)\([^)]*\):\s*Promise<(ActionReceipt|ActionReceiptStatus)\b/gm)].map(m => m[1]);
      expect([name, answering.toSorted()]).toEqual([name, name === "gatekeeper.ts" ? ["status", "submitAction"] : []]);
    }
  });
});

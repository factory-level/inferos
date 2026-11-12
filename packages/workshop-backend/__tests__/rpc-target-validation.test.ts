// Every RpcTarget class overseer.ts declares is wrapped by @validateRpc(), which checks its
// methods' arguments at the RPC boundary (capnweb-validate). FAC-120's round 1 lost one by inserting
// a class between a decorator and the class it decorated; this catches that the next time.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../src/overseer.ts", import.meta.url), "utf8").split("\n");

/**
 * Classes that are deliberately undecorated, each with why. Adding one here is a reviewed decision.
 */
const UNDECORATED = new Map<string, string>([
  ["PlaceholderRpcTarget", "a placeholder stub that every method refuses; never called with arguments"],
  ["GovernedSessionImpl", "wraps a connector's session and forwards only the governed contract (FAC-9)"],
]);

describe("RpcTarget classes in overseer.ts", () => {
  it("are each decorated with @validateRpc(), apart from the reviewed exceptions", () => {
    let found: string[] = [];
    let undecorated: string[] = [];
    SOURCE.forEach((line, index) => {
      let match = /^(?:export )?class (\w+) extends RpcTarget\b/.exec(line);
      if (!match) return;
      found.push(match[1]!);
      let above = index - 1;
      // Comments and blank lines may sit between a decorator and its class.
      while (above >= 0 && (SOURCE[above]!.trim() === "" || SOURCE[above]!.trim().startsWith("//"))) above--;
      if (SOURCE[above]!.trim() !== "@validateRpc()") undecorated.push(match[1]!);
    });
    expect(found.length).toBeGreaterThan(5);
    expect(undecorated.toSorted()).toEqual([...UNDECORATED.keys()].toSorted());
  });
});

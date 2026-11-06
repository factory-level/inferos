// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Gadget } from "../files/server.ts";
import type { ServiceProject } from "../../../libraries/service-dashboard/protocol.ts";
const state = new Proxy({}, { get(_target, name) { if (name === "storage") throw new Error("No business copies"); return undefined; } }) as DurableObjectState;

it("preserves missing binding and denied reads rather than inventing empty results", async () => {
  expect(await new Gadget(state, {}).query("service-jobs")).toEqual({ ok: false, reason: "not-connected" });
  const project: ServiceProject = { readServiceQuery: async () => { throw new Error("FORBIDDEN: private detail"); }, openIssue: vi.fn() };
  expect(await new Gadget(state, { project }).query("service-jobs")).toEqual({ ok: false, reason: "denied" });
});
it("forwards cursor and comments through the same project capability without storage", async () => {
  const comment = vi.fn(async () => {});
  const dispose = vi.fn();
  const project: ServiceProject = { readServiceQuery: vi.fn(async () => ({ name: "service-jobs" as const, version: 1 as const, rows: [], nextCursor: null })), openIssue: vi.fn(async () => ({ comment, [Symbol.dispose]: dispose })) };
  const gadget = new Gadget(state, { project });
  expect(await gadget.query("service-jobs", "cursor")).toMatchObject({ ok: true });
  expect(project.readServiceQuery).toHaveBeenCalledWith("service-jobs", { limit: 25, cursor: "cursor" });
  expect(await gadget.comment("job", "Synthetic comment", "9")).toEqual({ ok: true });
  expect(project.openIssue).toHaveBeenCalledWith("job");
  expect(comment).toHaveBeenCalledWith("Synthetic comment", "9");
  expect(dispose).toHaveBeenCalledTimes(1);
  comment.mockRejectedValueOnce(new Error("FORBIDDEN"));
  expect(await gadget.comment("job", "Denied comment", "9")).toEqual({ ok: false });
  expect(dispose).toHaveBeenCalledTimes(2);
});

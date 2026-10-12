// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget } from "../files/server.ts";
import type { InferOpsMembersSession, WorkspaceMembers } from "../files/lib/protocol.ts";

const LIST: WorkspaceMembers = {
  workspace: { workspaceId: "w1", workspaceName: "Operations", product: "inferops" },
  members: [{ principalId: "p1", type: "user", name: "Dana", role: "owner", deniedPermissions: [] }],
};

/** A `members` binding that counts its reads, failing with `error`. */
function fakeBinding(error?: Error) {
  let reads = 0;
  const binding: InferOpsMembersSession = {
    listMembers: async () => {
      reads++;
      if (error) throw error;
      return LIST;
    },
  };
  return { binding, reads: () => reads };
}

/** A Durable Object state whose storage fails the test if the gadget ever touches it. */
const NO_STORAGE = new Proxy({}, {
  get(_target, name) {
    if (name === "storage") throw new Error("the Members gadget must store nothing");
    return undefined;
  },
}) as DurableObjectState;

const gadgetWith = (members?: InferOpsMembersSession) => new Gadget(NO_STORAGE, { members });

describe("InferOps Members server", () => {
  it("reports a missing binding instead of throwing", async () => {
    expect(await gadgetWith().loadMembers()).toEqual({ ok: false, reason: "not-connected" });
  });

  it("reads the list once, returning the workspace read with it, and stores nothing", async () => {
    const fake = fakeBinding();
    expect(await gadgetWith(fake.binding).loadMembers())
      .toEqual({ ok: true, workspace: LIST.workspace, members: LIST.members });
    expect(fake.reads()).toBe(1);
  });

  it.each([
    ["NOT_FOUND: No such member list is available to you.", "unavailable"],
    ["UNAUTHORIZED: Your InferLab session has ended. Reconnect InferOps.", "unavailable"],
    ["DISABLED: InferOps workspace members are turned off for this deployment.", "disabled"],
    ["UNAVAILABLE: InferOps could not be reached.", "error"],
  ])("returns %s as %s, not a thrown error", async (message, reason) => {
    const result = await gadgetWith(fakeBinding(new Error(message)).binding).loadMembers();
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toHaveProperty("members");
  });

  it("offers no export formats, so the Workshop's defaults are off too", async () => {
    const handler = new ExportHandler({} as ExecutionContext, {});
    expect(await handler.getExportFormats()).toEqual([]);
    expect(handler).not.toHaveProperty("export");
  });
});

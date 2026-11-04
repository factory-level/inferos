// Canvas writes (FAC-84): the builder's controls and the agent's canvas tools write through the same
// functions. The agent writes as its turn's initiator, whose FAC-44 `build` is asked freshly at every
// write; refused, nothing is written. A person at the controls writes in a session FAC-44 checked
// when it opened, and canvas drafts aren't re-checked in an open session, so that write asks nobody.
// Over mock Durable Object storage, with the real store and the real shared-configuration check.
import { describe, expect, it } from "vitest";
import { SHARED_CONFIGURATION_REFUSED, type AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { CanvasContent } from "@gadgets/workshop-shared/canvas";
import { agentCanvasAccess, createCanvasAs, editCanvasPageAs, makeOverseerStorage, workspaceCanvasStore } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const CONTENT: CanvasContent = { title: "Triage", sections: [{ id: "work", title: "Work", columns: 2, widgets: [] }] };
const person = (id: string): AiChatAuthorInfo => ({ type: "user", id, name: id }) as AiChatAuthorInfo;

/** A workspace whose people answer `build` as `holds` says, recording who was asked what. */
function workspace(opts: { holds: Record<string, boolean>; shared?: boolean; gated?: boolean }) {
  const durable = makeMockStorage();
  const asked: string[] = [];
  const ws = {
    ownerId: "owner",
    ctx: { storage: durable },
    storage: makeOverseerStorage(durable),
    env: {
      COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true",
      ...(opts.gated ?? true ? { SHARED_CONFIGURATION_GATEKEEPER: "inferops" } : {}),
    } as unknown as Cloudflare.Env,
    isSharedConfiguration: async () => opts.shared ?? true,
    users: {
      // User DOs are named by user identifier; their IDs read back as `user:<identifier>` here.
      idFromName: (name: string) => ({ toString: () => `user:${name}` }),
      idFromString: (id: string) => id,
      get: (id: string) => ({
        holdsSharedConfiguration: async (action: string) => { asked.push(`${id} ${action}`); return opts.holds[id] ?? false; },
      }),
    },
  } as unknown as Parameters<typeof createCanvasAs>[0];
  return { ws, asked };
}

describe("canvas writes", () => {
  it("refuses the agent's edit and create for an initiator without build, and writes nothing", async () => {
    const { ws, asked } = workspace({ holds: { "user:builder": true } });
    const access = agentCanvasAccess(ws)!;
    const page = await access.create(person("builder"), CONTENT);
    const rename = [{ type: "renamePage" as const, title: "Renamed" }];

    await expect(access.editPage(person("viewer"), page.id, page.revision, rename)).rejects.toThrow(SHARED_CONFIGURATION_REFUSED);
    await expect(access.create(person("viewer"), CONTENT)).rejects.toThrow(SHARED_CONFIGURATION_REFUSED);
    expect(workspaceCanvasStore(ws).listPages()).toEqual([expect.objectContaining({ title: "Triage", revision: "0" })]);
    expect(asked).toEqual(["user:builder build", "user:viewer build", "user:viewer build"]);
  });

  it("doesn't re-check a person at the controls of an open session, whom FAC-44 checked at open", async () => {
    // The authority says no now; the session was opened with build, and drafts aren't re-checked.
    const { ws, asked } = workspace({ holds: {} });
    const session = { kind: "session" as const, userId: "user:builder" };
    const created = await createCanvasAs(ws, session, CONTENT);
    const edited = await editCanvasPageAs(ws, session, created.id, created.revision, [{ type: "renamePage", title: "Renamed" }]);
    expect(edited).toMatchObject({ title: "Renamed", revision: "1" });
    expect(asked).toEqual([]);
  });

  it("applies the agent's edit for an initiator holding build, asking as that initiator each time", async () => {
    const { ws, asked } = workspace({ holds: { "user:builder": true } });
    const access = agentCanvasAccess(ws)!;
    const created = await access.create(person("builder"), CONTENT);
    const edited = await access.editPage(person("builder"), created.id, created.revision, [{ type: "renamePage", title: "Renamed" }]);
    expect(edited).toMatchObject({ title: "Renamed", revision: "1" });
    expect(asked).toEqual(["user:builder build", "user:builder build"]);
  });

  it("asks nobody in a person's own unshared workspace, or where the deployment names no authority", async () => {
    for (const opts of [{ shared: false }, { gated: false }]) {
      const { ws, asked } = workspace({ holds: {}, ...opts });
      const access = agentCanvasAccess(ws)!;
      const created = await access.create(person("anyone"), CONTENT);
      await access.editPage(person("anyone"), created.id, created.revision, [{ type: "renamePage", title: "Mine" }]);
      expect(asked).toEqual([]);
    }
  });

  it("offers the agent no canvas access while saved canvases are off", () => {
    const { ws } = workspace({ holds: {} });
    (ws.env as unknown as Record<string, string>).DURABLE_VIEWS = "false";
    expect(agentCanvasAccess(ws)).toBeNull();
  });
});

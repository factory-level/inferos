// Overseer.getGatekeeperByResourceUrl finds a connection the workspace already holds; it never
// creates one. The URL is matched against what the gatekeeper described itself with, so a
// canvas card's canonical reference resolves to the connection newGatekeeper() minted for it.

import { describe, expect, it, vi } from "vitest";
import type { GatekeeperCreationSpec } from "@gadgets/workshop-shared/api";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const BOARD = "inferops://demo.local/project/board/DEMO";

function seed(storage: ReturnType<typeof makeActionStorage>, id: number,
    resourceUrl: string | undefined, creationSpec?: GatekeeperCreationSpec): void {
  storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, resourceUrl, class: {} as any,
    creationSpec: creationSpec ?? {
      type: "gatekeeper", vendorId: "inferops", resourceUrl: resourceUrl ?? "",
      typeUrlPattern: "inferops://*/project/board/*",
    },
  });
}

async function openClient(storage: ReturnType<typeof makeActionStorage>, blocked: number[] = []) {
  return openFakeOverseer(storage, { impl: {
    getGatekeeperFacet: () => ({}),
    assertGatekeeperUsable: (id: number) => {
      if (blocked.includes(id)) throw new Error("The workspace is restarting; retry.");
    },
  } });
}

describe("getGatekeeperByResourceUrl", () => {
  it("returns the oldest connection described with that URL, and null for an unknown one",
      async () => {
    let storage = makeActionStorage();
    seed(storage, 3, "inferops://demo.local/project/board/OTHER");
    seed(storage, 5, BOARD);
    seed(storage, 7, BOARD);
    let client = await openClient(storage);

    let found = await client.getGatekeeperByResourceUrl(BOARD);
    expect(await found?.getId()).toBe(5);
    expect(await client.getGatekeeperByResourceUrl("inferops://demo.local/project/board/NONE"))
        .toBeNull();
  });

  it("matches the gatekeeper's canonical URL, not what the creator typed", async () => {
    // A URL names a target; the gatekeeper's describe() is what fixes its canonical form.
    let storage = makeActionStorage();
    seed(storage, 2, BOARD, {
      type: "gatekeeper", vendorId: "inferops", typeUrlPattern: "inferops://*/project/board/*",
      resourceUrl: "inferops://DEMO.LOCAL/project/board/DEMO/",
    });
    let client = await openClient(storage);

    expect(await (await client.getGatekeeperByResourceUrl(BOARD))?.getId()).toBe(2);
    expect(await client.getGatekeeperByResourceUrl("inferops://DEMO.LOCAL/project/board/DEMO/"))
        .toBeNull();
  });

  it("never matches a vendorless connection, which has no resource URL", async () => {
    let storage = makeActionStorage();
    seed(storage, 1, undefined, {
      type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude",
    });
    let client = await openClient(storage);

    expect(await client.getGatekeeperByResourceUrl("")).toBeNull();
  });

  it("refuses a connection blocked pending a scope-widening restart, like getGatekeeperById",
      async () => {
    let storage = makeActionStorage();
    seed(storage, 4, BOARD);
    let client = await openClient(storage, [4]);

    await expect(client.getGatekeeperByResourceUrl(BOARD)).rejects.toThrow(/restarting/);
  });

  it("is denied to a use-role collaborator", async () => {
    let storage = makeActionStorage();
    seed(storage, 4, BOARD);
    let client = await openFakeOverseer(storage, { role: "use" });

    await expect(client.getGatekeeperByResourceUrl(BOARD)).rejects.toThrow(/Unauthorized/);
  });
});

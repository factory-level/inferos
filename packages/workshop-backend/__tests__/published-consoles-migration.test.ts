import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The version 4 -> 5 migration against the real OverseerImpl in workerd: consoles saved before
// consoles had a draft and a published revision are published as they stand, with copies of
// their screens, so operators keep the consoles they had. A fresh DO stays at version 0 (never
// initialized), so the test arms the constructor's trigger by hand.

async function withImpl(name: string, fn: (impl: any) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

describe("the version 4 -> 5 published-consoles migration", () => {
  it("publishes each existing console at its revision, with copies of its screens", async () => {
    let board = { schemaVersion: 1, id: "board", revision: "3", title: "Board", sections: [] };
    await withImpl("consoles-migration", async impl => {
      impl.storage.canvases.put(board);
      // A pre-v5 row: no `published` on disk.
      impl.storage.consoles.put({
        id: "lead", revision: "2", title: "Operations lead", fullChat: "off",
        views: [{ id: "board", title: "Board", type: "screen", screen: "board" }],
      });
      impl.storage.version.put(4);
    });

    await abortAllDurableObjects();

    await withImpl("consoles-migration", async impl => {
      expect(impl.storage.version.get()).toBe(5);
      let stored = impl.storage.consoles.get("lead");
      expect(stored.published).toMatchObject({
        revision: "2",
        content: { title: "Operations lead", fullChat: "off", views: stored.views },
      });
      expect(impl.storage.consoleScreens.get("lead/board")).toEqual({
        consoleId: "lead", screenId: "board", screen: board,
      });
    });
  });
});

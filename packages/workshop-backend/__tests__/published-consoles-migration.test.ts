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

  // FAC-99 round 1: the publish path's widget check never runs in this migration. A console whose
  // screen holds a widget today's parser rejects (here a Wiki binding on a board) is still migrated,
  // so the Overseer starts; publishing it again through the publish path is what refuses it
  // (console-publication-authority.test.ts).
  it("migrates a console whose screen holds a widget today's parser rejects, so the Overseer starts", async () => {
    let ref = "inferops://acme.operations/project/board/ENG";
    let screen = {
      schemaVersion: 1, id: "legacy", revision: "1", title: "Legacy",
      sections: [{ id: "work", title: "Work", columns: 1, widgets: [{
        id: "eng", kind: "inferops.project-board", version: 1, targetRef: ref, size: "wide",
        params: { workflow: "software", showCompleted: false },
        dataBinding: { resource: "knowledge/wiki", ref, schemaVersion: 1 },
      }] }],
    };
    await withImpl("consoles-migration-legacy-widget", async impl => {
      impl.storage.canvases.put(screen);
      impl.storage.consoles.put({
        id: "floor", revision: "4", title: "Floor", fullChat: "off",
        views: [{ id: "legacy", title: "Legacy", type: "screen", screen: "legacy" }],
      });
      impl.storage.version.put(4);
    });

    await abortAllDurableObjects();

    await withImpl("consoles-migration-legacy-widget", async impl => {
      expect(impl.storage.version.get()).toBe(5);
      expect(impl.storage.consoles.get("floor").published).toMatchObject({ revision: "4" });
      expect(impl.storage.consoleScreens.get("floor/legacy")).toMatchObject({ consoleId: "floor", screenId: "legacy" });
    });
  });
});


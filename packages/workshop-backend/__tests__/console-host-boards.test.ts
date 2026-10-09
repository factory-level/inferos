// Saved host-board entries survive the current editors' payloads, which predate `hostBoards`, and
// the switch turning off after they were saved. Synthetic consoles over mock Durable Object storage.
import { describe, expect, it } from "vitest";
import type { OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { WorkspaceConsoleStore } from "../src/console-store";
import { makeOverseerStorage } from "../src/overseer";
import { makeMockStorage } from "./mock-storage";

const ON = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", INFEROPS_HOST_BOARDS: "true" };
const OFF = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", INFEROPS_HOST_BOARDS: "false" };
const board = { kind: "host-board" as const, label: "Board",
  requirement: { name: "board", resource: "inferops-board" as const, target: "inferops://acme.operations/project/board/ENG" } };

function setup() {
  let durable = makeMockStorage();
  let storage = makeOverseerStorage(durable);
  storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [] } as never);
  let store = (env: typeof ON) => new WorkspaceConsoleStore(durable, storage, env);
  let views = [{ id: "floor", title: "Floor", type: "screen" as const, screen: "floor" }];
  let saved = store(ON).create({ title: "Floor", fullChat: "off", views, hostBoards: [board] });
  return { store, views, saved };
}

// What ConsoleBuilder and ConsoleSettings send today: no `hostBoards` key at all.
const builderPayload = (views: OperateConsoleContent["views"]): OperateConsoleContent =>
  ({ title: "Floor (edited)", views, fullChat: "available" });
const settingsPayload = (views: OperateConsoleContent["views"]): OperateConsoleContent =>
  ({ title: "Floor", views, fullChat: "off", customization: { screens: false, widgets: false, tools: false, skills: false }, widgets: [] });

describe("host-board entries across the current editors", () => {
  for (let [name, payload] of [["ConsoleBuilder", builderPayload], ["ConsoleSettings", settingsPayload]] as const) {
    it(`keeps them when ${name}'s payload omits hostBoards`, () => {
      let { store, views, saved } = setup();
      let replaced = store(ON).replace(saved.id, saved.revision, payload(views));
      expect(replaced.hostBoards).toEqual(saved.hostBoards);
    });
  }

  it("replaces them only on an explicit list, and removes them on []", () => {
    let { store, views, saved } = setup();
    let cleared = store(ON).replace(saved.id, saved.revision, { ...builderPayload(views), hostBoards: [] });
    expect(cleared.hostBoards).toEqual([]);
  });

  it("still edits and publishes a console holding saved entries after the switch goes off, adding none", () => {
    let { store, views, saved } = setup();
    let published = store(ON).publish(saved.id, saved.revision);
    let edited = store(OFF).replace(published.id, published.revision, builderPayload(views));
    expect(edited.hostBoards).toEqual(saved.hostBoards);
    let republished = store(OFF).publish(edited.id, edited.revision);
    expect(republished.published!.content.hostBoards).toEqual(saved.hostBoards);
    expect(() => store(OFF).replace(republished.id, republished.revision,
      { ...builderPayload(views), hostBoards: [...saved.hostBoards!, { ...board, requirement: { ...board.requirement, name: "other" } }] }))
      .toThrow(/turned off/);
    // A draft whose entries were never published cannot publish them while the switch is off.
    let fresh = store(ON).create({ title: "New", fullChat: "off", views, hostBoards: [board] });
    expect(() => store(OFF).publish(fresh.id, fresh.revision)).toThrow(/turned off/);
  });
});

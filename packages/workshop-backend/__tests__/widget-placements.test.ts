// FAC-13: a person's widget placements on the Operate canvas. Saved in their own user Durable
// Object, for the company they work in now: references, layout and filters only, changed only at
// the revision the person last read, and dropped when the company changes. A placement keeps a
// widget state of its own, so two placements of one widget filter independently.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  WIDGET_PLACEMENT_ERROR_CODES, WIDGET_PLACEMENT_LIMITS, parseWidgetPlacementInput,
  type WidgetPlacementInput,
} from "@gadgets/workshop-shared/widget-placements";
import { parseOperateWidgetRef, widgetStateKey, widgetStateKeyPlacement, type WidgetStateMachine } from "@gadgets/workshop-shared/widget-state";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const COUNTER = {
  type: "console-widget" as const, workspaceId: "console-ws", consoleId: "floor", sourceGadgetId: 0,
  blueprintId: "bp-counter", version: 1,
};
const BOARD = { type: "builtin" as const, kind: "project/board", target: "inferops://acme.operations/project/board/ENG" };
const at = (x: number, y: number, w = 4, h = 3) => ({ x, y, w, h });
const MACHINE: WidgetStateMachine = {
  version: 1, initial: "all", persistence: "person", states: ["all", "open"],
  transitions: [{ event: "filter", from: "all", to: "open" }, { event: "clear", from: "open", to: "all" }],
};

/** A person whose connected accounts currently say they work in `company.now`. */
async function person(company: { now: string }) {
  let user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, (instance: UserDurableObject) => {
    instance.presentationCompanyReader = async () => company.now;
  });
  return user;
}

async function refusal(operation: PromiseLike<unknown>): Promise<string> {
  try {
    await operation;
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("a placement's shape", () => {
  it("reads only references, a grid layout and bounded string filters", () => {
    let parsed = parseWidgetPlacementInput({ ref: { ...COUNTER, extra: "ignored" }, layout: at(0, 0), filters: { status: "open" }, record: { id: 1 } });
    expect(parsed).toEqual({ ref: COUNTER, layout: at(0, 0), filters: { status: "open" } });
    expect(parseWidgetPlacementInput({ ref: BOARD, layout: at(8, 2) })).toEqual({ ref: BOARD, layout: at(8, 2), filters: {} });
  });

  it("refuses a layout off the grid, a reference that isn't one, and filters that aren't plain text", () => {
    const bad: unknown[] = [
      { ref: COUNTER, layout: at(10, 0, 4) },
      { ref: COUNTER, layout: { x: 0.5, y: 0, w: 1, h: 1 } },
      { ref: COUNTER, layout: at(0, 0, 4, WIDGET_PLACEMENT_LIMITS.height + 1) },
      { ref: { ...COUNTER, version: 0 }, layout: at(0, 0) },
      { ref: { ...COUNTER, workspaceId: "../x" }, layout: at(0, 0) },
      { ref: { ...BOARD, target: "https://example.com" }, layout: at(0, 0) },
      { ref: { type: "record", id: 1 }, layout: at(0, 0) },
      { ref: COUNTER, layout: at(0, 0), filters: { status: 3 } },
      { ref: COUNTER, layout: at(0, 0), filters: { "bad name": "x" } },
      { ref: COUNTER, layout: at(0, 0), filters: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "x"])) },
      { ref: COUNTER, layout: at(0, 0), filters: { q: "x".repeat(WIDGET_PLACEMENT_LIMITS.filterValue + 1) } },
    ];
    for (let input of bad) expect(() => parseWidgetPlacementInput(input)).toThrow(WIDGET_PLACEMENT_ERROR_CODES.invalid);
  });
});

describe("a placement's own widget state", () => {
  it("keeps the widget's own key unchanged, and gives each placement a key of its own", () => {
    let ref = { workspaceId: "console-ws", consoleId: "floor", revision: "3", gadgetId: 41 };
    // The FAC-86 key, so states stored before placements still match.
    expect(widgetStateKey(ref)).toBe(JSON.stringify(["console-ws", "floor", "3", 41]));
    let placed = widgetStateKey({ ...ref, placementId: "p-1" });
    expect(placed).not.toBe(widgetStateKey(ref));
    expect(placed).not.toBe(widgetStateKey({ ...ref, placementId: "p-2" }));
    expect(widgetStateKeyPlacement(placed)).toBe("p-1");
    expect(widgetStateKeyPlacement(widgetStateKey(ref))).toBeUndefined();
    expect(() => parseOperateWidgetRef({ ...ref, placementId: "../p" })).toThrow(/placement/);
  });
});

describe("one person's placements", () => {
  it("are saved with a kernel-minted id, in canvas order, and changed only at the revision read", async () => {
    let user = await person({ now: "tenant-a" });
    expect(await user.listWidgetPlacements()).toEqual({ revision: 0, placements: [] });
    let first = await user.saveWidgetPlacement({ ref: COUNTER, layout: at(4, 0), filters: { status: "open" } }, 0);
    let second = await user.saveWidgetPlacement({ ref: BOARD, layout: at(0, 0, 4, 6) }, first.revision);
    expect(second.revision).toBe(2);
    expect(second.placements.map(p => p.ref.type)).toEqual(["builtin", "console-widget"]);
    let counter = second.placements[1]!;
    expect(counter.placementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(counter).toMatchObject({ ref: COUNTER, layout: at(4, 0), filters: { status: "open" } });

    // A client that read revision 1 is refused, and nothing changes.
    expect(await refusal(user.saveWidgetPlacement({ placementId: counter.placementId, ref: COUNTER, layout: at(8, 0) }, 1)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.conflict);
    // Moving, resizing and re-filtering it keeps its id; the widget it shows can't change.
    let moved = await user.saveWidgetPlacement(
      { placementId: counter.placementId, ref: COUNTER, layout: at(8, 1, 4, 4), filters: { status: "done" } }, 2);
    expect(moved.placements.find(p => p.placementId === counter.placementId))
      .toMatchObject({ layout: at(8, 1, 4, 4), filters: { status: "done" } });
    expect(await refusal(user.saveWidgetPlacement({ placementId: counter.placementId, ref: { ...COUNTER, version: 2 }, layout: at(8, 1) }, 3)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.refChanged);
    expect(await refusal(user.saveWidgetPlacement({ placementId: "no-such", ref: COUNTER, layout: at(0, 0) }, 3)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.notFound);
    expect((await user.listWidgetPlacements()).revision).toBe(3);
  });

  it("are the person's own: another person sees none of them", async () => {
    let company = { now: "tenant-a" };
    let a = await person(company);
    let b = await person(company);
    await a.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0) }, 0);
    expect(await b.listWidgetPlacements()).toEqual({ revision: 0, placements: [] });
  });

  it("hold at most the limit, and a removal frees a place and drops that placement's widget states", async () => {
    let user = await person({ now: "tenant-a" });
    let revision = 0;
    for (let i = 0; i < WIDGET_PLACEMENT_LIMITS.placements; i++) {
      revision = (await user.saveWidgetPlacement({ ref: COUNTER, layout: at(0, i) } satisfies WidgetPlacementInput, revision)).revision;
    }
    expect(await refusal(user.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0) }, revision)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.tooMany);
    let { placements } = await user.listWidgetPlacements();
    let [gone, kept] = placements;
    let ref = { workspaceId: "console-ws", consoleId: "floor", revision: "3", gadgetId: 41 };
    await user.transitionWidgetState(widgetStateKey({ ...ref, placementId: gone!.placementId }), MACHINE, "filter", 0);
    await user.transitionWidgetState(widgetStateKey({ ...ref, placementId: kept!.placementId }), MACHINE, "filter", 0);
    await user.transitionWidgetState(widgetStateKey(ref), MACHINE, "filter", 0);

    let after = await user.removeWidgetPlacement(gone!.placementId, revision);
    expect(after.placements).toHaveLength(WIDGET_PLACEMENT_LIMITS.placements - 1);
    expect((await user.readWidgetState(widgetStateKey({ ...ref, placementId: gone!.placementId }), MACHINE)).state).toBe("all");
    expect((await user.readWidgetState(widgetStateKey({ ...ref, placementId: kept!.placementId }), MACHINE)).state).toBe("open");
    expect((await user.readWidgetState(widgetStateKey(ref), MACHINE)).state).toBe("open");
    expect(await refusal(user.removeWidgetPlacement(gone!.placementId, after.revision)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.notFound);
    await user.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0) }, after.revision);
  });
});

describe("one person in two companies", () => {
  it("keeps no placement of company 1 in company 2, and restores none on switching back", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    let inA = await user.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0) }, 0);

    company.now = "tenant-b";
    let inB = await user.listWidgetPlacements();
    expect(inB.placements).toEqual([]);
    // A client still holding company 1's placements is refused, and reads them again.
    expect(inB.revision).toBeGreaterThan(inA.revision);
    expect(await refusal(user.saveWidgetPlacement({ placementId: inA.placements[0]!.placementId, ref: COUNTER, layout: at(4, 0) }, inA.revision)))
      .toContain(WIDGET_PLACEMENT_ERROR_CODES.conflict);
    await user.saveWidgetPlacement({ ref: BOARD, layout: at(0, 0) }, inB.revision);

    company.now = "tenant-a";
    expect((await user.listWidgetPlacements()).placements).toEqual([]);
  });
});

describe("through the operate session", () => {
  async function session() {
    let { OperateSessionImpl } = await import("../src/server.js");
    let user = await person({ now: "tenant-a" });
    let workspace = { getConsoleWidgetStates: async () => MACHINE, [Symbol.dispose]: () => {} };
    let impl = new OperateSessionImpl(() => user as never, async () => ({}) as never,
      async () => workspace as never, () => user as never, () => ({}) as never, {} as never);
    return { impl, user };
  }
  const widget = { workspaceId: "console-ws", consoleId: "floor", revision: "3", gadgetId: 41 };

  it("saves only the checked placement, and gives two placements of one widget their own state", async () => {
    let { impl } = await session();
    let one = await impl.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0), record: { title: "copied" } } as never, 0);
    expect(one.placements[0]).not.toHaveProperty("record");
    let two = await impl.saveWidgetPlacement({ ref: COUNTER, layout: at(4, 0) }, one.revision);
    let [a, b] = two.placements;
    await impl.transitionWidget({ ...widget, placementId: a!.placementId }, "filter", 0);
    expect((await impl.getWidgetState({ ...widget, placementId: a!.placementId })).state).toBe("open");
    expect((await impl.getWidgetState({ ...widget, placementId: b!.placementId })).state).toBe("all");
    // The widget's own state, which its console and a Wiki embed share, is untouched.
    expect((await impl.getWidgetState(widget)).state).toBe("all");
    expect(await impl.listWidgetPlacements()).toEqual(two);
  });

  it("refuses a placement's state for one not on the person's canvas, or not of that console", async () => {
    let { impl } = await session();
    let saved = await impl.saveWidgetPlacement({ ref: COUNTER, layout: at(0, 0) }, 0);
    let board = await impl.saveWidgetPlacement({ ref: BOARD, layout: at(4, 0) }, saved.revision);
    let boardId = board.placements.find(p => p.ref.type === "builtin")!.placementId;
    let counterId = saved.placements[0]!.placementId;
    for (let ref of [{ ...widget, placementId: "someone-elses" }, { ...widget, placementId: boardId },
        { ...widget, consoleId: "desk", placementId: counterId }, { ...widget, workspaceId: "other-ws", placementId: counterId }]) {
      expect(await refusal(impl.getWidgetState(ref)), JSON.stringify(ref)).toContain(WIDGET_PLACEMENT_ERROR_CODES.notFound);
      expect(await refusal(impl.transitionWidget(ref, "filter", 0)), JSON.stringify(ref)).toContain(WIDGET_PLACEMENT_ERROR_CODES.notFound);
    }
  });
});

// FAC-137 K1: a person's temporary canvases, in their own operate session workspace. An unsaved
// canvas expires at the time the server set when it was created; saving keeps it; the alarm's sweep
// removes only expired canvas records, never a record a canvas shows or a run, and nothing here asks
// for shared configuration authority or writes shared configuration.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  DEFAULT_TEMPORARY_CANVAS_TTL_HOURS, TEMPORARY_CANVAS_ERROR_CODES, TEMPORARY_CANVAS_LIMITS, parseTemporaryCanvasInput,
  temporaryCanvasTtlMs,
} from "@gadgets/workshop-shared/temporary-canvas";
import { OPERATE_AGENT_TOOL_NAMES } from "../src/agent";
import type { OverseerDurableObject } from "../src/overseer.js";
import { TemporaryCanvasStore } from "../src/temporary-canvas-store";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const HOUR = 60 * 60 * 1000;
const OWNER = "ada";
const CONSOLE_WIDGET = {
  type: "console-widget" as const, workspaceId: "a".repeat(64), consoleId: "board-console",
  sourceGadgetId: 7, blueprintId: "inferops-board", version: 1,
};
const INPUT = {
  title: "Ada's week",
  placements: [
    { ref: CONSOLE_WIDGET, layout: { x: 0, y: 0, w: 6, h: 4 }, filters: { status: "open" } },
    { ref: { type: "builtin" as const, kind: "project/board", target: "inferops://acme.operations/project/board/ENG" },
      layout: { x: 6, y: 0, w: 6, h: 4 } },
  ],
};

const code = (error: unknown) => (error as { code?: string }).code ?? String(error);
const refusal = async (fn: () => unknown) => {
  try { await fn(); } catch (error) { return code(error); }
  return "accepted";
};

// An operate session workspace owned by `owner` (FAC-88's operateSession mark), unless `operate` is false.
async function withSession<T>(fn: (impl: any) => Promise<T> | T, { operate = true, owner = OWNER } = {}): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`temporary-canvases-${crypto.randomUUID()}`),
    async (instance: OverseerDurableObject) => {
      let impl = (instance as any).impl;
      impl.ownerId = owner;
      if (operate) impl.storage.operateSession.put(true);
      return fn(impl);
    });
}

describe("the TTL setting (FAC-137)", () => {
  it("defaults to the proposed 24 hours and takes whole hours from 1 to 720", () => {
    expect(DEFAULT_TEMPORARY_CANVAS_TTL_HOURS).toBe(24);
    expect(temporaryCanvasTtlMs(undefined)).toBe(24 * HOUR);
    expect(temporaryCanvasTtlMs("1")).toBe(HOUR);
    expect(temporaryCanvasTtlMs("720")).toBe(720 * HOUR);
    for (let bad of ["0", "721", "1.5", "-1", "", "24h"]) {
      expect(() => temporaryCanvasTtlMs(bad)).toThrow(/OPERATE_TEMPORARY_CANVAS_TTL_HOURS/);
    }
  });

  it("checks what to create, minting the ids itself", () => {
    expect(parseTemporaryCanvasInput(INPUT).placements).toHaveLength(2);
    for (let bad of [
      { ...INPUT, title: " " },
      { ...INPUT, placements: [] },
      { ...INPUT, placements: [{ ...INPUT.placements[0], placementId: "chosen" }] },
      { ...INPUT, placements: Array(TEMPORARY_CANVAS_LIMITS.placements + 1).fill(INPUT.placements[0]) },
    ]) {
      expect(() => parseTemporaryCanvasInput(bad)).toThrow(TEMPORARY_CANVAS_ERROR_CODES.invalid);
    }
  });

  it("refuses a title that isn't one line of plain text, so it can't add a line to the kernel's own field (FAC-134)", () => {
    for (let title of ["Refunds\nApproved by your admin", "Refunds\rx", "Refunds\u2028x", "Refunds\u202ex", "Refunds\u0000"]) {
      expect(() => parseTemporaryCanvasInput({ ...INPUT, title }), JSON.stringify(title))
        .toThrow("A temporary canvas's title is one line of plain text.");
    }
  });

  it("refuses a forbidden character at either end of a title, and blank space other than single ASCII spaces (FAC-134)", () => {
    for (let title of ["\u2028Refunds", "Refunds\u2028", "\u202eRefunds", "Refunds\u202e", "\u00a0Refunds", "Refunds\u3000", "\ufeffRefunds", "Re  funds", "Re\u00a0funds", "Re\u3000funds", "Re\u2003funds", "Re\u200afunds", "Re\u3164funds", "Re\u115ffunds", "Re\u1160funds", "Re\uffa0funds", "Re\u2800funds", "Re\u034ffunds"]) {
      expect(() => parseTemporaryCanvasInput({ ...INPUT, title }), JSON.stringify(title))
        .toThrow("A temporary canvas's title is one line of plain text.");
    }
    expect(parseTemporaryCanvasInput({ ...INPUT, title: " Refunds this week  " }).title).toBe("Refunds this week");
  });
});

describe("temporary canvases live only in their owner's live operate session (FAC-137)", () => {
  it("refuses an ordinary workspace, another person, and a session a company change retired", async () => {
    await withSession(async impl => {
      expect(await refusal(() => impl.temporaryCanvasesOf(OWNER))).toBe(TEMPORARY_CANVAS_ERROR_CODES.unavailable);
    }, { operate: false });
    await withSession(async impl => {
      expect(await refusal(() => impl.temporaryCanvasesOf("grace"))).toBe(TEMPORARY_CANVAS_ERROR_CODES.unavailable);
      expect(await refusal(() => impl.createTemporaryCanvasFor("grace", INPUT))).toBe(TEMPORARY_CANVAS_ERROR_CODES.unavailable);
      impl.createTemporaryCanvasFor(OWNER, INPUT);
      impl.storage.operateSessionRetired.put(true);
      expect(await refusal(() => impl.temporaryCanvasesOf(OWNER).list())).toBe(TEMPORARY_CANVAS_ERROR_CODES.unavailable);
    });
  });
});

describe("the server sets when an unsaved canvas expires (FAC-137)", () => {
  it("expires the deployment's TTL after creation, and wakes the alarm for it until it is saved", async () => {
    await withSession(async impl => {
      impl.env = { ...impl.env, OPERATE_TEMPORARY_CANVAS_TTL_HOURS: "2" };
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
      let made = impl.createTemporaryCanvasFor(OWNER, INPUT);
      expect(made.expiresAt.getTime() - made.createdAt.getTime()).toBe(2 * HOUR);
      expect(made.placements.map((p: any) => p.placementId)).toEqual([expect.any(String), expect.any(String)]);
      expect(await impl.ctx.storage.getAlarm()).toBe(made.expiresAt.getTime());
      // Every read carries the server's expiry; saving removes it, and with it the alarm.
      expect(impl.temporaryCanvasesOf(OWNER).list()[0].expiresAt).toEqual(made.expiresAt);
      let saved = impl.temporaryCanvasesOf(OWNER).save(made.id, made.revision);
      expect(saved.expiresAt).toBeUndefined();
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("refuses to create with a misconfigured TTL rather than pick one", async () => {
    await withSession(async impl => {
      impl.env = { ...impl.env, OPERATE_TEMPORARY_CANVAS_TTL_HOURS: "forever" };
      expect(() => impl.createTemporaryCanvasFor(OWNER, INPUT)).toThrow(/OPERATE_TEMPORARY_CANVAS_TTL_HOURS/);
      expect([...impl.storage.temporaryCanvases.list()]).toEqual([]);
    });
  });
});

describe("saving against expiry (FAC-137, N5)", () => {
  it("keeps a canvas saved before its expiry, and refuses one at or after it, swept or not", async () => {
    await withSession(async impl => {
      let clock = 1_000_000;
      let store = new TemporaryCanvasStore(impl.ctx.storage, impl.storage, { now: () => clock, ttlMs: () => HOUR });
      let kept = store.create(parseTemporaryCanvasInput(INPUT));
      let lost = store.create(parseTemporaryCanvasInput({ ...INPUT, title: "Lost" }));

      clock = kept.expiresAt!.getTime() - 1;
      expect(store.save(kept.id, kept.revision).expiresAt).toBeUndefined();

      clock = lost.expiresAt!.getTime();
      // Not yet swept: refused as expired, never treated as saved.
      expect(await refusal(() => store.save(lost.id, lost.revision))).toBe(TEMPORARY_CANVAS_ERROR_CODES.expired);
      expect(await refusal(() => store.get(lost.id))).toBe(TEMPORARY_CANVAS_ERROR_CODES.expired);
      expect(store.list().map(canvas => canvas.title)).toEqual(["Ada's week"]);

      expect(store.sweepExpired()).toBe(1);
      expect(await refusal(() => store.save(lost.id, lost.revision))).toBe(TEMPORARY_CANVAS_ERROR_CODES.notFound);
      // The saved one is never swept, however late.
      clock += 10_000 * HOUR;
      expect(store.sweepExpired()).toBe(0);
      expect(store.get(kept.id).title).toBe("Ada's week");
    });
  });

  it("refuses a save naming a stale revision", async () => {
    await withSession(async impl => {
      let made = impl.createTemporaryCanvasFor(OWNER, INPUT);
      expect(await refusal(() => impl.temporaryCanvasesOf(OWNER).save(made.id, made.revision + 1)))
        .toBe(TEMPORARY_CANVAS_ERROR_CODES.conflict);
    });
  });
});

describe("expiry removes only the canvas (FAC-137, N3 and N4)", () => {
  it("the alarm sweeps an expired canvas and touches no run, definition or saved canvas", async () => {
    await withSession(async impl => {
      let expired = Date.now() - 60_000;
      let source = { kind: "gadget", gadgetId: 3, commitId: "1".padStart(40, "0") };
      // A run started from a widget is that widget's workspace's run: here, as the strongest case,
      // a live run and its definition in this very workspace, beside the canvas.
      impl.storage.workflowDefinitions.put({
        id: "kept-definition", title: "Refunds", owner: { type: "user", id: "ada-profile", name: "Ada" },
        published: null, revisions: [{ revision: 1, source, savedAt: new Date(expired - 1) }],
      });
      impl.storage.workflowDeliveries.put({
        id: 1, hookId: 11, definitionId: "kept-definition", revision: 1, commitId: source.commitId,
        at: new Date(), historyOwnerProfileId: "ada-profile",
      });
      let saved = impl.createTemporaryCanvasFor(OWNER, INPUT);
      impl.temporaryCanvasesOf(OWNER).save(saved.id, saved.revision);
      impl.storage.temporaryCanvases.put({
        id: "gone", title: "Yesterday", revision: 1, createdAt: new Date(expired - HOUR), expiresAt: new Date(expired),
        placements: [{ placementId: "p1", ref: CONSOLE_WIDGET, layout: { x: 0, y: 0, w: 6, h: 4 }, filters: {}, updatedAt: 0 }],
      });
      let deliveriesBefore = [...impl.storage.workflowDeliveries.list()];

      await impl.runAlarmTasks();

      expect(impl.storage.temporaryCanvases.get("gone")).toBeUndefined();
      expect(impl.storage.temporaryCanvases.get(saved.id)).toBeDefined();
      expect(impl.storage.workflowDefinitions.get("kept-definition")).toBeDefined();
      expect([...impl.storage.workflowDeliveries.list()]).toEqual(deliveriesBefore);
    });
  });
});

describe("personal creation never reaches shared configuration (FAC-137, N1)", () => {
  it("creates, saves and removes without asking for build or publish, and writes no shared configuration", async () => {
    await withSession(async impl => {
      // Someone holding no shared configuration authority: any ask would be refused, and is counted.
      let asked: string[] = [];
      impl.requireSharedConfiguration = async (_userId: string, action: string) => {
        asked.push(action);
        throw new Error("SHARED_CONFIGURATION_REFUSED");
      };
      let made = impl.createTemporaryCanvasFor(OWNER, INPUT);
      let saved = impl.temporaryCanvasesOf(OWNER).save(made.id, made.revision);
      expect(impl.temporaryCanvasesOf(OWNER).list()).toHaveLength(1);
      impl.temporaryCanvasesOf(OWNER).remove(saved.id, saved.revision);

      expect(asked).toEqual([]);
      for (let shared of ["consoles", "canvases", "canvasPages", "widgetIndexOwed"]) {
        expect([...impl.storage[shared].list()], shared).toEqual([]);
      }
    });
  });
});

describe("the operate agent can't write a temporary canvas (FAC-137, N9)", () => {
  it("offers an operate chat no temporary canvas tool: only the person's own session writes one", () => {
    expect(OPERATE_AGENT_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(OPERATE_AGENT_TOOL_NAMES.filter(name => /temporary|canvas/i.test(name))).toEqual(["listCanvases"]);
  });
});

// A console's widgets in the deployment's widget index (FAC-11 slice 2): which versions one
// publication or delete lists and withdraws, and how the service's answers are kept. Pure, with
// recorded fake ports; the kernel and gatekeeper path is operate-console-widget-index.test.ts.
import { describe, expect, it } from "vitest";
import type { WidgetIndexEntry, WidgetIndexOutcome } from "@gadgets/workshop-shared/gatekeeper";
import type { ConsoleWidgetEntry } from "@gadgets/workshop-shared/operate-console";
import { emptyWidgetIndexRecord, indexConsoleWidgets, widgetIndexPlan, WIDGET_INDEX_CHOOSE, WIDGET_INDEX_NO_WORKSPACE, type ConsoleWidgetIndexRecord, type WidgetIndexPorts } from "../src/console-widget-index";

const entry = (blueprintId: string, version = 1, label = blueprintId): ConsoleWidgetEntry =>
  ({ gadgetId: 1, blueprintId, version, label, state: "resettable" });
const OPS = { accountId: 7, workspaceId: "ws-ops", name: "Operations" };

const answer = (value: WidgetIndexOutcome | Error | undefined): Promise<WidgetIndexOutcome> =>
  value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? { status: "applied", removed: true });

function ports(answers: { register?: WidgetIndexOutcome | Error; withdraw?: WidgetIndexOutcome | Error } = {},
    workspaces: typeof OPS[] | Error = [OPS]) {
  const calls: string[] = [];
  const p: WidgetIndexPorts = {
    workspaces: async () => { if (workspaces instanceof Error) throw workspaces; return workspaces; },
    register: async (accountId, workspaceId, e: WidgetIndexEntry) => {
      calls.push(`register ${accountId} ${workspaceId} ${e.sourceId}@${e.sourceVersion} ${JSON.stringify(e.purpose)}`);
      return answer(answers.register);
    },
    withdraw: async (accountId, workspaceId, sourceId, sourceVersion) => {
      calls.push(`withdraw ${accountId} ${workspaceId} ${sourceId}@${sourceVersion}`);
      return answer(answers.withdraw);
    },
    description: async id => id === "described" ? "Who is free today" : null,
  };
  return { p, calls };
}

const listed = (record: ConsoleWidgetIndexRecord) => record.widgets.map(w => [w.versionId, w.outcome.status]);

describe("widgetIndexPlan", () => {
  it("withdraws what the console no longer lists, unless another published console still does", () => {
    const previous: ConsoleWidgetIndexRecord = { ...emptyWidgetIndexRecord("c"),
      widgets: [{ versionId: "a@1", label: "A", outcome: { status: "applied" } }, { versionId: "b@1", label: "B", outcome: { status: "applied" } }],
      writtenAt: { "a@1": "3", "b@1": "3" } };
    expect(widgetIndexPlan(previous, [], "4", new Set(["b@1"]))).toEqual({ register: [], withdraw: ["a@1"] });
    // A delete withdraws everything nobody else lists.
    expect(widgetIndexPlan(previous, null, null, new Set())).toEqual({ register: [], withdraw: ["a@1", "b@1"] });
  });

  it("writes each listed version once per publication revision, and again on a new one", () => {
    const previous: ConsoleWidgetIndexRecord = { ...emptyWidgetIndexRecord("c"),
      widgets: [{ versionId: "a@1", label: "A", outcome: { status: "applied" } }], writtenAt: { "a@1": "4" } };
    expect(widgetIndexPlan(previous, [entry("a")], "4", new Set()).register).toEqual([]);
    expect(widgetIndexPlan(previous, [entry("a")], "5", new Set()).register).toEqual([entry("a")]);
  });

  it("never withdraws a version the console still lists, even with an earlier withdrawal pending", () => {
    const previous: ConsoleWidgetIndexRecord = { ...emptyWidgetIndexRecord("c"), pendingWithdraws: [{ versionId: "a@1", reason: "down" }] };
    expect(widgetIndexPlan(previous, [entry("a")], "2", new Set()).withdraw).toEqual([]);
  });
});

describe("indexConsoleWidgets", () => {
  it("lists for the one qualifying workspace as the person's own account, with the blueprint's description", async () => {
    const { p, calls } = ports();
    const next = await indexConsoleWidgets(emptyWidgetIndexRecord("c"),
      { revision: "1", widgets: [entry("described", 1, "Technicians")] }, new Set(), p);
    expect(calls).toEqual(['register 7 ws-ops described@1 "Technicians: Who is free today"']);
    expect(next).toMatchObject({ target: { workspaceId: "ws-ops", name: "Operations" }, blocked: null, writtenAt: { "described@1": "1" } });
  });

  it("keeps a refusal or a proposal as the service gave it, never as listed, and tries again next time", async () => {
    for (const outcome of [{ status: "refused", reason: "InferOps refused" }, { status: "proposed", reason: "awaiting review" }] as const) {
      const { p } = ports({ register: outcome });
      const next = await indexConsoleWidgets(emptyWidgetIndexRecord("c"), { revision: "1", widgets: [entry("a")] }, new Set(), p);
      expect(next.widgets).toEqual([{ versionId: "a@1", label: "a", outcome }]);
      expect(next.writtenAt).toEqual({});
      expect(widgetIndexPlan(next, [entry("a")], "1", new Set()).register).toEqual([entry("a")]);
    }
  });

  it("turns a write that throws into an unavailable answer, never an exception", async () => {
    const { p } = ports({ register: new Error("socket closed") });
    const next = await indexConsoleWidgets(emptyWidgetIndexRecord("c"), { revision: "1", widgets: [entry("a")] }, new Set(), p);
    expect(listed(next)).toEqual([["a@1", "unavailable"]]);
  });

  it("writes nothing without exactly one workspace, saying why, and nothing when asking fails", async () => {
    const none = await indexConsoleWidgets(emptyWidgetIndexRecord("c"), { revision: "1", widgets: [entry("a")] }, new Set(), ports({}, []).p);
    expect(none).toMatchObject({ blocked: WIDGET_INDEX_NO_WORKSPACE, target: null });
    const two = ports({}, [OPS, { accountId: 7, workspaceId: "ws-k", name: "Knowledge" }]);
    expect(await indexConsoleWidgets(emptyWidgetIndexRecord("c"), { revision: "1", widgets: [entry("a")] }, new Set(), two.p))
      .toMatchObject({ blocked: WIDGET_INDEX_CHOOSE, target: null });
    expect(two.calls).toEqual([]);
    const failing = await indexConsoleWidgets(emptyWidgetIndexRecord("c"), { revision: "1", widgets: [entry("a")] }, new Set(),
      ports({}, new Error("down")).p);
    expect(failing.blocked).toContain("couldn't say where you may publish");
  });

  it("keeps a failed withdrawal as owed, and clears it once it succeeds", async () => {
    const start: ConsoleWidgetIndexRecord = { ...emptyWidgetIndexRecord("c"), target: { workspaceId: "ws-ops", name: "Operations" },
      widgets: [{ versionId: "a@1", label: "a", outcome: { status: "applied" } }], writtenAt: { "a@1": "1" } };
    const failed = await indexConsoleWidgets(start, { revision: "2", widgets: [] }, new Set(),
      ports({ withdraw: { status: "unavailable", reason: "InferOps couldn't be reached." } }).p);
    expect(failed.pendingWithdraws).toEqual([{ versionId: "a@1", reason: "InferOps couldn't be reached." }]);
    const retried = ports();
    const cleared = await indexConsoleWidgets(failed, { revision: "3", widgets: [] }, new Set(), retried.p);
    expect(retried.calls).toEqual(["withdraw 7 ws-ops a@1"]);
    expect(cleared.pendingWithdraws).toEqual([]);
  });

  it("drops an owed withdrawal another published console now lists, without calling the service", async () => {
    const start: ConsoleWidgetIndexRecord = { ...emptyWidgetIndexRecord("c"), target: { workspaceId: "ws-ops", name: "Operations" },
      pendingWithdraws: [{ versionId: "a@1", reason: "down" }] };
    const { p, calls } = ports();
    const next = await indexConsoleWidgets(start, { revision: "2", widgets: [] }, new Set(["a@1"]), p);
    expect(calls).toEqual([]);
    expect(next.pendingWithdraws).toEqual([]);
  });
});

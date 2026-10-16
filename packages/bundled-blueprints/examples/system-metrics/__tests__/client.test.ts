// The System metrics client in jsdom, against the demo source the Durable Object serves: what each
// panel state shows, the exact facts, cells and units, that values are text, that only the latest
// load is drawn, and that it is read-only and draws no verdict.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_INSTALLATIONS } from "../files/lib/fixture.ts";
import type { GadgetStub, InstallationMetrics, LoadMetricsResult } from "../files/lib/protocol.ts";
import { listDemoInstallations, loadDemoMetrics } from "../files/lib/source.ts";

const [A, B, C, D] = DEMO_INSTALLATIONS.map(entry => entry.installation);

/** A `gadget` stub over the demo source, recording which installation each load asked for. */
async function start(override?: Partial<GadgetStub>) {
  const asked: string[] = [];
  (globalThis as { gadget?: unknown }).gadget = {
    listInstallations: async () => listDemoInstallations(),
    loadMetrics: async (id: string) => {
      asked.push(id);
      return loadDemoMetrics(id);
    },
    ...override,
  };
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelector("main")!.textContent).not.toContain("Loading"));
  return { asked };
}

const main = () => document.querySelector("main")!;
const text = () => main().textContent ?? "";
const panel = (label: string) => main().querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const facts = (label: string) => [...panel(label).querySelectorAll(".facts dd")].map(dd => dd.textContent);
const rows = (label: string, part = "tbody") =>
  [...panel(label).querySelectorAll(`${part} tr`)].map(tr => [...tr.children].map(td => td.firstChild?.textContent ?? ""));
async function pick(installationId: string) {
  const picker = document.querySelector("select")!;
  picker.value = installationId;
  picker.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(text()).not.toContain("Loading"));
}
const FOOTNOTE = "No threshold, alert or health verdict is set by this view.";

/** Installation A's answer with its panels replaced, for states the fixture does not hold. */
function stubbed(change: (metrics: InstallationMetrics) => void): LoadMetricsResult {
  const result = loadDemoMetrics(A!.installationId);
  if (!result.ok) throw new Error("expected A");
  change(result);
  return result;
}

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
afterEach(() => {
  delete (globalThis as { gadget?: unknown }).gadget;
  vi.unstubAllGlobals();
});

describe("System metrics client", () => {
  it("C1 labels the data as a demo fixture, always", async () => {
    await start();
    expect(document.querySelector(".demo")!.textContent).toBe(
      "DEMO DATA — synthetic figures bundled in this gadget. Not your installation's activity, runs or health, " +
      "and not read from any Analytics Engine dataset, InferOps or Cloudflare account.");
  });

  it("C2 draws installation A with each panel's facts, exact cells, units and footnote", async () => {
    const { asked } = await start();
    expect(asked).toEqual([A!.installationId]);
    expect([...main().querySelectorAll("section h2")].map(h => h.textContent))
      .toEqual(["Activity", "Agent runs", "Runtime health"]);

    expect(facts("Activity")).toEqual([
      "Demo fixture (synthetic), shaped like activity/v1 events",
      "Installation total for Demo Installation A — no per-person figures",
      "2026-10-05T00:00:00.000Z to 2026-10-12T00:00:00.000Z (UTC)",
      "Last updated 2026-10-11T23:00:00.000Z.",
    ]);
    expect(rows("Activity", "thead")).toEqual([["Event", "Count"]]);
    expect(rows("Activity")).toEqual([
      ["People active", "14 people"],
      ["user.authenticated", "52 events"],
      ["workspace.opened", "131 events"],
      ["gadget.created", "9 events"],
      ["connection.created", "3 events"],
      ["connection.removed", "0 events"],
    ]);

    expect(facts("Agent runs")).toEqual([
      "Demo fixture (synthetic), shaped like InferOps coding-run statuses",
      "Coding runs requested in the window for Demo Installation A, by status as of 2026-10-11T23:30:00.000Z — no per-person figures",
      "2026-10-05T00:00:00.000Z to 2026-10-12T00:00:00.000Z (UTC)",
      "Last updated 2026-10-11T23:30:00.000Z.",
    ]);
    expect(rows("Agent runs", "thead")).toEqual([["Status", "Runs"]]);
    expect(rows("Agent runs")).toEqual([
      ["queued", "1 run"], ["running", "2 runs"], ["succeeded", "17 runs"], ["failed", "0 runs"],
      ["cancelled", "1 run"], ["unknown", "1 run"],
    ]);
    const unknownRow = [...panel("Agent runs").querySelectorAll("tbody tr")].at(-1)!;
    expect(unknownRow.querySelector(".meaning")!.textContent)
      .toBe("Runner never reported back; the run may have changed things. Not counted as failed.");
    expect(rows("Agent runs", "tfoot")).toEqual([["Total", "22 runs"]]);

    expect(facts("Runtime health")).toEqual([
      "Demo fixture (synthetic), shaped like Workers Observability per-Worker figures",
      "Installation total for Demo Installation A — no per-person figures",
      "2026-10-11T00:00:00.000Z to 2026-10-12T00:00:00.000Z (UTC)",
      "Last updated 2026-10-11T23:55:00.000Z.",
    ]);
    expect(rows("Runtime health", "thead")).toEqual([["Worker", "Requests", "Errors", "Error rate", "p95 wall time"]]);
    expect(rows("Runtime health")).toEqual([
      ["demo-router", "48,210 requests", "37 errors", "0.1 %", "182 ms"],
      ["demo-workshop", "21,904 requests", "0 errors", "0.0 %", "Unknown"],
      ["demo-gatekeeper", "6,120 requests", "4 errors", "0.1 %", "95 ms"],
    ]);
    for (const label of ["Activity", "Agent runs", "Runtime health"]) {
      expect(panel(label).querySelector(".note")!.textContent).toBe(FOOTNOTE);
      expect(panel(label).querySelector(".stale")).toBeNull();
    }
  });

  it("C3 B: stale activity with an Unknown, unavailable runs, and health still drawn", async () => {
    await start();
    await pick(B!.installationId);
    expect(panel("Activity").querySelector("h2")!.textContent).toBe("Activity (stale)");
    expect(panel("Activity").querySelector(".facts .stale")!.textContent)
      .toBe("Stale: last updated 2026-10-10T00:00:00.000Z, 48 hours before the end of the window.");
    expect(rows("Activity")).toContainEqual(["gadget.created", "Unknown"]);

    const runs = panel("Agent runs");
    expect(runs.querySelector(".notice.error h3")!.textContent).toBe("Agent runs could not be loaded");
    expect(runs.querySelector(".notice.error p")!.textContent).toBe("The demo run source is offline (synthetic error).");
    expect(runs.querySelector("table")).toBeNull();
    expect(facts("Agent runs")).toEqual(["Demo fixture (synthetic), shaped like InferOps coding-run statuses"]);
    expect(runs.textContent).not.toContain("(UTC)");
    expect(runs.textContent).not.toContain("updated");

    expect(rows("Runtime health")).toEqual([
      ["demo-router", "3,002 requests", "12 errors", "0.4 %", "240 ms"],
      ["demo-scheduler", "0 requests", "0 errors", "No requests", "Unknown"],
    ]);
  });

  it("C4 C: three empty notices and no table in any panel", async () => {
    await start();
    await pick(C!.installationId);
    expect([...main().querySelectorAll("section .notice h3")].map(h => h.textContent)).toEqual([
      "No activity recorded in this window", "No coding runs in this window", "No Worker reported figures in this window",
    ]);
    expect(main().querySelector("table")).toBeNull();
    expect(main().querySelector(".notice.error")).toBeNull();
  });

  it("C5 D: three error notices, and no table, window or freshness", async () => {
    await start();
    await pick(D!.installationId);
    expect([...main().querySelectorAll("section .notice.error h3")].map(h => h.textContent)).toEqual([
      "Activity could not be loaded", "Agent runs could not be loaded", "Runtime health could not be loaded",
    ]);
    expect(main().querySelector("table")).toBeNull();
    expect(text()).not.toContain("(UTC)");
    expect(text()).not.toContain("updated");
    expect(text()).not.toContain(FOOTNOTE);
  });

  it("C6 asks the source for exactly the picked installation; nothing of another is drawn", async () => {
    const { asked } = await start();
    await pick(B!.installationId);
    expect(asked).toEqual([A!.installationId, B!.installationId]);
    expect(text()).not.toContain("demo-workshop");
    expect(text()).not.toContain("demo-gatekeeper");
    expect(text()).not.toContain(A!.installationName);
  });

  it("C7 draws only the latest load: a late answer from an earlier pick is ignored", async () => {
    const slow = Promise.withResolvers<LoadMetricsResult>();
    await start({
      loadMetrics: async (id: string) => (id === B!.installationId ? slow.promise : loadDemoMetrics(id)),
    });
    const picker = document.querySelector("select")!;
    picker.value = B!.installationId;
    picker.dispatchEvent(new Event("change"));
    // Switching clears every panel before the answer.
    expect(main().querySelectorAll("section").length).toBe(0);
    await pick(C!.installationId);
    slow.resolve(loadDemoMetrics(B!.installationId));
    await slow.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain("No activity recorded in this window");
    expect(text()).not.toContain("demo-scheduler");
  });

  it("C8 draws values as text and offers no control but the picker and Reload", async () => {
    const markup = `<img src="x" onerror="globalThis.pwned = true">`;
    await start({
      loadMetrics: async () => stubbed(m => {
        m.installation.installationName = markup;
        if (m.health.state === "reported") m.health.data.workers[0]!.worker = markup;
      }),
    });
    expect(document.querySelector("main img")).toBeNull();
    expect(text()).toContain(markup);
    expect(document.querySelectorAll("input, textarea, form, a[href]").length).toBe(0);
    expect([...document.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Reload"]);
    expect(document.querySelectorAll("select").length).toBe(1);
  });

  it("C9 draws no health verdict in any state", async () => {
    await start();
    for (const installation of [A, B, C, D]) {
      await pick(installation!.installationId);
      for (const node of document.querySelectorAll("[class]")) {
        expect(node.className).not.toMatch(/\b(healthy|degraded|ok|critical)\b/i);
      }
      expect(document.body.textContent).not.toMatch(/healthy|degraded/i);
    }
  });

  it("C10 a null among zeros is not empty: tables with Unknown, never the empty notice", async () => {
    await start({
      loadMetrics: async () => stubbed(m => {
        if (m.activity.state !== "reported" || m.runs.state !== "reported") throw new Error("expected reported");
        m.activity.data.activePeople = 0;
        m.activity.data.events = m.activity.data.events.map(e => ({
          ...e, count: e.eventType === "connection.created" ? null : 0,
        }));
        m.runs.data.byStatus = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: null, unknown: 0 };
      }),
    });
    expect(text()).not.toContain("No activity recorded in this window");
    expect(text()).not.toContain("No coding runs in this window");
    expect(rows("Activity")).toEqual([
      ["People active", "0 people"],
      ["user.authenticated", "0 events"],
      ["workspace.opened", "0 events"],
      ["gadget.created", "0 events"],
      ["connection.created", "Unknown"],
      ["connection.removed", "0 events"],
    ]);
    expect(rows("Agent runs")).toContainEqual(["cancelled", "Unknown"]);
    expect(rows("Agent runs", "tfoot")).toEqual([["Total", "Unknown (1 of 6 statuses not reported)"]]);
  });

  it("C11 an empty panel that is stale says both", async () => {
    await start({
      loadMetrics: async () => stubbed(m => {
        if (m.activity.state !== "reported") throw new Error("expected reported");
        m.activity.asOf = "2026-10-10T00:00:00.000Z";
        m.activity.data.activePeople = 0;
        m.activity.data.events = m.activity.data.events.map(e => ({ ...e, count: 0 }));
      }),
    });
    const activity = panel("Activity");
    expect(activity.querySelector(".notice h3")!.textContent).toBe("No activity recorded in this window");
    expect(activity.querySelector(".facts .stale")!.textContent)
      .toBe("Stale: last updated 2026-10-10T00:00:00.000Z, 48 hours before the end of the window.");
    expect(activity.querySelector("h2")!.textContent).toBe("Activity (stale)");
    expect(activity.querySelector("table")).toBeNull();
  });
});

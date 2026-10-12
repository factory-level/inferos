// The Model usage client in jsdom, against the demo source the Durable Object serves: what each
// state shows, the exact totals, units and provenance, that values are text, and that it is
// read-only. A wrong total or a missing provenance label fails here, not just in a screenshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WORKSPACES } from "../files/lib/fixture.ts";
import type { GadgetStub, LoadUsageResult } from "../files/lib/protocol.ts";
import { listDemoWorkspaces, loadDemoUsage } from "../files/lib/source.ts";

const [OPS, RESEARCH, QUIET, UNAVAILABLE] = DEMO_WORKSPACES.map(entry => entry.workspace);

/** A `gadget` stub over the demo source, recording which workspace each load asked for. */
async function start(override?: Partial<GadgetStub>) {
  const asked: string[] = [];
  (globalThis as { gadget?: unknown }).gadget = {
    listWorkspaces: async () => listDemoWorkspaces(),
    loadUsage: async (id: string) => {
      asked.push(id);
      return loadDemoUsage(id);
    },
    ...override,
  };
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelector("main")!.textContent).not.toContain("Loading"));
  return { asked };
}

const main = () => document.querySelector("main")!;
const text = () => main().textContent ?? "";
const cells = (sel: string) => [...main().querySelectorAll(sel)].map(td => td.textContent);
async function pick(workspaceId: string) {
  const picker = document.querySelector("select")!;
  picker.value = workspaceId;
  picker.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(text()).not.toContain("Loading"));
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

describe("Model usage client", () => {
  it("labels the data as a demo fixture, always", async () => {
    await start();
    expect(document.querySelector(".demo")!.textContent).toBe(
      "DEMO DATA — synthetic figures bundled in this gadget. Not your usage, not a bill, and not read " +
      "from any provider, gateway or InferOS account.");
  });

  it("draws the first workspace with source, scope, window, freshness, units and exact totals", async () => {
    const { asked } = await start();
    expect(asked).toEqual([OPS!.workspaceId]);
    expect(cells(".facts dd")).toEqual([
      "Demo fixture (synthetic)",
      "Workspace total for Demo Operations — no per-person figures",
      "2026-10-05T00:00:00.000Z to 2026-10-12T00:00:00.000Z (UTC)",
      "Last updated 2026-10-11T23:00:00.000Z.",
    ]);
    expect(cells("thead th")).toEqual([
      "Model", "Provider", "Input", "Output", "Estimated cost", "Provider-reported cost", "Billed cost",
    ]);
    expect([...main().querySelectorAll("tbody tr")].map(tr => [...tr.children].map(td => td.textContent))).toEqual([
      ["demo-large", "Demo Provider A", "1,250,000 tokens", "310,000 tokens", "18.60 USD", "19.12 USD", "Unknown"],
      ["demo-small", "Demo Provider A", "4,800,000 tokens", "920,000 tokens", "7.44 USD", "7.31 USD", "Unknown"],
      ["demo-code", "Demo Provider B", "640,000 tokens", "205,500 tokens", "11.30 USD", "Unknown", "Unknown"],
    ]);
    // 1,860 + 744 + 1,130 cents estimated; provider-reported is missing for one model, so unknown.
    expect(cells("tfoot td")).toEqual([
      "Workspace total", "6,690,000 tokens", "1,435,500 tokens", "37.34 USD",
      "Unknown (1 of 3 models not reported)", "Unknown",
    ]);
    expect(text()).toContain("Estimated: computed from token counts and a price table.");
    expect(text()).toContain("Provider-reported: as the model provider or gateway reported it.");
    expect(text()).toContain("Billed: as an invoice charged it; no billing source is connected.");
    expect(text()).toContain("No budget or spending limit is set or enforced by this view.");
  });

  it("marks stale figures, shows an empty window as no usage (not zero cost), and a failure as one", async () => {
    await start();
    await pick(RESEARCH!.workspaceId);
    expect(main().querySelector(".facts .stale")!.textContent)
      .toBe("Stale: last updated 2026-10-10T00:00:00.000Z, 48 hours before the end of the window.");
    await pick(QUIET!.workspaceId);
    expect(text()).toContain("No model usage in this window");
    expect(main().querySelector("table")).toBeNull();
    await pick(UNAVAILABLE!.workspaceId);
    expect(main().querySelector(".notice.error h2")!.textContent).toBe("Model usage could not be loaded");
    expect(main().querySelector("table")).toBeNull();
  });

  it("asks the source for exactly the picked workspace; nothing is filtered client-side", async () => {
    const { asked } = await start();
    await pick(RESEARCH!.workspaceId);
    expect(asked).toEqual([OPS!.workspaceId, RESEARCH!.workspaceId]);
    expect(text()).not.toContain("demo-small");
  });

  it("draws values as text and offers no control but the picker and Reload", async () => {
    const markup = `<img src="x" onerror="globalThis.pwned = true">`;
    const answer: LoadUsageResult = {
      ok: true, workspace: { workspaceId: "w", workspaceName: markup }, source: "demo-fixture",
      window: { from: "2026-10-05T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" },
      asOf: "2026-10-11T23:00:00.000Z",
      rows: [{ model: markup, provider: "p", inputTokens: 1, outputTokens: 1, estimatedCents: 1,
        providerReportedCents: 1, billedCents: null }],
    };
    await start({ loadUsage: async () => answer });
    expect(document.querySelector("main img")).toBeNull();
    expect(text()).toContain(markup);
    expect(document.querySelectorAll("input, textarea, form, a[href]").length).toBe(0);
    expect([...document.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Reload"]);
    expect(document.querySelectorAll("select").length).toBe(1);
  });
});

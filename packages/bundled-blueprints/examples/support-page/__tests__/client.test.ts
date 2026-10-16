// The tech support page client in jsdom, against the demo source the Durable Object serves: what
// each region state shows, the exact texts, that values are text, that only the latest load is
// drawn, and that the page is read-only and draws no verdict.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_INSTALLATIONS } from "../files/lib/fixture.ts";
import type { GadgetStub, LoadSupportPageResult, SupportPage } from "../files/lib/protocol.ts";
import { listDemoInstallations, loadDemoSupportPage } from "../files/lib/source.ts";

const [A, B, C, D, E] = DEMO_INSTALLATIONS.map(entry => entry.installation);
const NO_SOURCE = ["No data source connected yet", "Needs the approvals/v1 metric family, which is not built."];
const PEOPLE = "People active today";
const RUNS = "Coding runs failed, last 24 hours";
const REJECTED = "Actions rejected, last 24 hours";
const MEDIAN = "Median time to decision";

/** A `gadget` stub over the demo source, recording which installation each load asked for. */
async function start(override?: Partial<GadgetStub>) {
  const asked: string[] = [];
  (globalThis as { gadget?: unknown }).gadget = {
    listInstallations: async () => listDemoInstallations(),
    loadSupportPage: async (id: string) => {
      asked.push(id);
      return loadDemoSupportPage(id);
    },
    ...override,
  };
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelector("main")!.textContent).not.toContain("Loading"));
  return { asked };
}

const main = () => document.querySelector("main")!;
const text = () => main().textContent ?? "";
const region = (label: string) => main().querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
/** A tile's or region's lines below its heading. */
const below = (label: string) =>
  [...region(label).children].filter(c => !/^H[23]$/.test(c.tagName)).map(c => c.textContent);
async function pick(installationId: string) {
  const picker = document.querySelector("select")!;
  picker.value = installationId;
  picker.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(text()).not.toContain("Loading"));
}
/** Installation A's answer with parts replaced, for states the fixture does not hold. */
function stubbed(change: (page: SupportPage) => void): LoadSupportPageResult {
  const result = loadDemoSupportPage(A!.installationId);
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

describe("Tech support page client", () => {
  it("C1 labels the data as a demo fixture and the page as read-only, always", async () => {
    await start();
    expect(document.querySelector(".demo .banner")!.textContent).toBe(
      "DEMO DATA — synthetic support figures, board and runbook bundled in this gadget. Not your installation's " +
      "activity, runs, support issues or runbook, and not read from InferOps, InferMind, Analytics Engine or any account.");
    expect(document.querySelector(".demo .readonly")!.textContent)
      .toBe("Read-only: nothing on this page can change an issue or the runbook.");
  });

  it("C2 draws installation A exactly", async () => {
    const { asked } = await start();
    expect(asked).toEqual([A!.installationId]);
    expect(below(PEOPLE)).toEqual([
      "6 people", "Installation total — no per-person figures.",
      "Source: Demo fixture (synthetic), shaped like activity/v1 events",
      "2026-10-12T00:00:00.000Z to 2026-10-12T11:30:00.000Z (UTC)", "Last updated 2026-10-12T11:30:00.000Z.",
    ]);
    expect(below(RUNS)).toEqual([
      "0 runs", "Runs whose runner reported failure. Runs with an unknown outcome are not counted.",
      "Source: Demo fixture (synthetic), shaped like InferOps coding-run statuses",
      "2026-10-11T11:30:00.000Z to 2026-10-12T11:30:00.000Z (UTC)", "Last updated 2026-10-12T11:30:00.000Z.",
    ]);
    expect(below(REJECTED)).toEqual(NO_SOURCE);
    expect(below(MEDIAN)).toEqual(NO_SOURCE);

    expect(region("Support board").querySelector("h2")!.textContent).toBe("Support board — Customer support (demo)");
    expect([...region("Support board").querySelectorAll(".column h3")].map(h => h.textContent))
      .toEqual(["Triage (1)", "To do (0)", "In progress (2)", "Resolved (1)"]);
    expect(region("To do column").textContent).toContain("No issues");
    expect(region("To do column").querySelector("ul")).toBeNull();
    const sup9 = [...region("In progress column").querySelectorAll("li")][0]!;
    expect([...sup9.children].map(s => s.textContent)).toEqual([
      "SUP-9  Demo: sign-in loops for the demo tenant", "Urgent", "Due 2026-10-14",
      "Blocked: Waiting for the demo gatekeeper to restart (synthetic)",
    ]);

    const runbook = region("Support runbook");
    expect(runbook.querySelector("h2")!.textContent).toBe("Support runbook (demo)");
    expect([...runbook.querySelectorAll("h3")].map(h => h.textContent)).toEqual(["First response", "Escalation", "Known issues"]);
    expect([...runbook.querySelectorAll("ol")].map(ol => ol.querySelectorAll("li").length)).toEqual([3, 4]);
    expect(runbook.textContent).toContain("Version 7, last edited 2026-10-09T15:20:00.000Z.");
  });

  it("C3 B: Unknown people, a stale tile and board, and a missing runbook", async () => {
    await start();
    await pick(B!.installationId);
    expect(below(PEOPLE)[0]).toBe("Unknown");
    expect(region(RUNS).querySelector("h3")!.textContent).toBe(`${RUNS} (stale)`);
    expect(region(RUNS).querySelector(".stale")!.textContent)
      .toBe("Stale: last updated 2026-10-12T09:00:00.000Z, 3 hours before this page was read.");
    expect(region("Support board").querySelector("h2")!.textContent).toBe("Support board — Customer support (demo) (stale)");
    expect(region("Support board").querySelector(".stale")!.textContent)
      .toBe("Stale: last updated 2026-10-12T10:00:00.000Z, 2 hours before this page was read.");
    expect(below("Support runbook")).toEqual(["There is no page named support-runbook in this Wiki."]);
    expect(region("Support runbook").querySelector("ol, h3")).toBeNull();
  });

  it("C4 C: zeros are figures, the board and runbook show their empty notices", async () => {
    await start();
    await pick(C!.installationId);
    expect(below(PEOPLE)[0]).toBe("0 people");
    expect(below(RUNS)[0]).toBe("0 runs");
    expect(region("Support board").textContent).toContain("No open or resolved issues on this board.");
    expect(region("Support board").querySelector("ul, .column")).toBeNull();
    expect(below("Support runbook")).toEqual(["The runbook page has nothing to read yet."]);
  });

  it("C5 D: each region shows its denied text and nothing else", async () => {
    await start();
    await pick(D!.installationId);
    expect(below(PEOPLE)).toEqual(["You don't have access to this figure in this installation."]);
    expect(below(RUNS)).toEqual(["You don't have access to this figure in this installation."]);
    expect(below("Support board")).toEqual(["You don't have access to the support board in this installation."]);
    expect(below("Support runbook")).toEqual(["You don't have access to the runbook in this installation."]);
    expect(text()).not.toMatch(/SUP-\d/);
    expect(region("Support runbook").querySelector("h2")!.textContent).toBe("Support runbook");
    expect(below(REJECTED)).toEqual(NO_SOURCE);
    expect(below(MEDIAN)).toEqual(NO_SOURCE);
  });

  it("C6 E: each region shows its unavailable text, with no figure, window, freshness, issue or heading", async () => {
    await start();
    await pick(E!.installationId);
    expect(below(PEOPLE)).toEqual([`${PEOPLE} could not be loaded: The demo activity source is offline (synthetic error).`]);
    expect(below(RUNS)).toEqual([`${RUNS} could not be loaded: The demo run source is offline (synthetic error).`]);
    expect(below("Support board"))
      .toEqual(["The support board could not be loaded: The demo board source is offline (synthetic error)."]);
    expect(below("Support runbook")).toEqual(["The runbook could not be loaded: The demo Wiki is offline (synthetic error)."]);
    expect(text()).not.toContain("(UTC)");
    expect(text()).not.toContain("updated");
    expect(text()).not.toMatch(/SUP-\d/);
  });

  it("C7 asks for exactly the picked installation; nothing of A remains after switching", async () => {
    const { asked } = await start();
    await pick(D!.installationId);
    expect(asked).toEqual([A!.installationId, D!.installationId]);
    expect(text()).not.toMatch(/SUP-\d/);
    expect(text()).not.toContain("First response");
  });

  it("C8 draws only the latest load", async () => {
    const slow = Promise.withResolvers<LoadSupportPageResult>();
    await start({
      loadSupportPage: async (id: string) => (id === B!.installationId ? slow.promise : loadDemoSupportPage(id)),
    });
    const picker = document.querySelector("select")!;
    picker.value = B!.installationId;
    picker.dispatchEvent(new Event("change"));
    expect(main().querySelectorAll("section").length).toBe(0);
    await pick(C!.installationId);
    slow.resolve(loadDemoSupportPage(B!.installationId));
    await slow.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain("No open or resolved issues on this board.");
    expect(text()).not.toContain("There is no page named");
  });

  it("C9 has no write affordance", async () => {
    const calls: string[] = [];
    await start({
      loadSupportPage: async (id: string) => {
        calls.push(id);
        return loadDemoSupportPage(id);
      },
    });
    expect([...document.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Reload"]);
    expect(document.querySelectorAll("select").length).toBe(1);
    expect(document.querySelectorAll(
      'input, textarea, form, a[href], [draggable="true"], [contenteditable], [tabindex], [role="button"]').length).toBe(0);
    const before = calls.length;
    for (const li of document.querySelectorAll("li")) {
      li.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      li.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.length).toBe(before);
  });

  it("C10 draws markup in issues and the runbook as text", async () => {
    await start();
    const markup = "<img src=x onerror=alert(1)>";
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(region("Support board").textContent).toContain(`Demo: report title shows ${markup} literally`);
    expect(region("Support board").textContent).toContain(`Blocked: Customer pasted ${markup} into the report`);
    expect(region("Support runbook").textContent).toContain(`even if it contains markup such as ${markup}.`);
  });

  it("C11 draws no verdict in any state", async () => {
    await start();
    const banned = new Set(["healthy", "degraded", "critical", "good", "bad", "red", "green"]);
    for (const who of [A, B, C, D, E]) {
      await pick(who!.installationId);
      expect(document.body.textContent).not.toMatch(/\b(Healthy|Degraded|Critical|OK)\b/);
      for (const node of document.querySelectorAll("[class]")) {
        for (const token of node.classList) {
          expect(banned.has(token)).toBe(false);
          expect(token.startsWith("severity")).toBe(false);
        }
      }
    }
  });

  it("C12 an empty board that is stale says both", async () => {
    await start({
      loadSupportPage: async () => stubbed(page => {
        if (page.board.state !== "reported") throw new Error("expected reported");
        page.board.asOf = "2026-10-12T10:00:00.000Z";
        page.board.data.columns = page.board.data.columns.map(c => ({ ...c, issues: [] }));
      }),
    });
    const board = region("Support board");
    expect(board.textContent).toContain("No open or resolved issues on this board.");
    expect(board.querySelector(".stale")!.textContent)
      .toBe("Stale: last updated 2026-10-12T10:00:00.000Z, 2 hours before this page was read.");
    expect(board.querySelector("h2")!.textContent).toBe("Support board — Customer support (demo) (stale)");
  });
});

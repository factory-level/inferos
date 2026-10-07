// The Records client in jsdom, against a fake `gadget` whose answers the test releases one by one:
// what each state shows, that labels and values are text, and that only the latest load is drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadRowsResult } from "../files/lib/protocol.ts";

const MARKUP = `<img src="x" onerror="globalThis.pwned = true">`;

const ready = (label: string, serials: string[]): LoadRowsResult => ({
  ok: true,
  table: {
    label, version: 1, relations: [{ name: "work_items", toKind: "project/issue" }],
    columns: [
      { key: "c1", name: "serial", label: "Serial", type: "text", required: true },
      { key: "c2", name: "hours", label: "Run hours", type: "integer", required: false },
    ],
  },
  records: serials.map((serial, i) => ({
    id: `r${i}`, tableVersion: 1, values: { serial, hours: i * 10 },
    links: i === 0 ? [{ relation: "work_items", toKind: "project/issue", ref: "inferops://a.b/project/issue-link/1" }] : [],
  })),
});

/** Loads the client; each `loadRows` call waits until the test answers it. */
async function start(...answers: LoadRowsResult[]) {
  const pending: Array<(result: LoadRowsResult) => void> = [];
  (globalThis as { gadget?: unknown }).gadget = {
    loadRows: () => new Promise<LoadRowsResult>(resolve => pending.push(resolve)),
  };
  const loaded = import("../files/client.ts");
  await vi.waitFor(() => expect(pending.length).toBe(1));
  pending.shift()!(answers[0]!);
  await loaded;
  return {
    answer: async (result: LoadRowsResult) => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!(result);
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    pending,
  };
}

const text = () => document.querySelector("main")!.textContent ?? "";
const reload = () => (document.querySelector("header button") as HTMLButtonElement).click();

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
afterEach(() => {
  delete (globalThis as { gadget?: unknown }).gadget;
});

describe("InferOps Records client", () => {
  it("draws rows with the definition they came with, as text", async () => {
    await start(ready("Assets", [MARKUP, "SN-2"]));
    expect(document.querySelector("h1")!.textContent).toBe("Assets");
    expect([...document.querySelectorAll("th")].map(th => th.textContent)).toEqual(["Serial", "Run hours", "work_items"]);
    const cells = [...document.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent));
    expect(cells).toEqual([[MARKUP, "0", "1 link"], ["SN-2", "10", ""]]);
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    expect(text()).toContain("Columns marked personal are not shown.");
  });

  it("shows the empty, not-connected, turned-off and unavailable states, each without rows", async () => {
    const view = await start(ready("Assets", []));
    expect(text()).toContain("No rows yet");

    for (const [result, shown] of [
      [{ ok: false, reason: "not-connected" }, "No InferOps table connected"],
      [{ ok: false, reason: "disabled", message: "off" }, "InferOps custom tables are turned off"],
      [{ ok: false, reason: "unavailable", message: "No such table or row is available to you." }, "This table is not available to you"],
      [{ ok: false, reason: "error", message: "InferOps could not be reached." }, "The rows could not be loaded"],
    ] as Array<[LoadRowsResult, string]>) {
      reload();
      await view.answer(result);
      expect(text()).toContain(shown);
      expect(document.querySelector("table")).toBeNull();
    }
  });

  it("clears the rows on a refusal, and shows them again on a reload that succeeds", async () => {
    const view = await start(ready("Assets", ["SN-1"]));
    expect(text()).toContain("SN-1");
    reload();
    expect(text()).toContain("Loading rows");
    expect(text()).not.toContain("SN-1");
    await view.answer({ ok: false, reason: "unavailable", message: "No such table or row is available to you." });
    expect(text()).not.toContain("SN-1");
    (document.querySelector("main button") as HTMLButtonElement).click();
    await view.answer(ready("Assets", ["SN-9"]));
    expect(text()).toContain("SN-9");
  });

  it("never draws a late answer to an earlier load", async () => {
    const view = await start(ready("Assets", ["SN-1"]));
    const button = document.querySelector("header button") as HTMLButtonElement;
    reload();
    expect(button.disabled).toBe(true);
    // Two loads in flight at once, which the disabled button otherwise prevents: the older one
    // (say, for a binding since replaced) answers last and must not be drawn.
    button.disabled = false;
    reload();
    await vi.waitFor(() => expect(view.pending.length).toBe(2));
    const [older, newer] = [view.pending[0]!, view.pending[1]!];
    newer(ready("Current", ["NEW-1"]));
    await new Promise(resolve => setTimeout(resolve, 0));
    older(ready("Previous binding", ["OLD-1"]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("h1")!.textContent).toBe("Current");
    expect(text()).toContain("NEW-1");
    expect(text()).not.toContain("OLD-1");
  });
});

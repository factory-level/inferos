// The Status Widget client in jsdom (FAC-86): its header mark is the InferOS logo, bundled as an
// asset, and it takes each declared state's look when the host says which state the widget is in.
// Only the host page may say so; anything else is ignored.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOOKS, NEUTRAL } from "../files/lib/status.ts";

const here = dirname(fileURLToPath(import.meta.url));
const STATES = JSON.parse(readFileSync(join(here, "../files/states.json"), "utf8")) as { states: string[] };

const mark = () => document.querySelector("header svg")!;
const stroke = () => mark().querySelector("path")!.getAttribute("stroke");
const status = () => document.querySelector('[role="status"]')!.textContent;
const tell = (data: unknown, source: MessageEventSource | null = window.parent) =>
  window.dispatchEvent(new MessageEvent("message", { data, source }));

beforeEach(async () => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  await import("../files/client.ts");
});

describe("Status Widget client", () => {
  it("draws the InferOS mark itself, as the app's favicon, hidden from assistive tech", () => {
    // The bundled copy must not drift from the logo the app ships.
    expect(readFileSync(join(here, "../files/lib/mark.svg"), "utf8"))
      .toBe(readFileSync(join(here, "../../../../workshop-frontend/public/favicon.svg"), "utf8"));
    expect(mark().getAttribute("viewBox")).toBe("0 0 64 64");
    expect(mark().getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("img")).toBeNull();
  });

  it("is neutral, and says so, until the host names its state", () => {
    expect(stroke()).toBe(NEUTRAL);
    expect(status()).toBe("Open this widget in Operate to see its state.");
  });

  it("gives every declared state its own look, and the mark follows each change", () => {
    // Every state states.json declares has a look of its own colour.
    expect(Object.keys(LOOKS).toSorted()).toEqual([...STATES.states].toSorted());
    for (let state of STATES.states) {
      tell({ type: "widget-state", state });
      expect(stroke(), state).toBe(LOOKS[state]!.color);
      expect(status(), state).toBe(LOOKS[state]!.label);
      expect((mark() as SVGElement).dataset.state).toBe(state);
      expect(mark().classList.contains("pulse"), state).toBe(state === "working");
    }
    expect(new Set(STATES.states.map(state => LOOKS[state]!.color)).size).toBe(STATES.states.length);
  });

  it("ignores a message that isn't the host's, or isn't a widget state", () => {
    tell({ type: "widget-state", state: "done" });
    tell({ type: "widget-state", state: "failed" }, null);
    tell({ type: "widget-state", state: 7 });
    tell("widget-state");
    expect(status()).toBe("Done");
    // An undeclared state is shown by name, neutral, never as another state's look.
    tell({ type: "widget-state", state: "paused" });
    expect(status()).toBe("paused");
    expect(stroke()).toBe(NEUTRAL);
  });
});

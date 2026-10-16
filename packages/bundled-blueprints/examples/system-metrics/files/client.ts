// ---------------------------------------------------------------------------
// System metrics (demo data) -- a read-only preview of a System Metrics view on SYNTHETIC figures.
//
// Every load asks the Durable Object for ONE demo installation, which returns only that
// installation's panels: Activity, Agent runs and Runtime health. Each panel carries its own source,
// window and freshness, fails on its own, and draws a missing figure as "Unknown", never as 0. It
// draws measurements only: no threshold, alert or health verdict. There are no controls but the
// installation picker and Reload. Every value is drawn as a text node.
// ---------------------------------------------------------------------------

import type {
  ActivityData, DemoInstallation, GadgetStub, HealthData, LoadMetricsResult, Panel, RunsData,
} from "./lib/protocol.ts";
import {
  errorRate, finishLoad, formatCount, formatMs, freshness, initialState, isEmpty, type PanelKind,
  RUN_STATUSES, runTotal, startLoad, type State,
} from "./lib/metrics.ts";

// Defined by the Workshop's iframe bootstrap before this module runs.
declare const gadget: GadgetStub;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --head: #eef0f3; --text: #1b1f24; --muted: #5d6673;
  --border: #d8dce2; --accent: #2f6fde; --danger: #b42318; --warn-bg: #fff4d6; --warn: #7a4b00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2126; --head: #191c20; --text: #e7eaee; --muted: #9aa3ae;
    --border: #30363d; --accent: #7aa7ff; --danger: #ff8a80; --warn-bg: #3a2e12; --warn: #ffd27a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { display: flex; flex-direction: column; height: 100%; }
.demo { background: var(--warn-bg); color: var(--warn); padding: 8px 16px; font-size: 13px; font-weight: 600;
  border-bottom: 1px solid var(--border); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); background: var(--surface); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .spacer { flex: 1; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; }
button, select { font: inherit; color: inherit; }
.btn, select { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 5px 10px; }
.btn { cursor: pointer; }
.btn:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.content { flex: 1; overflow: auto; padding: 16px; }
section { margin: 0 0 24px; }
section h2 { font-size: 15px; margin: 0 0 8px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 12px; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.facts .stale { color: var(--danger); font-weight: 600; }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
th { background: var(--head); font-weight: 600; font-size: 13px; }
tfoot td { font-weight: 600; background: var(--head); }
.meaning { display: block; color: var(--muted); font-size: 12px; }
.note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.notice { margin: 0 auto; max-width: 460px; text-align: center; padding: 16px; }
.notice h3 { font-size: 14px; margin: 0 0 8px; }
.notice p { color: var(--muted); margin: 0; }
.notice.error h3 { color: var(--danger); }
@media (max-width: 700px) { .content { padding: 8px; } th, td { padding: 5px 6px; } }
`;

/** An element whose children are nodes or plain text; strings always become text nodes. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: Array<Node | string | null>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null) node.append(child);
  }
  return node;
}

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

const picker = el("select", { "aria-label": "Demo installation" });
const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const refreshButton = el("button", { class: "btn", type: "button" }, "Reload");
const main = el("main", { class: "content", "aria-label": "System metrics" });
document.body.append(el("div", { class: "app" },
  el("div", { class: "demo", role: "note" },
    "DEMO DATA — synthetic figures bundled in this gadget. Not your installation's activity, runs or health, " +
    "and not read from any Analytics Engine dataset, InferOps or Cloudflare account."),
  el("header", { class: "bar" }, el("h1", {}, "System metrics"), picker, el("span", { class: "spacer" }),
    statusEl, refreshButton),
  main));

let state: State = initialState;

function notice(heading: string, isError: boolean, ...body: Array<Node | string>): HTMLElement {
  return el("div", { class: `notice${isError ? " error" : ""}` }, el("h3", {}, heading),
    ...(body.length > 0 ? [el("p", {}, ...body)] : []));
}

const PANELS: Record<PanelKind, { title: string; source: string; empty: string }> = {
  activity: { title: "Activity", source: "shaped like activity/v1 events", empty: "No activity recorded in this window" },
  runs: { title: "Agent runs", source: "shaped like InferOps coding-run statuses", empty: "No coding runs in this window" },
  health: {
    title: "Runtime health", source: "shaped like Workers Observability per-Worker figures",
    empty: "No Worker reported figures in this window",
  },
};

function table(head: Array<[string, boolean]>, body: Node[], foot?: Node): HTMLTableElement {
  const tr = el("tr", {});
  for (const [label, num] of head) tr.append(el("th", { scope: "col", ...(num ? { class: "num" } : {}) }, label));
  return el("table", {}, el("thead", {}, tr), el("tbody", {}, ...body), foot ? el("tfoot", {}, foot) : null);
}

const cell = (value: string, num = true) => el("td", num ? { class: "num" } : {}, value);

function activityTable(data: ActivityData): HTMLTableElement {
  return table([["Event", false], ["Count", true]], [
    el("tr", {}, cell("People active", false), cell(formatCount(data.activePeople, "person"))),
    ...data.events.map(e => el("tr", {}, cell(e.eventType, false), cell(formatCount(e.count, "event")))),
  ]);
}

function runsTable(data: RunsData): HTMLTableElement {
  const total = runTotal(data);
  return table([["Status", false], ["Runs", true]],
    RUN_STATUSES.map(({ status, meaning }) => el("tr", {},
      el("td", {}, status, el("span", { class: "meaning" }, meaning)),
      cell(formatCount(data.byStatus[status], "run")))),
    el("tr", {}, cell("Total", false), cell(total.runs !== null
      ? formatCount(total.runs, "run")
      : `Unknown (${total.missing} of ${RUN_STATUSES.length} statuses not reported)`)));
}

function healthTable(data: HealthData): HTMLTableElement {
  return table([["Worker", false], ["Requests", true], ["Errors", true], ["Error rate", true], ["p95 wall time", true]],
    data.workers.map(w => el("tr", {}, cell(w.worker, false), cell(formatCount(w.requests, "request")),
      cell(formatCount(w.errors, "error")), cell(errorRate(w.errors, w.requests)), cell(formatMs(w.p95WallTimeMs)))));
}

function renderPanel<T>(kind: PanelKind, panel: Panel<T>, name: string, draw: (data: T) => HTMLTableElement,
                        empty: (data: T) => boolean): HTMLElement {
  const meta = PANELS[kind];
  const source = `Demo fixture (synthetic), ${meta.source}`;
  if (panel.state === "unavailable") {
    return el("section", { "aria-label": meta.title }, el("h2", {}, meta.title),
      el("dl", { class: "facts" }, el("dt", {}, "Source"), el("dd", {}, source)),
      notice(`${meta.title} could not be loaded`, true, panel.message));
  }
  const fresh = freshness(kind, panel.asOf, panel.window.to);
  const scope = kind === "runs"
    ? `Coding runs requested in the window for ${name}, by status as of ${panel.asOf} — no per-person figures`
    : `Installation total for ${name} — no per-person figures`;
  const facts = el("dl", { class: "facts" },
    el("dt", {}, "Source"), el("dd", {}, source),
    el("dt", {}, "Scope"), el("dd", {}, scope),
    el("dt", {}, "Window"), el("dd", {}, `${panel.window.from} to ${panel.window.to} (UTC)`),
    el("dt", {}, "Freshness"), el("dd", fresh.stale ? { class: "stale" } : {}, fresh.text));
  return el("section", { "aria-label": meta.title },
    el("h2", {}, fresh.stale ? `${meta.title} (stale)` : meta.title), facts,
    empty(panel.data) ? notice(meta.empty, false) : draw(panel.data),
    el("p", { class: "note" }, "No threshold, alert or health verdict is set by this view."));
}

function render(): void {
  const { view } = state;
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  if (view.kind === "loading") {
    statusEl.textContent = "Loading…";
    main.append(notice("Loading system metrics…", false));
    return;
  }
  statusEl.textContent = "";
  if (view.kind === "ready") {
    const { result } = view;
    const name = result.installation.installationName;
    main.append(
      renderPanel("activity", result.activity, name, activityTable, data => isEmpty("activity", data)),
      renderPanel("runs", result.runs, name, runsTable, data => isEmpty("runs", data)),
      renderPanel("health", result.health, name, healthTable, data => isEmpty("health", data)));
    return;
  }
  const { result } = view;
  if (result.reason === "unknown-installation") {
    main.append(notice("No such demo installation", true, "Pick one of the demo installations above."));
  } else {
    main.append(notice("System metrics could not be loaded", true, result.message));
  }
}

async function load(installationId: string): Promise<void> {
  state = startLoad(state);
  const generation = state.generation;
  render();
  let result: LoadMetricsResult;
  try {
    result = await gadget.loadMetrics(installationId);
  } catch (error) {
    result = { ok: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
  const next = finishLoad(state, generation, result);
  if (next === state) return;
  state = next;
  render();
}

let installations: DemoInstallation[] = [];
try {
  installations = await gadget.listInstallations();
} catch (error) {
  state = { generation: state.generation, view: { kind: "failed", result: {
    ok: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) } } };
  render();
}
for (const installation of installations) {
  picker.append(el("option", { value: installation.installationId }, installation.installationName));
}
picker.addEventListener("change", () => void load(picker.value));
refreshButton.addEventListener("click", () => void load(picker.value));
if (installations.length > 0) await load(picker.value);

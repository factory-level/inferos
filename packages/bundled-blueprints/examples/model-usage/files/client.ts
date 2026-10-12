// ---------------------------------------------------------------------------
// Model usage (demo data) -- a read-only preview of a model-usage view on SYNTHETIC figures.
//
// Every load asks the Durable Object for ONE demo workspace, which returns only that workspace's
// figures. The view keeps the three kinds of cost apart (estimated, provider-reported, billed),
// shows units, the window and freshness, and draws a missing figure as "Unknown", never as 0.
// There are no controls but the workspace picker and Reload: nothing here sets a budget, changes an
// allowance or exports. Every value is drawn as a text node.
// ---------------------------------------------------------------------------

import type { DemoWorkspace, GadgetStub, LoadUsageResult } from "./lib/protocol.ts";
import {
  COST_KINDS, type CostKind, finishLoad, formatTokens, formatUsd, freshness, initialState, startLoad,
  type State, totals,
} from "./lib/usage.ts";

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
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 12px; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.facts .stale { color: var(--danger); font-weight: 600; }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
th { background: var(--head); font-weight: 600; font-size: 13px; }
tfoot td { font-weight: 600; background: var(--head); }
.note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.notice { margin: auto; max-width: 460px; text-align: center; padding: 32px 16px; }
.notice h2 { font-size: 16px; margin: 0 0 8px; }
.notice p { color: var(--muted); margin: 0 0 12px; }
.notice.error h2 { color: var(--danger); }
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

const picker = el("select", { "aria-label": "Demo workspace" });
const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const refreshButton = el("button", { class: "btn", type: "button" }, "Reload");
const main = el("main", { class: "content", "aria-label": "Model usage" });
document.body.append(el("div", { class: "app" },
  el("div", { class: "demo", role: "note" },
    "DEMO DATA — synthetic figures bundled in this gadget. Not your usage, not a bill, and not read " +
    "from any provider, gateway or InferOS account."),
  el("header", { class: "bar" }, el("h1", {}, "Model usage"), picker, el("span", { class: "spacer" }),
    statusEl, refreshButton),
  main));

let state: State = initialState;

function notice(heading: string, isError: boolean, ...body: Array<Node | string>): HTMLElement {
  return el("div", { class: `notice${isError ? " error" : ""}` }, el("h2", {}, heading), el("p", {}, ...body));
}

/** A cost total cell: the sum, or "Unknown" with how many models lack the figure. */
function totalText(key: CostKind, rows: number, total: { cents: number | null; missing: number }): string {
  if (total.cents !== null) return formatUsd(total.cents);
  if (key === "billedCents" || total.missing === rows) return "Unknown";
  return `Unknown (${total.missing} of ${rows} models not reported)`;
}

function renderUsage(result: Extract<LoadUsageResult, { ok: true }>): HTMLElement {
  const fresh = freshness(result.asOf, result.window.to);
  const facts = el("dl", { class: "facts" },
    el("dt", {}, "Source"), el("dd", {}, "Demo fixture (synthetic)"),
    el("dt", {}, "Scope"), el("dd", {}, `Workspace total for ${result.workspace.workspaceName} — no per-person figures`),
    el("dt", {}, "Window"), el("dd", {}, `${result.window.from} to ${result.window.to} (UTC)`),
    el("dt", {}, "Freshness"), el("dd", fresh.stale ? { class: "stale" } : {}, fresh.text));
  if (result.rows.length === 0) {
    return el("div", {}, facts,
      notice("No model usage in this window", false, "This demo workspace used no models between these dates."));
  }

  const head = el("tr", {});
  for (const [label, cls] of [["Model", ""], ["Provider", ""], ["Input", "num"], ["Output", "num"]] as const) {
    head.append(el("th", { scope: "col", ...(cls ? { class: cls } : {}) }, label));
  }
  for (const kind of COST_KINDS) head.append(el("th", { scope: "col", class: "num" }, `${kind.label} cost`));

  const body = el("tbody", {});
  for (const row of result.rows) {
    const tr = el("tr", {},
      el("td", {}, row.model), el("td", {}, row.provider),
      el("td", { class: "num" }, formatTokens(row.inputTokens)),
      el("td", { class: "num" }, formatTokens(row.outputTokens)));
    for (const kind of COST_KINDS) tr.append(el("td", { class: "num" }, formatUsd(row[kind.key])));
    body.append(tr);
  }

  const sum = totals(result.rows);
  const foot = el("tr", {}, el("td", { colspan: "2" }, "Workspace total"),
    el("td", { class: "num" }, formatTokens(sum.inputTokens)),
    el("td", { class: "num" }, formatTokens(sum.outputTokens)));
  for (const kind of COST_KINDS) {
    foot.append(el("td", { class: "num" }, totalText(kind.key, result.rows.length, sum.cost[kind.key])));
  }

  return el("div", {}, facts,
    el("table", {}, el("thead", {}, head), body, el("tfoot", {}, foot)),
    el("p", { class: "note" },
      COST_KINDS.map(kind => `${kind.label}: ${kind.meaning}.`).join(" ") +
      " A missing figure is Unknown, and a total is Unknown when any model lacks it."),
    el("p", { class: "note" }, "No budget or spending limit is set or enforced by this view."));
}

function render(): void {
  const { view } = state;
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  if (view.kind === "loading") {
    statusEl.textContent = "Loading…";
    main.append(notice("Loading model usage…", false));
    return;
  }
  statusEl.textContent = "";
  if (view.kind === "ready") {
    main.append(renderUsage(view.result));
    return;
  }
  const { result } = view;
  if (result.reason === "unknown-workspace") {
    main.append(notice("No such demo workspace", true, "Pick one of the demo workspaces above."));
  } else {
    main.append(notice("Model usage could not be loaded", true, result.message));
  }
}

async function load(workspaceId: string): Promise<void> {
  state = startLoad(state);
  const generation = state.generation;
  render();
  let result: LoadUsageResult;
  try {
    result = await gadget.loadUsage(workspaceId);
  } catch (error) {
    result = { ok: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
  const next = finishLoad(state, generation, result);
  if (next === state) return;
  state = next;
  render();
}

let workspaces: DemoWorkspace[] = [];
try {
  workspaces = await gadget.listWorkspaces();
} catch (error) {
  state = { generation: state.generation, view: { kind: "failed", result: {
    ok: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) } } };
  render();
}
for (const workspace of workspaces) {
  picker.append(el("option", { value: workspace.workspaceId }, workspace.workspaceName));
}
picker.addEventListener("change", () => void load(picker.value));
refreshButton.addEventListener("click", () => void load(picker.value));
if (workspaces.length > 0) await load(picker.value);

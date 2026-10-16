// ---------------------------------------------------------------------------
// Tech support page (demo data) -- a read-only preview of a tech-support page on SYNTHETIC data.
//
// Every load asks the Durable Object for ONE demo installation, which returns only that
// installation's page: four metric tiles, a read-only support board and a runbook. Each region
// carries its own source and freshness and is reported, refused or failed on its own. Two tiles have
// no data source and never show a number. A missing figure reads "Unknown", never 0. Nothing on the
// page can change an issue or the runbook: the only controls are the picker and Reload, and every
// value is drawn as a text node.
// ---------------------------------------------------------------------------

import type {
  BoardData, DemoInstallation, GadgetStub, LoadSupportPageResult, Region, RunbookData, RunbookMissing, TileData,
} from "./lib/protocol.ts";
import {
  boardIsEmpty, finishLoad, formatCount, freshness, initialState, issueLine, runbookIsEmpty, startLoad, type State,
} from "./lib/page.ts";

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
.demo p { margin: 0; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); background: var(--surface); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .spacer { flex: 1; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; }
button, select { font: inherit; color: inherit; }
.btn, select { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 5px 10px; }
.btn { cursor: pointer; }
.btn:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.content { flex: 1; overflow: auto; overflow-x: hidden; padding: 16px; }
.region { margin: 0 0 24px; }
.region h2 { font-size: 15px; margin: 0 0 8px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; min-width: 0; }
.tile h3 { font-size: 13px; margin: 0 0 6px; }
.figure { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
.line { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.line.stale { color: var(--danger); font-weight: 600; }
.notice { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.notice.error { color: var(--danger); }
.columns { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 8px; }
.column { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; min-width: 0; }
.column h3 { font-size: 13px; margin: 0 0 6px; }
.column ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.issue { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; overflow-wrap: anywhere; }
.issue span { display: block; }
.issue .meta { font-size: 12px; color: var(--muted); }
.runbook h3 { font-size: 14px; margin: 12px 0 4px; }
.runbook p, .runbook ol { margin: 0 0 6px; overflow-wrap: anywhere; }
@media (max-width: 900px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .content { padding: 8px; }
  .tiles, .columns { grid-template-columns: minmax(0, 1fr); }
}
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
const main = el("main", { class: "content", "aria-label": "Tech support" });
document.body.append(el("div", { class: "app" },
  el("div", { class: "demo", role: "note" },
    el("p", { class: "banner" },
      "DEMO DATA — synthetic support figures, board and runbook bundled in this gadget. Not your installation's " +
      "activity, runs, support issues or runbook, and not read from InferOps, InferMind, Analytics Engine or any " +
      "account."),
    el("p", { class: "readonly" }, "Read-only: nothing on this page can change an issue or the runbook.")),
  el("header", { class: "bar" }, el("h1", {}, "Tech support"), picker, el("span", { class: "spacer" }),
    statusEl, refreshButton),
  main));

let state: State = initialState;

const NO_SOURCE = ["No data source connected yet", "Needs the approvals/v1 metric family, which is not built."];
const line = (text: string, cls = "line") => el("p", { class: cls }, text);

function tile<T extends TileData>(
  name: string, region: Region<T>, readAt: string, figure: (count: number | null) => string, caption: string,
  source: string,
): HTMLElement {
  if (region.state === "denied") {
    return el("section", { class: "tile", "aria-label": name }, el("h3", {}, name),
      line("You don't have access to this figure in this installation.", "notice"));
  }
  if (region.state === "unavailable") {
    return el("section", { class: "tile", "aria-label": name }, el("h3", {}, name),
      line(`${name} could not be loaded: ${region.message}`, "notice error"));
  }
  const fresh = freshness("tile", region.asOf, readAt);
  return el("section", { class: "tile", "aria-label": name },
    el("h3", {}, fresh.stale ? `${name} (stale)` : name),
    line(figure(region.data.count), "figure"),
    line(caption),
    line(`Source: Demo fixture (synthetic), ${source}`),
    line(`${region.data.window.from} to ${region.data.window.to} (UTC)`),
    line(fresh.text, fresh.stale ? "line stale" : "line"));
}

function noSourceTile(name: string): HTMLElement {
  return el("section", { class: "tile", "aria-label": name }, el("h3", {}, name), ...NO_SOURCE.map(t => line(t, "notice")));
}

function boardRegion(region: Region<BoardData>, readAt: string): HTMLElement {
  const section = (...children: Array<Node | null>) => el("section", { class: "region", "aria-label": "Support board" },
    ...children);
  if (region.state === "denied") {
    return section(el("h2", {}, "Support board"),
      line("You don't have access to the support board in this installation.", "notice"));
  }
  if (region.state === "unavailable") {
    return section(el("h2", {}, "Support board"),
      line(`The support board could not be loaded: ${region.message}`, "notice error"));
  }
  const fresh = freshness("board", region.asOf, readAt);
  const heading = `Support board — ${region.data.project.name}`;
  const facts = [
    line("Source: Demo fixture (synthetic), shaped like an InferOps project board"),
    line(fresh.text, fresh.stale ? "line stale" : "line"),
  ];
  if (boardIsEmpty(region.data)) {
    return section(el("h2", {}, fresh.stale ? `${heading} (stale)` : heading), ...facts,
      line("No open or resolved issues on this board.", "notice"));
  }
  const columns = el("div", { class: "columns" }, ...region.data.columns.map(column =>
    el("section", { class: "column", "aria-label": `${column.name} column` },
      el("h3", {}, `${column.name} (${column.issues.length})`),
      column.issues.length === 0
        ? line("No issues", "notice")
        : el("ul", {}, ...column.issues.map(issue => {
          const [head, ...rest] = issueLine(issue);
          return el("li", { class: "issue" }, el("span", {}, head!), ...rest.map(r => el("span", { class: "meta" }, r)));
        })))));
  return section(el("h2", {}, fresh.stale ? `${heading} (stale)` : heading), ...facts, columns);
}

function runbookRegion(region: Region<RunbookData, RunbookMissing>): HTMLElement {
  const section = (...children: Array<Node | null>) =>
    el("section", { class: "region runbook", "aria-label": "Support runbook" }, ...children);
  const titled = (text: string, cls = "notice") => section(el("h2", {}, "Support runbook"), line(text, cls));
  if (region.state === "denied") return titled("You don't have access to the runbook in this installation.");
  if (region.state === "unavailable") return titled(`The runbook could not be loaded: ${region.message}`, "notice error");
  if (region.state === "missing") return titled(`There is no page named ${region.slug} in this Wiki.`);
  const page = region.data;
  if (runbookIsEmpty(page)) return titled("The runbook page has nothing to read yet.");
  return section(
    el("h2", {}, page.title),
    line("Source: Demo fixture (synthetic), shaped like an InferMind Wiki page"),
    line(`Version ${page.version}, last edited ${page.editedAt}.`),
    ...page.sections.flatMap(s => [
      el("h3", {}, s.heading),
      ...s.blocks.map(b => b.kind === "paragraph" ? el("p", {}, b.text) : el("ol", {}, ...b.items.map(i => el("li", {}, i)))),
    ]));
}

function notice(text: string, isError: boolean): HTMLElement {
  return line(text, isError ? "notice error" : "notice");
}

function render(): void {
  const { view } = state;
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  if (view.kind === "loading") {
    statusEl.textContent = "Loading…";
    main.append(notice("Loading the tech support page…", false));
    return;
  }
  statusEl.textContent = "";
  if (view.kind === "failed") {
    const { result } = view;
    main.append(result.reason === "unknown-installation"
      ? notice("No such demo installation. Pick one of the demo installations above.", true)
      : notice(`The tech support page could not be loaded: ${result.message}`, true));
    return;
  }
  const page = view.result;
  main.append(
    el("section", { class: "region", "aria-label": "Support metrics" },
      el("div", { class: "tiles" },
        tile("People active today", page.peopleActiveToday, page.readAt, c => formatCount(c, "person"),
          "Installation total — no per-person figures.", "shaped like activity/v1 events"),
        tile("Coding runs failed, last 24 hours", page.runsFailed24h, page.readAt, c => formatCount(c, "run"),
          "Runs whose runner reported failure. Runs with an unknown outcome are not counted.",
          "shaped like InferOps coding-run statuses"),
        noSourceTile("Actions rejected, last 24 hours"),
        noSourceTile("Median time to decision"))),
    boardRegion(page.board, page.readAt),
    runbookRegion(page.runbook));
}

async function load(installationId: string): Promise<void> {
  state = startLoad(state);
  const generation = state.generation;
  render();
  let result: LoadSupportPageResult;
  try {
    result = await gadget.loadSupportPage(installationId);
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

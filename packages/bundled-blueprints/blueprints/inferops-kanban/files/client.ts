// ---------------------------------------------------------------------------
// InferOps Kanban -- one InferOps project board as columns of issue cards.
//
// Cards move by drag and drop or with each card's "Move to" menu (the keyboard path). A move is
// proposed through the Durable Object, which calls the `board` binding; InferOps applies it once
// the user approves it, and until then the binding already shows the issue in its new column.
// ---------------------------------------------------------------------------

import {
  PRIORITY_LABELS, findIssue, moveTargets, sortIssues, withIssueMoved,
} from "./lib/board.ts";
import type { Board, GadgetStub, Issue, State } from "./lib/protocol.ts";

// Defined by the Workshop's iframe bootstrap before this module runs.
declare const gadget: GadgetStub;

type View =
  | { kind: "loading" }
  | { kind: "ready"; board: Board }
  | { kind: "not-connected" }
  | { kind: "error"; message: string };

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --column: #eef0f3; --text: #1b1f24; --muted: #5d6673;
  --border: #d8dce2; --accent: #2f6fde; --accent-soft: #e3ecfc; --danger: #b42318;
  --danger-soft: #fdecea; --warn: #9a5b00; --warn-soft: #fff4e0; --ok-soft: #e7f5ec; --ok: #1e7a3d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2126; --column: #191c20; --text: #e7eaee; --muted: #9aa3ae;
    --border: #30363d; --accent: #7aa7ff; --accent-soft: #1d2a42; --danger: #ff8a80;
    --danger-soft: #3a1d1b; --warn: #f0b45a; --warn-soft: #33270f; --ok-soft: #15301f; --ok: #6fcf8f;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { display: flex; flex-direction: column; height: 100%; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); background: var(--surface); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .key { color: var(--muted); font-weight: 500; margin-left: 6px; }
.bar .spacer { flex: 1; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; }
.status.error { color: var(--danger); }
button, select { font: inherit; color: inherit; }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn:focus-visible, select:focus-visible, .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.board { flex: 1; display: flex; gap: 12px; padding: 16px; overflow-x: auto; align-items: flex-start;
  scroll-snap-type: x proximity; }
.column { flex: 0 0 272px; max-width: 85vw; background: var(--column); border: 1px solid var(--border);
  border-radius: 10px; display: flex; flex-direction: column; max-height: 100%; scroll-snap-align: start; }
.column.drop-ok { border-color: var(--accent); background: var(--accent-soft); }
.column.drop-no { opacity: .55; }
.column-head { display: flex; align-items: baseline; gap: 6px; padding: 10px 12px 6px; }
.column-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
.column-head .count { color: var(--muted); font-size: 12px; }
.column-head .workflow { margin-left: auto; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.cards { list-style: none; margin: 0; padding: 4px 8px 10px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 48px; }
.empty-column { color: var(--muted); font-size: 12px; padding: 6px 4px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; cursor: grab; }
.card.dragging { opacity: .5; }
.card.busy { opacity: .7; }
.card .top { display: flex; align-items: center; gap: 6px; }
.card .id { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.card .title { margin: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.pill { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); white-space: nowrap; }
.pill.urgent { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
.pill.high { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.pill.medium { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.pill.requested { color: var(--ok); background: var(--ok-soft); border-color: transparent; margin-left: auto; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 12px; }
.meta .overdue { color: var(--danger); }
.blocked { font-size: 12px; color: var(--danger); background: var(--danger-soft); border-radius: 6px; padding: 6px 8px; }
.move select { width: 100%; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); }
.notice { margin: auto; max-width: 460px; text-align: center; padding: 32px 16px; }
.notice h2 { font-size: 16px; margin: 0 0 8px; }
.notice p { color: var(--muted); margin: 0 0 12px; }
.notice code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--column); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 600px) {
  .board { padding: 12px; gap: 10px; }
  .column { flex-basis: 85vw; }
}
@media print {
  html, body, .app { height: auto; background: #fff; color: #000; }
  .bar .btn, .move, .status { display: none; }
  .board { flex-wrap: wrap; overflow: visible; }
  .column { flex: 1 1 220px; max-height: none; break-inside: avoid; border-color: #bbb; background: #fff; }
  .cards { overflow: visible; }
  .card { break-inside: avoid; border-color: #bbb; }
}
`;

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

const titleEl = el("h1", {}, "InferOps board");
const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const refreshButton = el("button", { class: "btn", type: "button" }, "Refresh");
const main = el("main", { class: "board", "aria-label": "Board columns" });
const app = el("div", { class: "app" },
  el("header", { class: "bar" }, titleEl, el("span", { class: "spacer" }), statusEl, refreshButton),
  main);
document.body.append(app);

let view: View = { kind: "loading" };
/** Issues this board proposed moves for since it last refreshed. */
const requested = new Set<string>();
/** Issues with a move in flight. */
const busy = new Set<string>();
let focusAfterRender: string | null = null;
let dragging: Issue | null = null;

function announce(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf())
    ? date
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function isOverdue(issue: Issue, state: State): boolean {
  if (!issue.targetDate || state.group === "completed" || state.group === "cancelled") return false;
  return issue.targetDate < new Date().toISOString().slice(0, 10);
}

function renderCard(board: Board, issue: Issue, state: State): HTMLLIElement {
  const targets = moveTargets(board, issue);
  const isBusy = busy.has(issue.id);
  const titleId = `title-${issue.id}`;
  const card = el("li", {
    class: `card${isBusy ? " busy" : ""}`,
    tabindex: "-1",
    draggable: isBusy ? "false" : "true",
    "data-issue-id": issue.id,
    "aria-labelledby": titleId,
    "aria-busy": isBusy ? "true" : undefined,
  });

  const top = el("div", { class: "top" },
    el("span", { class: "id" }, issue.identifier),
    issue.priority === "none" ? null
      : el("span", { class: `pill ${issue.priority}` }, PRIORITY_LABELS[issue.priority]),
    requested.has(issue.id)
      ? el("span", {
        class: "pill requested",
        title: "Proposed from this board. It is applied in InferOps once approved.",
      }, isBusy ? "Moving…" : "Move requested")
      : null);
  card.append(top, el("p", { class: "title", id: titleId }, issue.title));

  const meta = el("div", { class: "meta" },
    el("span", { title: issue.assigneeId ?? undefined },
      issue.assigneeId ? `Assignee ${issue.assigneeId.slice(0, 8)}` : "Unassigned"));
  if (issue.targetDate) {
    meta.append(el("span", { class: isOverdue(issue, state) ? "overdue" : "" },
      `${isOverdue(issue, state) ? "Overdue" : "Due"} ${formatDate(issue.targetDate)}`));
  }
  card.append(meta);
  if (issue.blockedReason) {
    card.append(el("div", { class: "blocked" }, `Blocked: ${issue.blockedReason}`));
  }

  if (targets.length > 0) {
    const selectId = `move-${issue.id}`;
    const select = el("select", { id: selectId });
    select.disabled = isBusy;
    select.append(el("option", { value: "" }, "Move to…"));
    for (const target of targets) select.append(el("option", { value: target.id }, target.name));
    select.addEventListener("change", () => {
      if (select.value) void moveIssue(issue.id, select.value);
    });
    card.append(el("div", { class: "move" },
      el("label", { class: "sr-only", for: selectId }, `Move ${issue.identifier} to`), select));
  }

  card.addEventListener("dragstart", event => {
    dragging = issue;
    card.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", issue.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    markDropTargets(board, issue);
  });
  card.addEventListener("dragend", () => {
    dragging = null;
    card.classList.remove("dragging");
    markDropTargets(board, null);
  });
  return card;
}

function markDropTargets(board: Board, issue: Issue | null): void {
  const allowed = new Set(issue ? moveTargets(board, issue).map(s => s.id) : []);
  for (const column of main.querySelectorAll<HTMLElement>(".column")) {
    const stateId = column.dataset.stateId ?? "";
    column.classList.toggle("drop-ok", issue !== null && allowed.has(stateId));
    column.classList.toggle("drop-no",
      issue !== null && !allowed.has(stateId) && stateId !== issue.stateId);
  }
}

function renderColumn(board: Board, state: State, issues: Issue[], showWorkflow: boolean): HTMLElement {
  const headingId = `column-${state.id}`;
  const list = el("ul", { class: "cards", "aria-labelledby": headingId });
  for (const issue of sortIssues(issues)) list.append(renderCard(board, issue, state));
  if (issues.length === 0) list.append(el("li", { class: "empty-column" }, "No issues"));

  const column = el("section", { class: "column", "data-state-id": state.id },
    el("div", { class: "column-head" },
      el("h2", { id: headingId }, state.name),
      el("span", { class: "count", "aria-label": `${issues.length} issues` }, String(issues.length)),
      showWorkflow ? el("span", { class: "workflow" }, state.workflow) : null),
    list);

  column.addEventListener("dragover", event => {
    if (!dragging || !moveTargets(board, dragging).some(s => s.id === state.id)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  column.addEventListener("drop", event => {
    event.preventDefault();
    const issueId = event.dataTransfer?.getData("text/plain") || dragging?.id;
    markDropTargets(board, null);
    if (issueId) void moveIssue(issueId, state.id);
  });
  return column;
}

function notice(heading: string, ...body: Array<Node | string>): HTMLElement {
  return el("div", { class: "notice" }, el("h2", {}, heading), el("p", {}, ...body));
}

function render(): void {
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  switch (view.kind) {
    case "loading":
      main.append(notice("Loading board…"));
      return;
    case "not-connected":
      titleEl.textContent = "InferOps board";
      main.append(notice("No InferOps board connected",
        "Ask the agent to connect an InferOps project board to this gadget as ",
        el("code", {}, "board"), ", for example ",
        el("code", {}, "inferops://demo.local/project/board/DEMO"), "."));
      return;
    case "error": {
      const retry = el("button", { class: "btn", type: "button" }, "Try again");
      retry.addEventListener("click", () => void reload());
      main.append(notice("The board could not be loaded", view.message), retry);
      return;
    }
    case "ready": {
      const { board } = view;
      titleEl.replaceChildren(board.project.name,
        el("span", { class: "key" }, board.project.identifier));
      if (board.columns.length === 0) {
        main.append(notice("No workflow states", "This project has no states to show yet."));
        return;
      }
      const showWorkflow = new Set(board.columns.map(c => c.state.workflow)).size > 1;
      for (const { state, issues } of board.columns) {
        main.append(renderColumn(board, state, issues, showWorkflow));
      }
      if (focusAfterRender) {
        main.querySelector<HTMLElement>(`[data-issue-id="${focusAfterRender}"]`)?.focus();
        focusAfterRender = null;
      }
    }
  }
}

async function reload(): Promise<void> {
  if (view.kind !== "ready") {
    view = { kind: "loading" };
    render();
  }
  try {
    const result = await gadget.loadBoard();
    view = result.ok ? { kind: "ready", board: result.board }
      : result.reason === "not-connected" ? { kind: "not-connected" }
      : { kind: "error", message: result.message };
  } catch (error) {
    view = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  render();
}

async function moveIssue(issueId: string, toStateId: string): Promise<void> {
  if (view.kind !== "ready" || busy.has(issueId)) return;
  const board = view.board;
  const found = findIssue(board, issueId);
  const target = board.columns.find(c => c.state.id === toStateId)?.state;
  if (!found || !target || found.issue.stateId === toStateId) return;
  const { identifier, revision } = found.issue;

  busy.add(issueId);
  requested.add(issueId);
  focusAfterRender = issueId;
  view = { kind: "ready", board: withIssueMoved(board, issueId, toStateId) };
  announce(`Moving ${identifier} to ${target.name}…`);
  render();

  let result;
  try {
    result = await gadget.moveIssue(issueId, toStateId, revision);
  } catch (error) {
    result = { ok: false as const, code: "ERROR" as const,
      message: error instanceof Error ? error.message : String(error) };
  }
  busy.delete(issueId);
  focusAfterRender = issueId;

  if (result.ok) {
    announce(`${identifier} → ${target.name} requested. It is applied in InferOps once approved.`);
  } else {
    requested.delete(issueId);
    announce(result.code === "STALE_REVISION"
      ? `${identifier} changed in InferOps since the board loaded. The board was reloaded; ` +
        `try the move again.`
      : `${identifier} was not moved: ${result.message}`, true);
  }
  // Reload either way: on success to pick up the new revision, on failure to undo the local move.
  await reload();
}

refreshButton.addEventListener("click", () => {
  requested.clear();
  announce("");
  void reload();
});

render();
await reload();

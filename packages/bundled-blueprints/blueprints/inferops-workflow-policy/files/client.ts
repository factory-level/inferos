// ---------------------------------------------------------------------------
// InferOps Workflow policy -- one project's published content-workflow policy, read-only.
//
// Every load asks the Durable Object, which reads the `policy` binding once. The policy is drawn as
// published: its lanes in order, then its rules, fragments, lane bindings and transitions, each
// subject and action exactly as written. Only named fields are drawn, every value as a text node, and
// only the answer to the latest load is ever shown. Nothing here works out who may do what, and
// there are no controls but Reload: nothing edits, publishes, validates or exports the policy.
// ---------------------------------------------------------------------------

import {
  finishLoad, guardText, initialState, laneName, ruleText, startLoad, subjectsText, transitionSubjectsText,
  type State,
} from "./lib/policy.ts";
import type {
  GadgetStub, LoadPolicyResult, WorkflowPolicyHead, WorkflowPolicyRule, WorkflowPolicyV2,
} from "./lib/protocol.ts";

// Defined by the Workshop's iframe bootstrap before this module runs.
declare const gadget: GadgetStub;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --head: #eef0f3; --text: #1b1f24; --muted: #5d6673;
  --border: #d8dce2; --accent: #2f6fde; --danger: #b42318; --deny: #8a1c12;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2126; --head: #191c20; --text: #e7eaee; --muted: #9aa3ae;
    --border: #30363d; --accent: #7aa7ff; --danger: #ff8a80; --deny: #ffb4a8;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { display: flex; flex-direction: column; height: 100%; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); background: var(--surface); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.bar .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.bar .spacer { flex: 1; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; }
button { font: inherit; color: inherit; }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.content { flex: 1; overflow: auto; padding: 16px; }
section { margin: 0 0 20px; }
section h2 { font-size: 14px; margin: 0 0 6px; }
dl.head { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 20px; }
dl.head dt { color: var(--muted); }
dl.head dd { margin: 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--head); font-weight: 600; font-size: 13px; }
td.id, .mono { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
td.deny { color: var(--deny); }
.empty { color: var(--muted); font-size: 13px; margin: 0; }
.note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.notice { margin: auto; max-width: 460px; text-align: center; padding: 32px 16px; }
.notice h2 { font-size: 16px; margin: 0 0 8px; }
.notice p { color: var(--muted); margin: 0 0 12px; }
.notice.error h2 { color: var(--danger); }
.notice code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--head); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .content { padding: 8px; }
  th, td { padding: 5px 6px; }
}
@media print {
  html, body, .app { height: auto; background: #fff; color: #000; }
  .bar .btn, .status { display: none; }
  .content { overflow: visible; }
  tr { break-inside: avoid; }
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

const titleEl = el("h1", {}, "InferOps workflow policy");
const metaEl = el("span", { class: "meta" });
const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const refreshButton = el("button", { class: "btn", type: "button" }, "Reload");
const main = el("main", { class: "content", "aria-label": "Workflow policy" });
document.body.append(el("div", { class: "app" },
  el("header", { class: "bar" }, titleEl, metaEl, el("span", { class: "spacer" }), statusEl, refreshButton),
  main));

let state: State = initialState;

function notice(heading: string, isError: boolean, ...body: Array<Node | string>): HTMLElement {
  return el("div", { class: `notice${isError ? " error" : ""}` }, el("h2", {}, heading), el("p", {}, ...body));
}

function retryButton(): HTMLButtonElement {
  const retry = el("button", { class: "btn", type: "button" }, "Try again");
  retry.addEventListener("click", () => void reload());
  return retry;
}

/** A table with `columns` and one row of cells per entry; strings are text, never markup. */
function table(label: string, columns: string[], rows: Array<Array<{ text: string; class?: string }>>): HTMLElement {
  const head = el("tr", {});
  for (const column of columns) head.append(el("th", { scope: "col" }, column));
  const body = el("tbody", {});
  for (const row of rows) {
    body.append(el("tr", {}, ...row.map(cell => el("td", cell.class ? { class: cell.class } : {}, cell.text))));
  }
  return el("table", { "aria-label": label }, el("thead", {}, head), body);
}

/** One section: its heading, then its table, or a line saying the policy has none. */
function section(heading: string, content: HTMLElement | null, none: string): HTMLElement {
  return el("section", {}, el("h2", {}, heading), content ?? el("p", { class: "empty" }, none));
}

const RULE_COLUMNS = ["Rule", "Effect and actions", "Subjects"];
function ruleRows(rules: readonly WorkflowPolicyRule[]) {
  return rules.map(rule => [
    { text: rule.id, class: "id" },
    { text: ruleText(rule), class: rule.effect === "deny" ? "deny" : undefined },
    { text: subjectsText(rule.subjects) },
  ]);
}
function rulesTable(label: string, rules: readonly WorkflowPolicyRule[] | undefined): HTMLElement | null {
  return rules && rules.length > 0 ? table(label, RULE_COLUMNS, ruleRows(rules)) : null;
}

function renderHead(head: WorkflowPolicyHead): HTMLElement {
  const rows: Array<[string, string, string?]> = [
    ["Project", head.projectId, "mono"],
    ["Workflow", head.workflow],
    ["Revision", head.revision],
    ["Published", head.configured ? "Yes" : "No"],
  ];
  if (head.publishedAt !== undefined) rows.push(["Published at", head.publishedAt]);
  if (head.legacyUpgraded) rows.push(["Stored as", "A version 1 document, upgraded on read"]);
  rows.push(["Source compiled hash", head.compiledHash ?? "None", "mono"]);
  const list = el("dl", { class: "head" });
  for (const [term, value, cls] of rows) list.append(el("dt", {}, term), el("dd", cls ? { class: cls } : {}, value));
  return list;
}

function renderPolicy(policy: WorkflowPolicyV2): HTMLElement[] {
  const lanes = policy.lanes;
  const sections: HTMLElement[] = [];
  sections.push(section("Lanes", table("Lanes", ["#", "Lane", "Group", "Lane id"], lanes.map((lane, index) => [
    { text: String(index + 1) },
    { text: lane.id === policy.entryLaneId ? `${lane.name} (entry)` : lane.name },
    { text: lane.group },
    { text: lane.id, class: "id" },
  ])), "No lanes."));
  sections.push(section("Rules", rulesTable("Rules", policy.rules), "No top-level rules."));
  const fragments = policy.fragments ?? [];
  sections.push(section("Fragments", fragments.length === 0 ? null : el("div", {}, ...fragments.map(fragment =>
    el("div", {},
      el("p", { class: "note" }, `Fragment ${fragment.id}, version ${fragment.version}` +
        (fragment.use && fragment.use.length > 0 ? `, uses ${fragment.use.join(", ")}` : "")),
      rulesTable(`Rules of fragment ${fragment.id}`, fragment.rules) ??
        el("p", { class: "empty" }, "No rules."),
    ))), "No fragments."));
  const bindings = policy.laneBindings ?? [];
  sections.push(section("Lane bindings", bindings.length === 0 ? null : el("div", {}, ...bindings.map(binding =>
    el("div", {},
      el("p", { class: "note" }, `${laneName(lanes, binding.laneId)}` +
        (binding.use && binding.use.length > 0 ? `, uses ${binding.use.join(", ")}` : "") +
        (binding.guards && binding.guards.length > 0 ? `; guards: ${binding.guards.map(guardText).join("; ")}` : "")),
      rulesTable(`Rules bound to ${laneName(lanes, binding.laneId)}`, binding.rules) ??
        el("p", { class: "empty" }, "No rules."),
    ))), "No lane bindings."));
  const transitions = policy.transitions ?? [];
  sections.push(section("Transitions", transitions.length === 0 ? null : el("div", {},
    table("Transitions", ["Transition", "From", "To", "Who may take it", "Guards"], transitions.map(transition => [
      { text: transition.id, class: "id" },
      { text: laneName(lanes, transition.from) },
      { text: laneName(lanes, transition.to) },
      { text: transitionSubjectsText(transition.subjects) },
      { text: transition.guards && transition.guards.length > 0 ? transition.guards.map(guardText).join("; ") : "None" },
    ])),
    ...transitions.filter(transition => transition.rules && transition.rules.length > 0).map(transition =>
      el("div", {},
        el("p", { class: "note" }, `Rules on transition ${transition.id}`),
        rulesTable(`Rules on transition ${transition.id}`, transition.rules)!,
      )),
  ), "No transitions."));
  return sections;
}

function renderReady(head: WorkflowPolicyHead): HTMLElement {
  const parts: HTMLElement[] = [renderHead(head)];
  if (!head.configured || head.policy === null) {
    parts.push(notice("No workflow policy is published", false,
      "InferOps reports no published content-workflow policy for this project (revision 0)."));
  } else {
    parts.push(...renderPolicy(head.policy));
  }
  parts.push(el("p", { class: "note" },
    "Read-only, as InferOps published it. Rule reasons, agent notes and the publisher are not included. " +
    "This view does not work out who may do what. The source compiled hash is InferOps' hash of its " +
    "compiled policy, not of this view. Principal ids are personal information."));
  return el("div", {}, ...parts);
}

function render(): void {
  const { view } = state;
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  if (view.kind === "loading") {
    statusEl.textContent = "Loading…";
    main.append(notice("Loading the workflow policy…", false));
    return;
  }
  statusEl.textContent = "";
  if (view.kind === "ready") {
    const { head } = view.result;
    titleEl.textContent = "Workflow policy";
    metaEl.textContent = `Revision ${head.revision} of project ${head.projectId}`;
    main.append(renderReady(head));
    return;
  }
  titleEl.textContent = "InferOps workflow policy";
  metaEl.textContent = "";
  switch (view.reason) {
    case "not-connected":
      main.append(notice("No InferOps workflow policy connected", false,
        "Ask the agent to connect an InferOps project's workflow policy to this gadget as ", el("code", {}, "policy"),
        ", for example ", el("code", {}, "inferops://demo.local/project/workflow/DEMO"), "."));
      return;
    case "disabled":
      main.append(notice("InferOps workflow policies are turned off", false,
        "This deployment has workflow policies turned off. Nothing is shown until they are on again."), retryButton());
      return;
    case "unavailable":
      main.append(notice("This workflow policy is not available to you", true, view.message), retryButton());
      return;
    case "error":
      main.append(notice("The workflow policy could not be loaded", true, view.message), retryButton());
  }
}

async function reload(): Promise<void> {
  state = startLoad(state);
  const generation = state.generation;
  render();
  let result: LoadPolicyResult;
  try {
    result = await gadget.loadPolicy();
  } catch (error) {
    result = { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const next = finishLoad(state, generation, result);
  if (next === state) return;
  state = next;
  render();
}

refreshButton.addEventListener("click", () => void reload());

await reload();

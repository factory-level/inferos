// ---------------------------------------------------------------------------
// InferOps Members -- who holds access to one InferOps workspace, read-only.
//
// Every load asks the Durable Object, which reads the `members` binding once. Members are drawn
// with the workspace returned with them, every name and value as a text node, and only the answer
// to the latest load is ever shown. There are no controls but Reload: nothing here invites, removes,
// changes a role or a deny, or exports.
// ---------------------------------------------------------------------------

import {
  deniedText, finishLoad, initialState, kindLabel, productLabel, startLoad, type State,
} from "./lib/members.ts";
import type { GadgetStub, LoadMembersResult } from "./lib/protocol.ts";

// Defined by the Workshop's iframe bootstrap before this module runs.
declare const gadget: GadgetStub;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --head: #eef0f3; --text: #1b1f24; --muted: #5d6673;
  --border: #d8dce2; --accent: #2f6fde; --danger: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2126; --head: #191c20; --text: #e7eaee; --muted: #9aa3ae;
    --border: #30363d; --accent: #7aa7ff; --danger: #ff8a80;
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
table { border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--head); font-weight: 600; font-size: 13px; position: sticky; top: 0; }
td.id { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.notice { margin: auto; max-width: 460px; text-align: center; padding: 32px 16px; }
.notice h2 { font-size: 16px; margin: 0 0 8px; }
.notice p { color: var(--muted); margin: 0 0 12px; }
.notice.error h2 { color: var(--danger); }
.notice code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--head); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 600px) {
  .content { padding: 8px; }
  th, td { padding: 5px 6px; }
}
@media print {
  html, body, .app { height: auto; background: #fff; color: #000; }
  .bar .btn, .status { display: none; }
  .content { overflow: visible; }
  th { position: static; }
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

const titleEl = el("h1", {}, "InferOps members");
const metaEl = el("span", { class: "meta" });
const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const refreshButton = el("button", { class: "btn", type: "button" }, "Reload");
const main = el("main", { class: "content", "aria-label": "Members" });
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

function renderMembers(result: Extract<LoadMembersResult, { ok: true }>): HTMLElement {
  const head = el("tr", {});
  for (const label of ["Name", "Kind", "Role", "Denied permissions", "Principal id"]) {
    head.append(el("th", { scope: "col" }, label));
  }
  const body = el("tbody", {});
  for (const member of result.members) {
    body.append(el("tr", {},
      el("td", {}, member.name),
      el("td", {}, kindLabel(member)),
      el("td", {}, member.role),
      el("td", {}, deniedText(member)),
      el("td", { class: "id" }, member.principalId)));
  }
  const count = result.members.length;
  return el("div", {},
    el("table", {}, el("caption", { class: "sr-only" }, `Members of ${result.workspace.workspaceName}`),
      el("thead", {}, head), body),
    el("p", { class: "note" },
      `${count === 1 ? "1 member" : `${count} members`}, as InferOps lists them. Read-only. ` +
      "Email addresses are not shown; names and ids are still personal information."));
}

function render(): void {
  const { view } = state;
  main.replaceChildren();
  refreshButton.disabled = view.kind === "loading";
  if (view.kind === "loading") {
    statusEl.textContent = "Loading…";
    main.append(notice("Loading members…", false));
    return;
  }
  statusEl.textContent = "";
  if (view.kind === "ready") {
    const { workspace } = view.result;
    titleEl.textContent = workspace.workspaceName;
    metaEl.textContent = `${productLabel(workspace.product)} workspace ${workspace.workspaceId}`;
    main.append(view.result.members.length === 0
      ? notice("No members", false, "InferOps lists no members of this workspace that you can see.")
      : renderMembers(view.result));
    return;
  }
  titleEl.textContent = "InferOps members";
  metaEl.textContent = "";
  switch (view.reason) {
    case "not-connected":
      main.append(notice("No InferOps member list connected", false,
        "Ask the agent to connect an InferOps workspace's members to this gadget as ", el("code", {}, "members"),
        ", for example ", el("code", {}, "inferops://demo.local/portal/members"), "."));
      return;
    case "disabled":
      main.append(notice("InferOps workspace members are turned off", false,
        "This deployment has workspace members turned off. Nothing is shown until they are on again."), retryButton());
      return;
    case "unavailable":
      main.append(notice("This member list is not available to you", true, view.message), retryButton());
      return;
    case "error":
      main.append(notice("The members could not be loaded", true, view.message), retryButton());
  }
}

async function reload(): Promise<void> {
  state = startLoad(state);
  const generation = state.generation;
  render();
  let result: LoadMembersResult;
  try {
    result = await gadget.loadMembers();
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

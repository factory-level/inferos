// ---------------------------------------------------------------------------
// InferOps Dot -- talk to your own Dot in one InferOps workspace.
//
// Every question goes to the Durable Object, which asks the `dot` binding and relays the answer as
// it comes. The conversation shown is always the one InferOps holds, read back after each turn.
// Each change the Dot proposes is listed with where it stands, and decided where every other write
// is, under Needs your approval: nothing here approves or declines.
// ---------------------------------------------------------------------------

import { DECIDE_WHERE, RUN_TOOLS, decisionWords, failureWords, proposalHeading, proposalWords, stepWords, workflowRunWords } from "./lib/dot.ts";
import type {
  AskResult, Failure, GadgetStub, OpenResult, ShownConversation, ShownProgress, ShownProposal,
} from "./lib/protocol.ts";

// Defined by the Workshop's iframe bootstrap before this module runs: the stub of this gadget's
// Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: new () => object;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --head: #eef0f3; --text: #1b1f24; --muted: #5d6673;
  --border: #d8dce2; --accent: #2f6fde; --danger: #b42318; --warn: #8a5a00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2126; --head: #191c20; --text: #e7eaee; --muted: #9aa3ae;
    --border: #30363d; --accent: #7aa7ff; --danger: #ff8a80; --warn: #f2c46d;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { display: flex; flex-direction: column; height: 100%; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); background: var(--surface); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .spacer { flex: 1; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; }
button, textarea { font: inherit; color: inherit; }
.btn { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.content { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
ol.messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.message { max-width: 80ch; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user { align-self: flex-end; background: var(--head); }
.message .who { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.message .note { display: block; font-size: 12px; color: var(--muted); margin-top: 4px; }
.steps { color: var(--muted); font-size: 12px; margin: 0; }
section.proposals h2 { font-size: 14px; margin: 0 0 6px; }
section.proposals ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
section.proposals li { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
section.proposals .tool, section.proposals .target { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
section.proposals .target { display: block; color: var(--muted); margin-top: 2px; }
section.proposals .label { font-weight: 600; margin-right: 6px; }
section.proposals .label.uncertain { color: var(--warn); }
section.proposals .detail { color: var(--muted); }
section.proposals .note { color: var(--muted); font-style: italic; }
.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface); }
.composer textarea { flex: 1; min-height: 2.6em; max-height: 10em; resize: vertical; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.notice { margin: 0 auto; max-width: 520px; text-align: center; padding: 16px; }
.notice h2 { font-size: 15px; margin: 0 0 6px; }
.notice p { color: var(--muted); margin: 0 0 10px; overflow-wrap: anywhere; }
.notice.error h2 { color: var(--danger); }
.empty { color: var(--muted); text-align: center; margin: auto; max-width: 420px; }
@media (max-width: 600px) {
  .content { padding: 8px; }
  .composer { padding: 8px; }
}
@media print {
  html, body, .app { height: auto; background: #fff; color: #000; }
  .bar .btn, .status, .composer, .notice button, .steps { display: none; }
  .content { overflow: visible; }
  .message, section.proposals li { break-inside: avoid; }
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

const statusEl = el("div", { class: "status", role: "status", "aria-live": "polite" });
const startOverButton = el("button", { class: "btn", type: "button" }, "Start over");
const main = el("main", { class: "content", "aria-label": "Conversation" });
const prompt = el("textarea", { "aria-label": "Ask your Dot", placeholder: "Ask your Dot…", rows: "2" });
const askButton = el("button", { class: "btn", type: "submit" }, "Ask");
const stopButton = el("button", { class: "btn", type: "button", hidden: "" }, "Stop");
const composer = el("form", { class: "composer" }, prompt, askButton, stopButton);
document.body.append(el("div", { class: "app" },
  el("header", { class: "bar" }, el("h1", {}, "Your Dot"), el("span", { class: "spacer" }), statusEl, startOverButton),
  main, composer));

/** The generation of the request whose answer is shown; an older answer is never drawn. */
let generation = 0;
let asking = false;

function notice(failure: Failure, retry: () => void): HTMLElement {
  const { heading, body } = failureWords(failure);
  const again = el("button", { class: "btn", type: "button" }, "Try again");
  again.addEventListener("click", retry);
  return el("div", { class: `notice${failure.reason === "error" || failure.reason === "unavailable" ? " error" : ""}`, role: "alert" },
    el("h2", {}, heading), el("p", {}, body), failure.reason === "not-connected" ? null : again);
}

/**
 * A knowledge write's target (FAC-136), as text: the page's link for an edit (the proposal carries
 * no current title), the workspace's for a create. A link names the target and grants nothing.
 */
function renderTarget(proposal: ShownProposal): HTMLElement | null {
  const knowledge = proposal.knowledge;
  if (!knowledge) return null;
  if (knowledge.kind === "edit") {
    return el("span", { class: "target" }, `Page: ${knowledge.page}`,
      knowledge.newTitle ? ` · renamed to ${knowledge.newTitle}` : "");
  }
  return el("span", { class: "target" }, `In: ${knowledge.workspace}`);
}

function renderProposals(conversation: ShownConversation): HTMLElement | null {
  if (conversation.proposals.length === 0) return null;
  const list = el("ul", {});
  for (const proposal of conversation.proposals) {
    const base: { label: string; detail?: string; note?: string } = RUN_TOOLS.has(proposal.tool)
      ? workflowRunWords(proposal.status, proposal.run)
      : proposalWords(proposal.status, proposal.knowledge);
    // A background decision's state (FAC-135): waiting for a reconnect, or what the run did after.
    const decision = decisionWords(proposal);
    const words = { ...base, ...(decision.label ? { label: decision.label, detail: decision.detail } : {}) };
    list.append(el("li", {},
      el("span", { class: `label${proposal.status.outcome === "unknown" ? " uncertain" : ""}` }, words.label),
      // A run's outcome is what InferOS reported, not something InferOps could check (FAC-134).
      words.note ? el("span", { class: "note" }, words.note) : null,
      el("span", { class: proposal.knowledge ? "heading" : "tool" }, proposalHeading(proposal)),
      renderTarget(proposal),
      words.detail ? el("div", { class: "detail" }, words.detail) : null,
      decision.resume ? el("div", { class: "resume" }, decision.resume) : null));
  }
  return el("section", { class: "proposals", "aria-label": "Changes your Dot proposed" },
    el("h2", {}, "Changes your Dot proposed"), list);
}

const MESSAGE_NOTE: Record<string, string | null> = {
  complete: null, running: "Still answering…", error: "The Dot couldn't finish this answer.",
  interrupted: "Cut off: this is what it said up to then.",
};

function renderConversation(conversation: ShownConversation | null): void {
  main.replaceChildren();
  if (!conversation || conversation.messages.length === 0) {
    main.append(el("p", { class: "empty" },
      "Ask your Dot about your work in this workspace, or about your company's knowledge: reading it changes nothing. ",
      "Any change it proposes waits for your decision. ", DECIDE_WHERE));
    return;
  }
  const list = el("ol", { class: "messages" });
  for (const message of conversation.messages) {
    const note = MESSAGE_NOTE[message.status] ?? null;
    list.append(el("li", { class: `message ${message.role}` },
      el("span", { class: "who" }, message.role === "user" ? "You" : "Dot"),
      message.content,
      note ? el("span", { class: "note" }, note) : null));
  }
  main.append(list);
  const proposals = renderProposals(conversation);
  if (proposals) main.append(proposals);
}

function setAsking(on: boolean): void {
  asking = on;
  askButton.disabled = on;
  prompt.disabled = on;
  startOverButton.disabled = on;
  stopButton.hidden = !on;
}

async function load(): Promise<void> {
  const mine = ++generation;
  statusEl.textContent = "Loading…";
  let result: OpenResult;
  try {
    result = await gadget.open();
  } catch (error) {
    result = { ok: false, reason: "error", message: error instanceof Error ? error.message : "The conversation couldn't be read." };
  }
  if (mine !== generation) return;
  statusEl.textContent = "";
  if (result.ok) renderConversation(result.conversation);
  else main.replaceChildren(notice(result, () => void load()));
}

const TURN_STATUS: Record<string, string> = {
  complete: "", error: "The Dot couldn't finish. Ask again.",
  interrupted: "The answer was cut off. What it said up to then is kept.",
};

async function ask(text: string): Promise<void> {
  const mine = ++generation;
  setAsking(true);
  statusEl.textContent = "Your Dot is answering…";
  // The question and the answer as it comes, drawn at once; the turn's end redraws from InferOps.
  const live = el("li", { class: "message assistant" }, el("span", { class: "who" }, "Dot"));
  const steps = el("p", { class: "steps" });
  const list = main.querySelector("ol.messages") ?? el("ol", { class: "messages" });
  if (!list.isConnected) main.replaceChildren(list);
  const question = el("li", { class: "message user" }, el("span", { class: "who" }, "You"), text);
  list.append(question, live);
  main.append(steps);
  const target = new (class extends RpcTarget {
    progress(event: ShownProgress): void {
      if (mine !== generation) return;
      if (event.type === "text") live.append(event.delta);
      else if (event.type === "tool") steps.textContent = event.status === "started" ? stepWords(event.name) : "";
      else if (event.type === "proposal") {
        steps.textContent = event.proposal.knowledge
          ? `Proposed ${proposalHeading(event.proposal).replace(/^A /, "a ")}. ${DECIDE_WHERE}`
          : `Proposed a change (${event.proposal.tool}). ${DECIDE_WHERE}`;
      } else steps.textContent = event.message;
    }
  })();
  let result: AskResult;
  try {
    result = await gadget.ask(text, target as unknown as Parameters<GadgetStub["ask"]>[1]);
  } catch (error) {
    result = { ok: false, reason: "error", message: error instanceof Error ? error.message : "The question couldn't be asked." };
  }
  if (mine !== generation) return;
  setAsking(false);
  if (result.ok) {
    renderConversation(result.conversation);
    statusEl.textContent = TURN_STATUS[result.status] ?? "";
  } else {
    statusEl.textContent = "";
    // Refused before anything was asked: nothing of this turn is shown, and the text is kept.
    steps.remove();
    live.remove();
    question.remove();
    main.append(notice(result, () => void load()));
    prompt.value = text;
  }
  prompt.focus();
}

composer.addEventListener("submit", event => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || asking) return;
  prompt.value = "";
  void ask(text);
});

prompt.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stopButton.addEventListener("click", () => {
  statusEl.textContent = "Stopping…";
  void gadget.cancel().then(result => {
    if (!result.ok) statusEl.textContent = failureWords(result).heading;
  });
});

startOverButton.addEventListener("click", () => {
  void gadget.startOver().then(() => {
    renderConversation(null);
    statusEl.textContent = "A new conversation starts with your next question. The last one is still in InferOps.";
    prompt.focus();
  });
});

void load();

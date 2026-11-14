// The Dot client in jsdom, against a fake `gadget` whose answers the test releases: the empty
// conversation, the answer filling in as it comes, each change's status words, a refusal that
// keeps the person's text, and that names and values are text, never markup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskResult, OpenResult, ProgressTarget, ShownConversation } from "../files/lib/protocol.ts";

const MARKUP = `<img src="x" onerror="globalThis.pwned = true">`;

const conversation = (overrides: Partial<ShownConversation> = {}): ShownConversation => ({
  title: "New conversation",
  messages: [
    { id: "u1", role: "user", content: "What changed today?", status: "complete" },
    { id: "a1", role: "assistant", content: "ENG-7 moved to Done.", status: "complete" },
  ],
  running: false,
  proposals: [],
  ...overrides,
});

type Asked = { prompt: string; progress: ProgressTarget; resolve: (result: AskResult) => void };

/** Loads the client with `opened` as its first read; each `ask` waits until the test answers it. */
async function start(opened: OpenResult) {
  const asked: Asked[] = [];
  const cancelled: number[] = [];
  // Any constructible base stands in for Cap'n Web's RpcTarget: the client only subclasses it.
  (globalThis as { RpcTarget?: unknown }).RpcTarget = Object;
  (globalThis as { gadget?: unknown }).gadget = {
    open: async () => opened,
    ask: (prompt: string, progress: ProgressTarget) =>
      new Promise<AskResult>(resolve => asked.push({ prompt, progress, resolve })),
    cancel: async () => { cancelled.push(1); return { ok: true }; },
    startOver: async () => {},
  };
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')!.textContent).toBe(""));
  return { asked, cancelled };
}

const main = () => document.querySelector("main")!;
const prompt = () => document.querySelector("textarea")!;
const askButton = () => [...document.querySelectorAll("button")].find(b => b.textContent === "Ask")!;
const submit = (text: string) => {
  prompt().value = text;
  askButton().click();
};
const press = (key: string, init: KeyboardEventInit = {}) =>
  prompt().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

// The Gadget frame's sandbox has no `allow-forms` (and its CSP sets `form-action 'none'`), so the
// browser refuses a form submission before any submit event fires. jsdom doesn't, so every test
// stands in for that: a submit event never reaches the page, and asking a form to submit throws.
const refuseFormSubmission = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};
const realRequestSubmit = HTMLFormElement.prototype.requestSubmit;
const realSubmit = HTMLFormElement.prototype.submit;

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  window.addEventListener("submit", refuseFormSubmission, true);
  HTMLFormElement.prototype.requestSubmit = () => { throw new Error("form submission is blocked in a sandboxed Gadget frame"); };
  HTMLFormElement.prototype.submit = HTMLFormElement.prototype.requestSubmit;
});
afterEach(() => {
  window.removeEventListener("submit", refuseFormSubmission, true);
  HTMLFormElement.prototype.requestSubmit = realRequestSubmit;
  HTMLFormElement.prototype.submit = realSubmit;
  delete (globalThis as { gadget?: unknown }).gadget;
  delete (globalThis as { RpcTarget?: unknown }).RpcTarget;
});

describe("InferOps Dot client", () => {
  it("shows an empty conversation, pointing at where changes are decided", async () => {
    await start({ ok: true, conversation: null });
    expect(main().textContent).toContain("Ask your Dot about your work in this workspace, or about your company's knowledge");
    expect(main().textContent).toContain("Decide it under Needs your approval.");
  });

  it("fills the answer in as it comes, then redraws the conversation InferOps holds", async () => {
    const { asked } = await start({ ok: true, conversation: null });
    submit("What changed today?");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    asked[0]!.progress.progress({ type: "text", delta: "ENG-7 " });
    asked[0]!.progress.progress({ type: "tool", name: "issue_list", status: "started" });
    expect(main().textContent).toContain("ENG-7 ");
    expect(main().textContent).toContain("Using issue_list…");
    asked[0]!.resolve({ ok: true, status: "complete", conversation: conversation() });
    await vi.waitFor(() => expect(main().textContent).toContain("ENG-7 moved to Done."));
    expect(main().querySelectorAll("li.message")).toHaveLength(2);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("lists each change with where it stands, an uncertain one as uncertain, and no way to decide it here", async () => {
    await start({ ok: true, conversation: conversation({
      proposals: [
        { id: "p1", tool: "issue_create", status: { outcome: "waiting" } },
        { id: "p2", tool: "issue_update", status: { outcome: "unknown" } },
        { id: "p3", tool: "issue_comment", status: { outcome: "failed", code: "EXPIRED" } },
      ],
    }) });
    const section = document.querySelector('section[aria-label="Changes your Dot proposed"]')!;
    expect(section.textContent).toContain("Waiting for your decision");
    expect(section.textContent).toContain("Decide it under Needs your approval.");
    expect(section.textContent).toContain("Uncertain");
    expect(section.textContent).toContain("may or may not have been made");
    expect(section.textContent).toContain("Expired");
    expect([...section.querySelectorAll("button")]).toEqual([]);
  });

  // FAC-136: a knowledge write reads as what it changes, with its target's link as text.
  it("lists a knowledge write by what it changes, its target as text, and what approving it does", async () => {
    const page = "inferops://acme.handbook/knowledge/page/00000000-0000-4000-8000-0000000000aa";
    await start({ ok: true, conversation: conversation({
      proposals: [
        { id: "p1", tool: "knowledge_page_edit", status: { outcome: "waiting" }, knowledge: { kind: "edit", page } },
        { id: "p2", tool: "knowledge_page_create", status: { outcome: "succeeded" },
          knowledge: { kind: "create", workspace: "inferops://acme.handbook/knowledge/page", title: MARKUP } },
      ],
    }) });
    const section = document.querySelector('section[aria-label="Changes your Dot proposed"]')!;
    expect(section.textContent).toContain("A change to a wiki page");
    expect(section.textContent).toContain(`Page: ${page}`);
    expect(section.textContent).toContain("Your Dot will change this page as you, and readers see it right away.");
    expect(section.textContent).toContain(`A new wiki page: ${MARKUP}`);
    expect(section.textContent).toContain("Readers see it now.");
    expect(section.textContent).not.toMatch(/publish/i);
    expect(section.querySelector("a, img, button")).toBeNull();
  });

  it("says a knowledge read changes nothing, and names a proposed knowledge write as it comes", async () => {
    const { asked } = await start({ ok: true, conversation: null });
    expect(main().textContent).toContain("reading it changes nothing");
    submit("Fix the typo on the refunds page");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    asked[0]!.progress.progress({ type: "tool", name: "knowledge_company_search", status: "started" });
    expect(main().textContent).toContain("Reading your company's knowledge… Reading changes nothing.");
    asked[0]!.progress.progress({ type: "proposal", proposal: {
      id: "p1", tool: "knowledge_page_edit", status: { outcome: "waiting" },
      knowledge: { kind: "edit", page: "inferops://acme.handbook/knowledge/page/1" },
    } });
    expect(main().textContent).toContain("Proposed a change to a wiki page. Decide it under Needs your approval.");
  });

  it("draws names and messages as text, never markup", async () => {
    await start({ ok: true, conversation: conversation({
      messages: [{ id: "a1", role: "assistant", content: MARKUP, status: "complete" }],
      proposals: [{ id: "p1", tool: MARKUP, status: { outcome: "waiting" } }],
    }) });
    expect(main().querySelector("img")).toBeNull();
    expect(main().textContent).toContain(MARKUP);
  });

  it("shows a refusal in its own words, takes back the question, and keeps the text to ask again", async () => {
    const { asked } = await start({ ok: true, conversation: conversation() });
    submit("File it");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    asked[0]!.resolve({ ok: false, reason: "unavailable", message: "Your Dot can't run now. Try again later." });
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("its own database");
    expect(main().querySelectorAll("li.message")).toHaveLength(2);
    expect(prompt().value).toBe("File it");
  });

  // FAC-147: inside the Gadget's sandbox a form can't submit, so Ask must not depend on one.
  it("asks on a click of Ask and on Enter, with no form submission, in a sandboxed frame", async () => {
    const { asked } = await start({ ok: true, conversation: null });
    expect(document.querySelector("form")).toBeNull();
    submit("  What changed today?  ");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]!.prompt).toBe("What changed today?");
    expect(prompt().value).toBe("");
    asked[0]!.resolve({ ok: true, status: "complete", conversation: conversation() });
    await vi.waitFor(() => expect(prompt().disabled).toBe(false));

    prompt().value = "And yesterday?";
    expect(press("Enter")).toBe(false);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]!.prompt).toBe("And yesterday?");
  });

  it("keeps Shift+Enter and composing for a new line, and never asks empty or twice", async () => {
    const { asked } = await start({ ok: true, conversation: null });
    prompt().value = "Line one";
    expect(press("Enter", { shiftKey: true })).toBe(true);
    expect(press("Enter", { isComposing: true })).toBe(true);
    submit("   ");
    press("Enter");
    await Promise.resolve();
    expect(asked).toHaveLength(0);

    submit("Once");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(askButton().disabled).toBe(true);
    prompt().value = "Again";
    askButton().click();
    press("Enter");
    await Promise.resolve();
    expect(asked).toHaveLength(1);
  });

  it("stops the running turn on Stop", async () => {
    const { asked, cancelled } = await start({ ok: true, conversation: null });
    submit("Long one");
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    const stop = [...document.querySelectorAll("button")].find(b => b.textContent === "Stop")!;
    expect(stop.hidden).toBe(false);
    stop.click();
    await vi.waitFor(() => expect(cancelled).toHaveLength(1));
  });
});

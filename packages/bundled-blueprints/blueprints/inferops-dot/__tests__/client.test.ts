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
const submit = (text: string) => {
  prompt().value = text;
  document.querySelector("form")!.requestSubmit();
};

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
afterEach(() => {
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

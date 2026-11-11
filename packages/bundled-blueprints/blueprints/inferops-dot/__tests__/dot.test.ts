// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DECIDE_WHERE, classify, failureWords, knowledgeWrite, proposalHeading, proposalWords, shownProgress, shownProposal, stepWords,
} from "../files/lib/dot.ts";

describe("a proposal's words", () => {
  it("points a waiting change at the one place changes are decided", () => {
    expect(proposalWords({ outcome: "waiting" })).toEqual({ label: "Waiting for your decision", detail: DECIDE_WHERE });
  });

  it("never reads an uncertain change as done or not done", () => {
    const words = proposalWords({ outcome: "unknown", reason: "It may or may not have been applied." });
    expect(words.label).toBe("Uncertain");
    expect(words.detail).toContain("may or may not have been made");
    expect(`${words.label} ${words.detail}`).not.toMatch(/\bMade\b|Declined|Not made/);
  });

  it("names each settled outcome, and an expired one as expired", () => {
    expect(proposalWords({ outcome: "succeeded" }).label).toBe("Made");
    expect(proposalWords({ outcome: "rejected" }).label).toBe("Declined");
    expect(proposalWords({ outcome: "running" }).label).toBe("Being made");
    expect(proposalWords({ outcome: "failed", code: "EXPIRED" }).label).toBe("Expired");
    expect(proposalWords({ outcome: "failed", code: "FORBIDDEN", reason: "This change isn't permitted." }))
      .toEqual({ label: "Not made", detail: "This change isn't permitted." });
  });
});

describe("a failure's notice", () => {
  it("reads the gatekeeper's code, and passes on only its sentence", () => {
    expect(classify(new Error("Error: FORBIDDEN: Your InferOps access doesn't allow this here.")))
      .toEqual({ ok: false, reason: "refused", message: "Your InferOps access doesn't allow this here." });
    expect(classify(new Error("NOT_FOUND: The page or record isn't one you can open.")).reason).toBe("not-found");
    expect(classify("weird").reason).toBe("error");
  });

  it("says a refusal can come from a shared connection, and an outage from a company's own database", () => {
    expect(failureWords({ ok: false, reason: "refused", message: "x." }).body).toContain("A shared connection has no Dot");
    expect(failureWords({ ok: false, reason: "unavailable", message: "x." }).body).toContain("its own database");
    for (const reason of ["not-connected", "busy", "not-found", "disabled", "error"] as const) {
      expect(failureWords({ ok: false, reason, message: "m" }).heading, reason).toBeTruthy();
    }
  });
});

// FAC-136: the Dot's knowledge writes, named by what they change, and its knowledge reads, which change nothing.
describe("a knowledge write", () => {
  const page = "inferops://acme.handbook/knowledge/page/00000000-0000-4000-8000-0000000000aa";
  const workspace = "inferops://acme.handbook/knowledge/page";

  it("keeps an edit's page link and a create's workspace link and title, never the body", () => {
    expect(knowledgeWrite("knowledge_page_edit", JSON.stringify({ page, expectedVersion: 3, body: "secret body" })))
      .toEqual({ kind: "edit", page });
    expect(knowledgeWrite("knowledge_page_edit", JSON.stringify({ page, title: " Refund policy " })))
      .toEqual({ kind: "edit", page, newTitle: "Refund policy" });
    expect(knowledgeWrite("knowledge_page_create", JSON.stringify({ workspace, title: "Refunds", body: "x" })))
      .toEqual({ kind: "create", workspace, title: "Refunds" });
    expect(knowledgeWrite("knowledge_page_create", JSON.stringify({ workspace, title: "t".repeat(500) }))!)
      .toMatchObject({ title: "t".repeat(200) });
  });

  it("is nothing for another tool, unreadable arguments, or a target that isn't a canonical link", () => {
    expect(knowledgeWrite("issue_create", JSON.stringify({ page }))).toBeUndefined();
    expect(knowledgeWrite("knowledge_page_edit", "{not json")).toBeUndefined();
    expect(knowledgeWrite("knowledge_page_edit", "null")).toBeUndefined();
    expect(knowledgeWrite("knowledge_page_edit", JSON.stringify({ page: "https://example.com/page" }))).toBeUndefined();
    expect(knowledgeWrite("knowledge_page_create", JSON.stringify({ workspace: "javascript:alert(1)" }))).toBeUndefined();
  });

  it("reaches the client without its arguments or receipt, while it waits and as it is proposed", () => {
    const proposal = {
      id: "p1", tool: "knowledge_page_edit", input: JSON.stringify({ page, body: "secret body" }),
      status: { outcome: "waiting" as const }, receipt: { token: "r" }, createdAt: "c", expiresAt: "e",
    };
    expect(shownProposal(proposal)).toEqual({ id: "p1", tool: "knowledge_page_edit", status: { outcome: "waiting" }, knowledge: { kind: "edit", page } });
    const relayed = shownProgress({ type: "proposal", proposal });
    expect(JSON.stringify(relayed)).not.toMatch(/secret body|receipt/);
    expect(shownProgress({ type: "text", delta: "hi" })).toEqual({ type: "text", delta: "hi" });
  });

  it("is named by what it changes, says what approving it does, and that readers see it once made", () => {
    expect(proposalHeading({ tool: "knowledge_page_edit", knowledge: { kind: "edit", page } })).toBe("A change to a wiki page");
    expect(proposalHeading({ tool: "knowledge_page_create", knowledge: { kind: "create", workspace, title: "Refunds" } }))
      .toBe("A new wiki page: Refunds");
    expect(proposalHeading({ tool: "issue_create" })).toBe("issue_create");
    expect(proposalWords({ outcome: "waiting" }, { kind: "edit", page }).detail)
      .toBe(`Your Dot will change this page as you, and readers see it right away. ${DECIDE_WHERE}`);
    expect(proposalWords({ outcome: "waiting" }, { kind: "create", workspace }).detail)
      .toContain("Your Dot will create this page as you");
    expect(proposalWords({ outcome: "succeeded" }, { kind: "edit", page })).toEqual({ label: "Made", detail: "Readers see it now." });
    for (const status of [{ outcome: "waiting" }, { outcome: "succeeded" }] as const) {
      expect(JSON.stringify(proposalWords(status, { kind: "edit", page }))).not.toMatch(/publish/i);
    }
  });
});

describe("a step while the Dot answers", () => {
  it("says a knowledge read changes nothing, and names any other tool", () => {
    for (const tool of ["knowledge_company_search", "knowledge_company_list", "knowledge_company_read"]) {
      expect(stepWords(tool)).toBe("Reading your company's knowledge… Reading changes nothing.");
    }
    expect(stepWords("issue_list")).toBe("Using issue_list…");
  });
});

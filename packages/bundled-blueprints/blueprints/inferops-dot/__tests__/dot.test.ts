// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DECIDE_WHERE, RECONNECT_WORDS, RUN_TOOLS, WORKFLOW_RUN_TOOL, classify, decisionWords, failureWords, knowledgeWrite, proposalHeading, proposalWords, shownProgress, shownProposal,
  stepWords, workflowRunWords,
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

// FAC-134: a workflow run the Dot handed to InferOS is never "made"; once it ends, its outcome shows.
describe("a workflow-run proposal's words", () => {
  const run = (outcome: "succeeded" | "failed" | "uncertain", extra: Record<string, string> = {}) =>
    ({ runId: "run-1", outcome, ranAs: "gadget_bindings" as const, ...extra });

  it("reads started, not made, until its run has an outcome", () => {
    expect(workflowRunWords({ outcome: "succeeded" })).toEqual({
      label: "Started in InferOS", detail: "Its run belongs to InferOS now. How it came out shows here once it ends.",
    });
    expect(workflowRunWords({ outcome: "succeeded" }).label).not.toBe("Made");
    // Nothing reported yet, so nothing to call unverified.
    expect(workflowRunWords({ outcome: "succeeded" }).note).toBeUndefined();
  });

  it("says how its run came out, why in fixed words, and what it ran as", () => {
    expect(workflowRunWords({ outcome: "succeeded" }, run("succeeded"))).toEqual({
      label: "Run finished", detail: "It ran on the workflow's own connections.", note: "Reported, not verified",
    });
    expect(workflowRunWords({ outcome: "succeeded" }, run("failed", { reasonCode: "cancelled" }))).toEqual({
      label: "Run failed", detail: "It failed because it was cancelled. It ran on the workflow's own connections.", note: "Reported, not verified",
    });
    const assigned = workflowRunWords({ outcome: "succeeded" }, { ...run("uncertain", { reasonCode: "action-unknown" }), ranAs: "service_account" });
    expect(assigned.label).toBe("Run uncertain");
    expect(assigned.note).toBe("Reported, not verified");
    expect(assigned.detail).toContain("a change it proposed may or may not have been made");
    expect(assigned.detail).toContain("as the workflow's assigned account, not as you");
    // A reason it doesn't know says only that it failed, never the code itself.
    expect(workflowRunWords({ outcome: "succeeded" }, run("failed", { reasonCode: "something-new" })).detail)
      .toBe("It ran on the workflow's own connections.");
  });

  it("says a personal workflow's run placed requests, never that it was done (FAC-134 capability 2)", () => {
    const placed = workflowRunWords({ outcome: "succeeded" }, { ...run("succeeded"), kind: "personal-workflow" });
    expect(placed).toEqual({ label: "Requests placed", detail: "Requests placed. Each waits for the console's builders.", note: "Reported, not verified" });
    expect(JSON.stringify(placed)).not.toMatch(/\b(done|made|finished)\b/i);
    const refused = workflowRunWords({ outcome: "succeeded" }, { ...run("failed", { reasonCode: "step-refused" }), kind: "personal-workflow" });
    expect(refused.detail).toContain("one of its steps was refused, so nothing after it was requested");
    // A published workflow's run still reads as before.
    expect(workflowRunWords({ outcome: "succeeded" }, { ...run("succeeded"), kind: "workflow-run" }).label).toBe("Run finished");
  });

  it("says how a delegate ended, as you, never what it did (FAC-134 capability 3)", () => {
    const delegate = (outcome: "succeeded" | "failed" | "uncertain", extra: Record<string, string> = {}) =>
      ({ runId: "run-d", outcome, ranAs: "person" as const, kind: "delegate" as const, ...extra });
    expect(workflowRunWords({ outcome: "succeeded" }, delegate("succeeded"))).toEqual({
      label: "Delegate finished", detail: "Check what it changed in your operate session. It ran as you, with at most what you approved.",
      note: "Reported, not verified",
    });
    expect(workflowRunWords({ outcome: "succeeded" }, delegate("failed", { reasonCode: "requester-revoked" })).detail)
      .toBe("It failed because your access in your operate session changed while it ran. It ran as you, with at most what you approved.");
    expect(workflowRunWords({ outcome: "succeeded" }, delegate("failed", { reasonCode: "cancelled" })).detail).toContain("because it was stopped");
    expect(workflowRunWords({ outcome: "succeeded" }, delegate("failed", { reasonCode: "runtime-error" })).detail)
      .toContain("because its code stopped with an error");
    expect(RUN_TOOLS.has("inferos_delegate_launch")).toBe(true);
  });

  it("has words for every reason InferOS gives a failed or uncertain run", () => {
    const failures = ["requester-revoked", "assignment-changed", "trigger-gone", "bindings-needed", "cancelled", "timed-out",
      "attempts-exhausted", "runtime-error", "step-refused"];
    for (const reasonCode of failures) {
      expect(workflowRunWords({ outcome: "succeeded" }, run("failed", { reasonCode })).detail).toMatch(/^It failed because /);
    }
    for (const reasonCode of ["action-unknown", "lost-after-write", "not-started", "step-unknown"]) {
      expect(workflowRunWords({ outcome: "succeeded" }, run("uncertain", { reasonCode })).detail).toMatch(/^It's uncertain because /);
    }
  });

  it("reads waiting, declined, failed and uncertain as any change does", () => {
    for (const status of [{ outcome: "waiting" }, { outcome: "rejected" }, { outcome: "failed", code: "EXPIRED" }, { outcome: "unknown" }] as const) {
      expect(workflowRunWords(status)).toEqual(proposalWords(status));
    }
  });

  it("shows the client its run's fixed fields only", () => {
    const shownRun = shownProposal({
      id: "p1", tool: WORKFLOW_RUN_TOOL, input: "{}", status: { outcome: "succeeded" }, receipt: null,
      createdAt: "", expiresAt: "",
      run: { ...run("failed", { reasonCode: "runtime-error" }), extra: "x" } as never,
    }).run;
    expect(shownRun).toEqual({ runId: "run-1", outcome: "failed", reasonCode: "runtime-error", ranAs: "gadget_bindings" });
  });
});

describe("a background decision's words (FAC-135)", () => {
  const waiting = { outcome: "waiting" } as const;
  const proposal = (extra: Record<string, unknown> = {}) => ({
    id: "p1", tool: "issue_create", input: "{}", status: { outcome: "succeeded" as const }, receipt: null,
    createdAt: "", expiresAt: "", ...extra,
  });

  it("reads waiting for your decision as before, with nothing more while the run waits", () => {
    expect(decisionWords({ status: waiting })).toEqual({});
    expect(decisionWords({ status: waiting, runStatus: "awaiting_decision" })).toEqual({});
    expect(proposalWords(waiting).label).toBe("Waiting for your decision");
  });

  it("says it waits for you to reconnect when your sign-in has ended, and nothing is made meanwhile", () => {
    expect(decisionWords({ status: waiting, runStatus: "awaiting_decision", waitsForReconnect: true })).toEqual(RECONNECT_WORDS);
    expect(RECONNECT_WORDS.detail).toContain("Nothing is made meanwhile");
    // Only the gatekeeper's flag says so: a waiting status alone, whatever its code, is waiting for the decision.
    expect(decisionWords({ status: { outcome: "waiting", code: "FORBIDDEN" } })).toEqual({});
    expect(shownProposal(proposal({ status: waiting, waitsForReconnect: true })).waitsForReconnect).toBe(true);
    expect(shownProposal(proposal({ status: waiting, waitsForReconnect: false })).waitsForReconnect).toBeUndefined();
  });

  it("says what the Dot did after the decision, only once that decision resumed it, and that it ended refused when nothing was decided in time", () => {
    expect(decisionWords({ status: { outcome: "succeeded" }, runStatus: "complete", resumed: true }).resume)
      .toBe("Your Dot picked up your decision and answered below.");
    expect(decisionWords({ status: { outcome: "rejected" }, runStatus: "running", resumed: true }).resume)
      .toBe("Your Dot is answering after your decision.");
    expect(decisionWords({ status: { outcome: "failed", code: "EXPIRED" }, runStatus: "refused" }).resume)
      .toContain("Ended: nothing was decided in time");
    for (const runStatus of ["error", "interrupted"] as const) {
      expect(decisionWords({ status: { outcome: "failed" }, runStatus, resumed: true }).resume, runStatus).toContain("after your decision");
    }
  });

  it("never says the Dot resumed from its run's status alone (r1 on #494)", () => {
    // An undecided change, whatever its run is doing: nothing about a resume.
    for (const runStatus of ["running", "complete", "error", "interrupted", "awaiting_decision"] as const) {
      expect(decisionWords({ status: waiting, runStatus }), runStatus).toEqual({});
      expect(decisionWords({ status: waiting, runStatus, resumed: true }), runStatus).toEqual({});
      expect(decisionWords({ status: { outcome: "running" }, runStatus, resumed: true }), runStatus).toEqual({});
    }
    // Background resume off: every run ends complete, and a decided change's decision resumed nothing.
    expect(decisionWords({ status: { outcome: "succeeded" }, runStatus: "complete" })).toEqual({});
    expect(decisionWords({ status: { outcome: "rejected" }, runStatus: "complete" })).toEqual({});
    // Only the gatekeeper's recorded `resumed` reaches the page, and only as true.
    expect(shownProposal(proposal({ status: { outcome: "succeeded" }, resumed: true })).resumed).toBe(true);
    expect(shownProposal(proposal({ status: { outcome: "succeeded" }, resumed: false })).resumed).toBeUndefined();
    expect(shownProposal(proposal({ status: { outcome: "succeeded" } })).resumed).toBeUndefined();
  });

  it("reads the gatekeeper's own resumed field: the words for a resumed decision, none for one that resumed nothing", () => {
    // Shaped as gatekeeper-inferops' `shownProposal` sends it (#493): `resumed` and
    // `waitsForReconnect` always present as booleans, `input` as JSON text.
    const fromGatekeeper = (resumed: boolean) => ({
      id: "p-1", tool: "issue_create", input: "{}", status: { outcome: "succeeded" as const },
      receipt: null, runStatus: "complete" as const, waitsForReconnect: false, resumed,
      createdAt: "2026-11-13T00:00:00.000Z", expiresAt: "2026-11-20T00:00:00.000Z",
    });
    expect(decisionWords(shownProposal(fromGatekeeper(true) as never)).resume)
      .toBe("Your Dot picked up your decision and answered below.");
    expect(decisionWords(shownProposal(fromGatekeeper(false) as never))).toEqual({});
  });

  it("shows the client a run status it knows, and never another", () => {
    expect(shownProposal(proposal({ runStatus: "awaiting_decision" })).runStatus).toBe("awaiting_decision");
    expect(shownProposal(proposal({ runStatus: "refused" })).runStatus).toBe("refused");
    expect(shownProposal(proposal({ runStatus: "paused" }) as never).runStatus).toBeUndefined();
    expect(shownProposal(proposal()).runStatus).toBeUndefined();
  });
});

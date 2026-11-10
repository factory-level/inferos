// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DECIDE_WHERE, classify, failureWords, proposalWords } from "../files/lib/dot.ts";

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

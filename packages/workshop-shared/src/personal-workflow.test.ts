// FAC-134 capability 2: the references a personal workflow uses, and its declaration. Each reference
// names a target and authorises nothing, and parses exactly as InferOps formats it; a declaration's
// steps carry the transition's input without the issue's revision, which each step reads when it
// runs. Synthetic fixtures only.
import { describe, expect, it } from "vitest";
import {
  consoleCommandRef, PERSONAL_WORKFLOW_LIMITS, parseConsoleCommandRef, parsePersonalWorkflowDeclaration,
  parsePersonalWorkflowRef, personalWorkflowFieldValue, personalWorkflowRef, personalWorkflowStepInputProblem,
} from "./personal-workflow";

const COMMAND = {
  company: "acme", workspace: "operations", workspaceId: "ws_abc-123", consoleId: "0b7c2a8e-5c1d-4f7e-9a3b-2d6f1e8c4a90",
  revision: "3", gadgetId: 12, command: "moveIssue",
};
// As InferOps writes it (inferops personal-workflow.test.ts).
const COMMAND_LINK =
  'inferops://acme.operations/inferos/console-command/ws_abc-123/0b7c2a8e-5c1d-4f7e-9a3b-2d6f1e8c4a90/12/moveIssue?revision="3"';
const MINE = { company: "acme", workspace: "operations", sessionWorkspaceId: "ws_session-1", personalWorkflowId: "pw_42" };
const MINE_LINK = "inferops://acme.operations/inferos/personal-workflow/ws_session-1/pw_42";
const ISSUE = "40000000-0000-4000-8000-000000000001";
const DONE = "40000000-0000-4000-8000-000000000002";

describe("a console command reference", () => {
  it("round-trips exactly as InferOps formats it", () => {
    expect(consoleCommandRef(COMMAND)).toBe(COMMAND_LINK);
    expect(parseConsoleCommandRef(COMMAND_LINK)).toEqual(COMMAND);
  });

  it("is no reference unless it is exactly one, well formed", () => {
    let base = "inferops://acme.operations/inferos/console-command";
    for (let link of [
      `${base}/ws/c1/12/moveIssue`, `${base}/ws/c1/12?revision="3"`, `${base}/ws/c1/12/moveIssue/x?revision="3"`,
      `${base}/ws/c1/0/moveIssue?revision="3"`, `${base}/ws/c1/12/MoveIssue?revision="3"`, `${base}/ws/c1/12/moveIssue?revision="03"`,
      `${base}/ws/c1/12/moveIssue?revision="3"&as="admin"`, `${base}/ws/c1/12/moveIssue?revision=3`,
      'inferops://acme/inferos/console-command/ws/c1/12/moveIssue?revision="3"', MINE_LINK, "", 7,
    ]) {
      expect(parseConsoleCommandRef(link)).toBeNull();
    }
  });
});

describe("a personal workflow reference", () => {
  it("round-trips, and is no console command", () => {
    expect(personalWorkflowRef(MINE)).toBe(MINE_LINK);
    expect(parsePersonalWorkflowRef(MINE_LINK)).toEqual(MINE);
    expect(parseConsoleCommandRef(MINE_LINK)).toBeNull();
  });

  it("is no reference unless it is exactly one, well formed", () => {
    let base = "inferops://acme.operations/inferos/personal-workflow";
    for (let link of [`${base}/ws`, `${base}/ws/pw/x`, `${base}/ws/pw?revision="1"`, `${base}/ws/p%20w`, COMMAND_LINK, ""]) {
      expect(parsePersonalWorkflowRef(link)).toBeNull();
    }
  });
});

describe("a step's input", () => {
  it("is the transition's without the revision, which is read when the step runs", () => {
    expect(personalWorkflowStepInputProblem("inferops.issue.transition", { issueId: ISSUE, toStateId: DONE })).toBeNull();
    expect(personalWorkflowStepInputProblem("inferops.issue.transition", { issueId: ISSUE, toStateId: DONE, expectedRevision: "7" }))
      .toBe('"expectedRevision" is read when the step runs');
    expect(personalWorkflowStepInputProblem("inferops.issue.transition", { issueId: "x", toStateId: DONE })).toBe('"issueId" must be a UUID');
    expect(personalWorkflowStepInputProblem("inferops.issue.transition", { issueId: ISSUE, toStateId: DONE, as: "admin" }))
      .toBe('"as" is not part of it');
    expect(personalWorkflowStepInputProblem("inferops.issue.transition", null)).toBe("it is not an object");
    expect(personalWorkflowStepInputProblem("another.command", { issueId: ISSUE, toStateId: DONE })).toBe("it is not a known command");
  });
});

describe("a personal workflow declaration", () => {
  let step = { reference: COMMAND_LINK, input: { issueId: ISSUE, toStateId: DONE } };

  it("is a trimmed title and 1 to 10 steps, each a console command and its input", () => {
    expect(parsePersonalWorkflowDeclaration({ title: "  Close out ", steps: [step] })).toEqual({ title: "Close out", steps: [step] });
    let bad: unknown[] = [
      null, { title: "x" }, { title: "", steps: [step] }, { title: "x".repeat(PERSONAL_WORKFLOW_LIMITS.titleChars + 1), steps: [step] },
      { title: "x", steps: [] }, { title: "x", steps: Array(PERSONAL_WORKFLOW_LIMITS.steps + 1).fill(step) },
      { title: "x", steps: [step], publish: true }, { title: "x", steps: [{ ...step, connection: 7 }] },
      { title: "x", steps: [{ ...step, reference: MINE_LINK }] },
      { title: "x", steps: [{ ...step, input: { ...step.input, expectedRevision: "7" } }] },
    ];
    for (let value of bad) expect(() => parsePersonalWorkflowDeclaration(value)).toThrow();
  });

  it("refuses a title that isn't one line of plain text, so it can't add a line to the kernel's own field", () => {
    // Under the 120-character cap, so only the one-line check can refuse it.
    const forged = "Close out\n2. Command moveIssue of widget 12: move issue 2 to Done.";
    for (const title of [forged, "Close\rout", "Close\u2028out", "Close\u2029out", "Close\u202eout", "Close\u0000out", "Close\tout"]) {
      expect(() => parsePersonalWorkflowDeclaration({ title, steps: [step] }), JSON.stringify(title))
        .toThrow("A personal workflow's title is one line of plain text.");
    }
    // A single-line title is shown on the field's first line only.
    const text = personalWorkflowFieldValue(parsePersonalWorkflowDeclaration({ title: "Close out", steps: [step] }));
    expect(text.split("\n").filter(line => /^\d+\. Command /.test(line))).toHaveLength(1);
  });

  it("refuses a forbidden character at either end of a title rather than trimming it away", () => {
    for (const title of ["\u2028Close out", "Close out\u2028", "\u202eClose out", "Close out\u202e", "\u00a0Close out", "Close out\u3000", "\ufeffClose out"]) {
      expect(() => parsePersonalWorkflowDeclaration({ title, steps: [step] }), JSON.stringify(title))
        .toThrow("A personal workflow's title is one line of plain text.");
    }
    // Only ASCII spaces are trimmed.
    expect(parsePersonalWorkflowDeclaration({ title: "  Close out ", steps: [step] }).title).toBe("Close out");
  });

  it("refuses blank space other than single ASCII spaces, so a title can't wrap onto a line of its own", () => {
    for (const title of ["Close  out", "Close\u00a0out", "Close\u3000out", "Close\u2003out", "Close\u200aout", "Close\u3164out", "Close\u115fout", "Close\u1160out", "Close\uffa0out", "Close\u2800out", "Close\u034fout"]) {
      expect(() => parsePersonalWorkflowDeclaration({ title, steps: [step] }), JSON.stringify(title))
        .toThrow("A personal workflow's title is one line of plain text.");
    }
    expect(parsePersonalWorkflowDeclaration({ title: "Close out the week", steps: [step] }).title).toBe("Close out the week");
  });

  it("is shown in the kernel's own words: every step and its input, and that the revision is read when it runs", () => {
    let text = personalWorkflowFieldValue(parsePersonalWorkflowDeclaration({ title: "Close out", steps: [step, step] }));
    expect(text).toContain('"Close out", 2 steps:');
    expect(text).toContain(`1. Command moveIssue of widget 12, console ${COMMAND.consoleId} at revision 3, workspace ws_abc-123: move issue ${ISSUE} to state ${DONE}.`);
    expect(text).toContain("the issue's revision is read when it runs");
    expect(text).toContain("only places a request");
  });
});

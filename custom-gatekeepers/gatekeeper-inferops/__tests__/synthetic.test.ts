// MOCK_INFEROPS_SYNTHETIC_ISSUES (development only, #28): a large synthetic board in the mock's seed.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SYNTHETIC_ISSUES, syntheticIssueCount, syntheticProject } from "../src/mock-inferops";

// The var is read when an account's data is first seeded. Workers share one env object per
// isolate, so the suite sets it as a dev server restarted with it would.
const mutableEnv = env as unknown as { MOCK_INFEROPS_SYNTHETIC_ISSUES?: string };
afterEach(() => { delete mutableEnv.MOCK_INFEROPS_SYNTHETIC_ISSUES; });

const freshAccount = () => env.MOCK_INFEROPS.getByName(`demo.local/${crypto.randomUUID()}`);

describe("syntheticIssueCount", () => {
  it("accepts only a whole number from 1 to the maximum", () => {
    expect(syntheticIssueCount("500")).toBe(500);
    expect(syntheticIssueCount(String(MAX_SYNTHETIC_ISSUES))).toBe(MAX_SYNTHETIC_ISSUES);
    for (const value of [undefined, "", "0", "-1", "1.5", "500 ", "lots", String(MAX_SYNTHETIC_ISSUES + 1)]) {
      expect(syntheticIssueCount(value)).toBeNull();
    }
  });
});

describe("syntheticProject", () => {
  it("is deterministic, spreads its issues over six states and keeps ids apart from the fixture's", () => {
    const project = syntheticProject(500);
    expect(syntheticProject(500)).toEqual(project);
    expect(project.project.identifier).toBe("PERF");
    expect(project.states.map(state => state.group))
      .toEqual(["backlog", "unstarted", "started", "started", "completed", "cancelled"]);
    expect(project.issues).toHaveLength(500);
    expect(new Set(project.issues.map(issue => issue.id)).size).toBe(500);
    const stateIds = new Set(project.states.map(state => state.id));
    expect(project.issues.every(issue => stateIds.has(issue.stateId) && /^\d+$/.test(issue.revision))).toBe(true);
    expect(project.issues.every(issue => !issue.id.includes("-8000-"))).toBe(true);
  });
});

describe("MOCK_INFEROPS_SYNTHETIC_ISSUES", () => {
  it("adds the PERF project to a newly seeded account", async () => {
    mutableEnv.MOCK_INFEROPS_SYNTHETIC_ISSUES = "500";
    const mock = freshAccount();
    expect((await mock.listProjects()).map(project => project.identifier)).toEqual(["DEMO", "ENG", "PERF"]);
    expect((await mock.readProject("PERF")).issues).toHaveLength(500);
  });

  it("adds nothing when unset or out of range", async () => {
    expect((await freshAccount().listProjects()).map(project => project.identifier)).toEqual(["DEMO", "ENG"]);
    mutableEnv.MOCK_INFEROPS_SYNTHETIC_ISSUES = "100000";
    expect((await freshAccount().listProjects()).map(project => project.identifier)).toEqual(["DEMO", "ENG"]);
  });

  it("leaves an account seeded before it was set as it was", async () => {
    const mock = freshAccount();
    await mock.listProjects();
    mutableEnv.MOCK_INFEROPS_SYNTHETIC_ISSUES = "50";
    expect(await mock.hasProject("PERF")).toBe(false);
  });
});

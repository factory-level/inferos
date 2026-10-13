// Workflow policy (MVP-18): a read-only, private-only resource kind over one project's published
// content-workflow policy. The strict parse (every source key, enum, pattern, cap and refinement;
// configured consistency; the project asked for), the projection (exactly publishedBy, agents and
// every rule reason left out, everything else as sent and in order), no trace of what is left out,
// the switch, routing ahead of the board path, private-only admission, no actions, and the
// observation. The HTTP side (exactly two GETs, the one refusal, logs) is in
// workflow-policy-http.test.ts; a connected person's own sign-in is in account.test.ts.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import {
  PROJECT_BOARD_RESOURCE, PROJECT_WORKFLOW_RESOURCE, parseProjectWorkflowUrl, projectWorkflowUrl, resourceKind,
} from "../src/resources";
import {
  WORKFLOW_POLICY_UNREADABLE_MESSAGE, projectWorkflowHead, readWorkflowPolicyAnswer,
  type WorkflowHeadRecord,
} from "../src/workflow-policy";
import DEMO_WORKFLOW from "../src/fixtures/demo-workflow.json";
import type { WorkflowPolicyProps } from "./worker";

const WORKFLOW_URL = "inferops://demo.local/project/workflow/DEMO";
const WORKFLOW_PATTERN = "inferops://*/project/workflow/*";
const DEMO_PROJECT = "10000000-0000-4000-8000-000000000001";
const ENG_PROJECT = "10000000-0000-4000-8000-000000000002";

/** Every value the fixture carries only in a field the projection leaves out, and those fields' keys. */
const CANARIES = [
  "canary-top-rule-reason-3f9a", "canary-fragment-rule-reason-5d1e", "canary-binding-rule-reason-8b2c",
  "canary-transition-rule-reason-6c4d", "canary-agent-responsibility-2e7b",
  "c0a9e700-0000-4000-8000-0000000a9e71", "c0b1b500-0000-4000-8000-0000000b1b51", "canary",
];
const OMITTED_KEYS = ['"reason"', '"agents"', '"publishedBy"', '"responsibility"'];

/** The DEMO answer, a fresh copy each time. */
const demoAnswer = () => structuredClone(DEMO_WORKFLOW.projects.DEMO) as { head: Record<string, any> };

/** `rules` without their reasons, in place. */
const dropReasons = (rules?: Array<Record<string, unknown>>) => rules?.forEach(rule => delete rule.reason);
/** `n` independent copies of `value`, so no entry aliases another. */
const copies = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => structuredClone(value));
/** A synthetic content lane with a distinct id. */
const lane = (n: number) => ({ id: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `L${n}`, group: "started" });
/** Rules without their reasons, as copies. */
const strip = (rules: Array<Record<string, unknown>>) => rules.map(({ reason: _, ...rule }) => rule);

/** What the projection must be: the source head with exactly publishedBy, agents and every reason deleted. */
function expectedProjection(head: Record<string, any>): Record<string, unknown> {
  const copy = structuredClone(head);
  delete copy.publishedBy;
  const policy = copy.policy;
  if (policy) {
    delete policy.agents;
    dropReasons(policy.rules);
    for (const fragment of policy.fragments ?? []) dropReasons(fragment.rules);
    for (const binding of policy.laneBindings ?? []) dropReasons(binding.rules);
    for (const transition of policy.transitions ?? []) dropReasons(transition.rules);
  }
  return copy;
}

function traceFree(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
  for (const key of OMITTED_KEYS) expect(text).not.toContain(key);
}

/** The error `readWorkflowPolicyAnswer` throws for `body`, or null when it parses. */
function refusal(body: unknown, projectId = DEMO_PROJECT): Error | null {
  try {
    readWorkflowPolicyAnswer(body, projectId);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The DEMO answer after `change` mutates its head. */
function mutated(change: (head: Record<string, any>) => void): unknown {
  const answer = demoAnswer();
  change(answer.head);
  return answer;
}

describe("the workflow-policy parse", () => {
  it("accepts InferOps' DEMO answer and an unconfigured head", () => {
    expect(refusal(demoAnswer())).toBeNull();
    expect(refusal({
      head: {
        projectId: ENG_PROJECT, workflow: "content", configured: false, revision: "0", policy: null,
        compiledHash: null, legacyUpgraded: false,
      },
    }, ENG_PROJECT)).toBeNull();
  });

  const unknownKeyAt: Array<[string, (head: Record<string, any>) => void]> = [
    ["head", h => { h.extra = 1; }],
    ["policy", h => { h.policy.extra = 1; }],
    ["lane", h => { h.policy.lanes[0].extra = 1; }],
    ["fragment", h => { h.policy.fragments[0].extra = 1; }],
    ["fragment rule", h => { h.policy.fragments[0].rules[0].extra = 1; }],
    ["lane binding", h => { h.policy.laneBindings[0].extra = 1; }],
    ["binding rule", h => { h.policy.laneBindings[0].rules[0].extra = 1; }],
    ["top-level rule", h => { h.policy.rules[0].extra = 1; }],
    ["subject", h => { h.policy.rules[0].subjects[0].extra = 1; }],
    ["guard", h => { h.policy.laneBindings[0].guards[2].extra = 1; }],
    ["transition", h => { h.policy.transitions[0].extra = 1; }],
    ["transition rule", h => { h.policy.transitions[0].rules[0].extra = 1; }],
    ["transition subject", h => { h.policy.transitions[0].subjects[1].extra = 1; }],
    ["agent", h => { h.policy.agents[0].extra = 1; }],
  ];
  it.each(unknownKeyAt)("refuses an unknown key on a %s", (_, change) => {
    expect(refusal(mutated(change))?.message).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
  });

  const badValues: Array<[string, (head: Record<string, any>) => void]> = [
    ["an envelope key", h => void h],
    ["schemaVersion 3", h => { h.policy.schemaVersion = 3; }],
    ["schemaVersion '2'", h => { h.policy.schemaVersion = "2"; }],
    ["a software head", h => { h.workflow = "software"; }],
    ["a software policy", h => { h.policy.workflow = "software"; }],
    ["another workflow", h => { h.workflow = "release"; }],
    ["an unknown action", h => { h.policy.rules[0].actions.push("delete"); }],
    ["an unknown effect", h => { h.policy.rules[1].effect = "maybe"; }],
    ["an unknown principal kind", h => { h.policy.rules[1].subjects[0].kind = "robot"; }],
    ["an unknown lane group", h => { h.policy.lanes[0].group = "later"; }],
    ["an unknown guard kind", h => { h.policy.laneBindings[0].guards[2].kind = "full-moon"; }],
    ["an unknown required field", h => { h.policy.laneBindings[0].guards[0].field = "color"; }],
    ["an unknown actor kind", h => { h.policy.laneBindings[0].guards[1].actorKind = "robot"; }],
    ["a subject with two keys", h => { h.policy.rules[0].subjects[0] = { role: "owner", kind: "user" }; }],
    ["an empty subject", h => { h.policy.rules[0].subjects[0] = {}; }],
    ["a principal id that is not a uuid", h => { h.policy.laneBindings[0].rules[0].subjects[0].principalId = "u-1"; }],
    ["an empty role", h => { h.policy.rules[0].subjects[0].role = ""; }],
    ["a 41-character role", h => { h.policy.rules[0].subjects[0].role = "r".repeat(41); }],
    ["a rule id that is not a slug", h => { h.policy.rules[0].id = "Owners_All"; }],
    ["a use id that is not a slug", h => { h.policy.laneBindings[0].use = ["Reviewers"]; }],
    ["a lane id that is not a uuid", h => { h.policy.lanes[0].id = "ideas"; }],
    ["an entry lane of '*'", h => { h.policy.entryLaneId = "*"; }],
    ["a transition end that is not a lane", h => { h.policy.transitions[0].to = "published"; }],
    ["an empty lane name", h => { h.policy.lanes[0].name = "   "; }],
    ["an 81-character lane name", h => { h.policy.lanes[0].name = "n".repeat(81); }],
    ["a fragment version 0", h => { h.policy.fragments[0].version = 0; }],
    ["a fractional fragment version", h => { h.policy.fragments[0].version = 1.5; }],
    ["an unsafe fragment version", h => { h.policy.fragments[0].version = 2 ** 53; }],
    ["a revision that is not decimal", h => { h.revision = "3a"; }],
    ["a numeric revision", h => { h.revision = 3; }],
    ["an uppercase compiledHash", h => { h.compiledHash = h.compiledHash.toUpperCase(); }],
    ["a short compiledHash", h => { h.compiledHash = "abc"; }],
    ["a publishedAt with an offset", h => { h.publishedAt = "2026-10-01T12:00:00+02:00"; }],
    ["a publishedAt on no date", h => { h.publishedAt = "2026-02-30T12:00:00Z"; }],
    ["a publishedBy that is not a uuid", h => { h.publishedBy = "owner"; }],
    ["a string configured", h => { h.configured = "true"; }],
    ["a null optional array", h => { h.policy.fragments = null; }],
    ["a lanes object", h => { h.policy.lanes = {}; }],
  ];
  it.each(badValues)("refuses %s", (name, change) => {
    const body = name === "an envelope key" ? { ...demoAnswer(), extra: true } : mutated(change);
    expect(refusal(body)?.message).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
  });

  it("validates the omitted fields before dropping them (R1 N1)", () => {
    for (const change of [
      (h: Record<string, any>) => { h.policy.rules[0].reason = "   "; },
      (h: Record<string, any>) => { h.policy.fragments[0].rules[0].reason = "x".repeat(501); },
      (h: Record<string, any>) => { h.policy.laneBindings[0].rules[0].reason = 7; },
      (h: Record<string, any>) => { h.policy.transitions[0].rules[0].reason = null; },
      (h: Record<string, any>) => { h.policy.agents[0].responsibility = ""; },
      (h: Record<string, any>) => { h.policy.agents[0].responsibility = "r".repeat(4001); },
      (h: Record<string, any>) => { h.policy.agents[0].principalId = "agent-1"; },
      (h: Record<string, any>) => { h.policy.agents = Array.from({ length: 51 }, () => h.policy.agents[0]); },
    ]) {
      expect(refusal(mutated(change))?.message).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    }
    // The limits themselves, measured after trimming as the source does, still pass.
    expect(refusal(mutated(h => { h.policy.rules[0].reason = ` ${"x".repeat(500)} `; }))).toBeNull();
    expect(refusal(mutated(h => { h.policy.agents[0].responsibility = "r".repeat(4000); }))).toBeNull();
  });

  it("enforces the guard refinement: field exactly for required-field, actorKind exactly for actor-kind", () => {
    for (const guard of [
      { kind: "required-field" }, { kind: "not-blocked", field: "title" }, { kind: "actor-kind" },
      { kind: "lease-holder", actorKind: "user" }, { kind: "required-field", field: "title", actorKind: "user" },
    ]) {
      expect(refusal(mutated(h => { h.policy.laneBindings[0].guards = [guard]; })), JSON.stringify(guard))
        .not.toBeNull();
    }
    expect(refusal(mutated(h => {
      h.policy.transitions[0].guards = [{ kind: "required-field", field: "refs" }, { kind: "actor-kind", actorKind: "system" }];
    }))).toBeNull();
  });

  it("enforces every source array cap, and each one's floor (R1 N2)", () => {
    const rule = { id: "r", effect: "allow", subjects: [{ role: "owner" }], actions: ["read"] };
    const caps: Array<[string, (h: Record<string, any>) => void, (h: Record<string, any>) => void]> = [
      ["lanes 40", h => { h.policy.lanes = Array.from({ length: 40 }, (_, n) => lane(n + 100)); },
        h => { h.policy.lanes = Array.from({ length: 41 }, (_, n) => lane(n + 100)); }],
      ["lanes 2", h => { h.policy.lanes = h.policy.lanes.slice(0, 2); },
        h => { h.policy.lanes = h.policy.lanes.slice(0, 1); }],
      ["top-level rules 200", h => { h.policy.rules = copies(200, rule); }, h => { h.policy.rules = copies(201, rule); }],
      ["fragment rules 100", h => { h.policy.fragments[0].rules = copies(100, rule); },
        h => { h.policy.fragments[0].rules = copies(101, rule); }],
      ["binding rules 100", h => { h.policy.laneBindings[0].rules = copies(100, rule); },
        h => { h.policy.laneBindings[0].rules = copies(101, rule); }],
      ["transition rules 50", h => { h.policy.transitions[0].rules = copies(50, rule); },
        h => { h.policy.transitions[0].rules = copies(51, rule); }],
      ["transitions 400", h => { h.policy.transitions = copies(400, h.policy.transitions[1]); },
        h => { h.policy.transitions = copies(401, h.policy.transitions[1]); }],
      ["fragments 50", h => { h.policy.fragments = copies(50, h.policy.fragments[0]); },
        h => { h.policy.fragments = copies(51, h.policy.fragments[0]); }],
      ["lane bindings 40", h => { h.policy.laneBindings = copies(40, h.policy.laneBindings[0]); },
        h => { h.policy.laneBindings = copies(41, h.policy.laneBindings[0]); }],
      ["guards 20", h => { h.policy.laneBindings[0].guards = copies(20, { kind: "not-blocked" }); },
        h => { h.policy.laneBindings[0].guards = copies(21, { kind: "not-blocked" }); }],
      ["use 20", h => { h.policy.laneBindings[0].use = copies(20, "reviewers"); },
        h => { h.policy.laneBindings[0].use = copies(21, "reviewers"); }],
      ["rule subjects 1-50", h => { h.policy.rules[0].subjects = copies(50, { role: "owner" }); },
        h => { h.policy.rules[0].subjects = []; }],
      ["rule subjects 50", h => { h.policy.rules[0].subjects = copies(50, { role: "owner" }); },
        h => { h.policy.rules[0].subjects = copies(51, { role: "owner" }); }],
      ["transition subjects 0-50", h => { h.policy.transitions[0].subjects = copies(50, { role: "owner" }); },
        h => { h.policy.transitions[0].subjects = copies(51, { role: "owner" }); }],
      ["actions 1-13", h => { h.policy.rules[0].actions = copies(13, "read"); },
        h => { h.policy.rules[0].actions = []; }],
      ["actions 13", h => { h.policy.rules[0].actions = copies(13, "read"); },
        h => { h.policy.rules[0].actions = copies(14, "read"); }],
    ];
    for (const [name, atCap, overCap] of caps) {
      expect(refusal(mutated(atCap)), `${name} at its limit`).toBeNull();
      expect(refusal(mutated(overCap))?.message, `${name} past its limit`)
        .toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    }
  });

  it("refuses a head whose configured flag disagrees with the rest of it (R1 N5)", () => {
    const unconfigured = {
      projectId: DEMO_PROJECT, workflow: "content", configured: false, revision: "0", policy: null,
      compiledHash: null, legacyUpgraded: false,
    };
    const ambiguous: Array<Record<string, unknown>> = [
      { ...unconfigured, configured: true },
      { ...unconfigured, revision: "1" },
      { ...unconfigured, compiledHash: "a".repeat(64) },
      { ...unconfigured, publishedAt: "2026-10-01T12:00:00Z" },
      { ...unconfigured, publishedBy: "c0b1b500-0000-4000-8000-0000000b1b51" },
      { ...unconfigured, policy: demoAnswer().head.policy },
      { ...demoAnswer().head, configured: false },
      { ...demoAnswer().head, compiledHash: null },
      { ...demoAnswer().head, policy: null },
    ];
    for (const head of ambiguous) {
      expect(refusal({ head })?.message, JSON.stringify(Object.keys(head))).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    }
    // A configured head may lack its publisher (InferOps falls back to updated_by, which can be null).
    expect(refusal(mutated(h => { delete h.publishedBy; }))).toBeNull();
  });

  it("refuses an answer about another project than the one asked for", () => {
    expect(refusal(demoAnswer(), ENG_PROJECT)?.message).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    // The comparison ignores case, as InferOps' ids do.
    expect(refusal(demoAnswer(), DEMO_PROJECT.toUpperCase())).toBeNull();
  });

  it("refuses what is not a workflow.get answer at all, and never names a value", () => {
    for (const body of [undefined, null, "head", 42, [], {}, { head: null }, { head: [] }]) {
      const error = refusal(body);
      expect(error?.message, JSON.stringify(body)).toBe(`UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    }
    // Every refusal above carries the one fixed message: none repeats a canary or a key.
    traceFree(WORKFLOW_POLICY_UNREADABLE_MESSAGE);
  });
});

describe("the workflow-policy projection", () => {
  it("is the source head with exactly publishedBy, agents and every rule reason deleted, in source order", () => {
    const source = demoAnswer();
    const projected = projectWorkflowHead(readWorkflowPolicyAnswer(source, DEMO_PROJECT));
    const expected = expectedProjection(demoAnswer().head);
    expect(projected).toEqual(expected);
    // Order too: the same keys in the same order at every level, and every array in source order.
    expect(JSON.stringify(projected)).toBe(JSON.stringify(expected));
    traceFree(JSON.stringify(projected));
  });

  it("keeps every authoritative rule and subject in all four rule locations, and every transition subject", () => {
    const projected = projectWorkflowHead(readWorkflowPolicyAnswer(demoAnswer(), DEMO_PROJECT));
    const source = demoAnswer().head.policy;
    const policy = projected.policy!;
    expect(policy.rules).toEqual(strip(source.rules));
    expect(policy.fragments![0]!.rules).toEqual(strip(source.fragments[0].rules));
    expect(policy.laneBindings![0]!.rules).toEqual(strip(source.laneBindings[0].rules));
    expect(policy.transitions![0]!.rules).toEqual(strip(source.transitions[0].rules));
    expect(policy.transitions!.map(t => t.subjects)).toEqual(source.transitions.map((t: any) => t.subjects));
    // The {principalId}, {kind} and {role} subjects are all still there.
    const subjects = JSON.stringify(policy);
    expect(subjects).toContain('{"principalId":"40000000-0000-4000-8000-000000000004"}');
    expect(subjects).toContain('{"principalId":"40000000-0000-4000-8000-000000000002"}');
    expect(subjects).toContain('{"kind":"service_account"}');
    expect(subjects).toContain('{"role":"owner"}');
    // compiledHash is InferOps' value, passed on unchanged; nothing hashes the projection.
    expect(projected.compiledHash).toBe(demoAnswer().head.compiledHash);
  });

  it("keeps optional keys absent when absent and present when present, empty arrays included", () => {
    const answer = mutated(h => {
      delete h.policy.fragments;
      h.policy.laneBindings[0].rules = [];
      delete h.policy.laneBindings[0].use;
      delete h.publishedAt;
    }) as { head: WorkflowHeadRecord };
    const projected = projectWorkflowHead(readWorkflowPolicyAnswer(answer, DEMO_PROJECT));
    expect(Object.hasOwn(projected.policy!, "fragments")).toBe(false);
    expect(Object.hasOwn(projected, "publishedAt")).toBe(false);
    expect(projected.policy!.laneBindings![0]!.rules).toEqual([]);
    expect(Object.hasOwn(projected.policy!.laneBindings![0]!, "use")).toBe(false);
    expect(projected).toEqual(expectedProjection((answer as { head: Record<string, any> }).head));
  });

  it("shares nothing with the source: changing the projection leaves the record intact", () => {
    const record = readWorkflowPolicyAnswer(demoAnswer(), DEMO_PROJECT);
    const projected = projectWorkflowHead(record);
    projected.policy!.lanes[0]!.name = "changed";
    projected.policy!.rules![0]!.subjects.push({ role: "admin" });
    expect(record.policy!.lanes[0]!.name).toBe("Ideas");
    expect(record.policy!.rules![0]!.subjects).toHaveLength(1);
  });

  it("passes an unconfigured head through as InferOps sent it", () => {
    const head = {
      projectId: ENG_PROJECT, workflow: "content", configured: false, revision: "0", policy: null,
      compiledHash: null, legacyUpgraded: false,
    };
    expect(projectWorkflowHead(readWorkflowPolicyAnswer({ head }, ENG_PROJECT))).toEqual(head);
  });
});

// ---------------------------------------------------------------------------
// The binding and session, over the mock's demo answers.

type Vars = { INFEROPS_ENABLED?: string; INFEROPS_WORKFLOW_POLICY_ENABLED?: string };
const vars = env as unknown as Vars;
function set(name: keyof Vars, value: string | undefined) {
  if (value === undefined) delete vars[name];
  else vars[name] = value;
}
beforeEach(() => set("INFEROPS_WORKFLOW_POLICY_ENABLED", "true"));
afterEach(() => {
  set("INFEROPS_ENABLED", undefined);
  set("INFEROPS_WORKFLOW_POLICY_ENABLED", undefined);
});

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** A fresh demo account's workflow-policy binding for `projectKey`, its mock data and a session. */
function setup(projectKey = "DEMO", accountId: string = crypto.randomUUID()) {
  const props: WorkflowPolicyProps = { accountId, host: "demo.local", projectKey };
  const hooks = env.TEST_HOOKS.getByName(accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${accountId}`);
  return { props, hooks, mock, session: hooks.startWorkflowPolicySession(props) };
}

describe("the workflow-policy resource kind", () => {
  it("parses its grammar on the shared project parser, as an InferOS-minted URL", () => {
    expect(parseProjectWorkflowUrl("inferops://acme.operations/project/workflow/ENG")).toEqual({
      host: "acme.operations", tenant: "acme", workspace: "operations", projectKey: "ENG",
    });
    expect(projectWorkflowUrl({ host: "demo.local", projectKey: "DEMO" })).toBe(WORKFLOW_URL);
    expect(resourceKind(WORKFLOW_URL)).toBe("workflow");
    // The neighbouring InferOps widget is another thing, and no kind of this gatekeeper.
    expect(resourceKind("inferops://acme.operations/project/workflow-chart/ENG")).toBeNull();
    for (const url of [
      "inferops://acme/project/workflow/ENG", "inferops://acme.ops:1/project/workflow/ENG",
      "inferops://acme.ops/project/workflow/eng", "inferops://acme.ops/project/workflow/ENG/extra",
      "inferops://acme.ops/project/workflow/ENG?all=1", "inferops://acme.ops/project/board/ENG",
      "inferops://acme.ops/project/workflow-chart/ENG",
    ]) {
      expect(() => parseProjectWorkflowUrl(url), url).toThrow(/project\/workflow\/<KEY>/);
    }
  });

  it("is private to Operate: the resource is excluded from operate chat, and the board pattern never matches it", () => {
    expect(PROJECT_WORKFLOW_RESOURCE).toMatchObject({ urlPattern: WORKFLOW_PATTERN, excludeFromOperateChat: true });
    expect(matchesResourceUrlPattern(WORKFLOW_PATTERN, WORKFLOW_URL)).toBe(true);
    expect(matchesResourceUrlPattern(PROJECT_BOARD_RESOURCE.urlPattern, WORKFLOW_URL)).toBe(false);
  });

  it("is offered, pickable and bindable only while workflow policies are on", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.supportedPatterns(account)).toContain(WORKFLOW_PATTERN);
    expect((await hooks.supportedResources(account)).find(r => r.urlPattern === WORKFLOW_PATTERN))
      .toMatchObject({ excludeFromOperateChat: true });
    expect(await hooks.configuratorFor(account, WORKFLOW_PATTERN)).toBeNull();
    expect(await hooks.bindAccount("on", account, WORKFLOW_URL)).toBeNull();
    expect(await hooks.describeBound("on")).toMatchObject({
      url: WORKFLOW_URL, tsType: "InferOpsWorkflowPolicySession",
    });

    set("INFEROPS_WORKFLOW_POLICY_ENABLED", undefined);
    expect(await hooks.supportedPatterns(account)).not.toContain(WORKFLOW_PATTERN);
    expect(await hooks.configuratorFor(account, WORKFLOW_PATTERN)).toContain("Unsupported");
    expect(await hooks.bindAccount("off", account, WORKFLOW_URL)).toContain("DISABLED");
    set("INFEROPS_WORKFLOW_POLICY_ENABLED", "false");
    expect(await hooks.bindAccount("false", account, WORKFLOW_URL)).toContain("DISABLED");

    // Off for InferOps as a whole is off for workflow policies too, whatever their switch says.
    set("INFEROPS_WORKFLOW_POLICY_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await hooks.supportedPatterns(account)).not.toContain(WORKFLOW_PATTERN);
    expect(await hooks.bindAccount("inferops-off", account, WORKFLOW_URL)).toContain("DISABLED");
  });

  it("routes a workflow URL to its own kind before the board path, with the switch on or off (R1 N3)", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.boundResourcePattern(account, WORKFLOW_URL)).toBe(WORKFLOW_PATTERN);
    expect(await hooks.bindAccount("routed", account, WORKFLOW_URL)).toBeNull();
    expect(await hooks.describeBound("routed")).toMatchObject({ tsType: "InferOpsWorkflowPolicySession" });
    expect(await hooks.describeBound("routed")).not.toMatchObject({ tsType: "InferOpsProjectSession" });
    set("INFEROPS_WORKFLOW_POLICY_ENABLED", undefined);
    const off = await hooks.boundResourcePattern(account, WORKFLOW_URL);
    expect(off).toMatch(/^refused: .*DISABLED/);
    expect(off).not.toContain(PROJECT_BOARD_RESOURCE.urlPattern);
    // The board kind is unaffected either way.
    expect(await hooks.boundResourcePattern(account, "inferops://demo.local/project/board/DEMO"))
      .toBe(PROJECT_BOARD_RESOURCE.urlPattern);
  });

  it("refuses a missing project and a host it does not serve with the one message, never the stopgap", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.bindAccount("missing", account, "inferops://demo.local/project/workflow/NOPE"))
      .toBe("No InferOps workflow policy is available to you on demo.local.");
    expect(await hooks.bindAccount("elsewhere", account, "inferops://acme.operations/project/workflow/DEMO"))
      .toBe("No InferOps workflow policy is available to you on acme.operations.");
  });

  it("never serves the stopgap connection, even where it is configured for the named workspace", async () => {
    const stopgap = env as unknown as Record<string, string | undefined>;
    const names = ["INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"];
    const saved = names.map(name => stopgap[name]);
    Object.assign(stopgap, {
      INFEROPS_BASE_URL: "http://127.0.0.1:9/never", INFEROPS_API_TOKEN: "iex_stopgap-not-for-workflow",
      INFEROPS_WORKSPACE_ID: "90000000-0000-4000-8000-000000000001", INFEROPS_WORKSPACE_SLUG: "operations",
    });
    try {
      const { hooks } = setup();
      // An account with no InferOps sign-in: refused before any request, with the one message (a
      // request to the stopgap's unroutable API would have been UNAVAILABLE instead).
      expect(await hooks.bindAccount("stopgap", { accountId: crypto.randomUUID() },
        "inferops://acme.operations/project/workflow/DEMO"))
        .toBe("No InferOps workflow policy is available to you on acme.operations.");
      const session = hooks.startWorkflowPolicySession({
        accountId: crypto.randomUUID(), host: "acme.operations", projectKey: "DEMO",
        workspaceId: "90000000-0000-4000-8000-000000000001",
      });
      expect(await failure(session.readWorkflowPolicy()))
        .toBe("InferOpsError: NOT_FOUND: No such workflow policy is available to you.");
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete stopgap[name];
        else stopgap[name] = saved[index];
      });
    }
  });

  it("probes without an observation", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    const before = (await hooks.log()).observations.length;
    expect(await hooks.bindAccount("probe", account, WORKFLOW_URL)).toBeNull();
    expect((await hooks.log()).observations.length).toBe(before);
  });
});

describe("the workflow-policy session", () => {
  it("reads the projection of InferOps' head, and observes it without a subject, id, rule, reason or lane", async () => {
    const { session, hooks } = setup();
    const result = await session.readWorkflowPolicy();
    expect(result).toEqual(expectedProjection(demoAnswer().head));
    traceFree(JSON.stringify(result));
    const log = await hooks.log();
    expect(log.observations).toEqual(["Read InferOps workflow policy"]);
    expect(log.actions).toEqual([]);
    const [text] = log.observationTexts;
    expect(text).toBe("Read the configured workflow policy of DEMO on demo.local at revision 3.");
    traceFree(text!);
    for (const shown of ["Ideas", "Drafting", "owners-all", "owner", "40000000", "service_account", "reviewers"]) {
      expect(text).not.toContain(shown);
    }
  });

  it("reads an unconfigured project as InferOps answers it", async () => {
    const { session, hooks } = setup("ENG");
    expect(await session.readWorkflowPolicy()).toEqual({
      projectId: ENG_PROJECT, workflow: "content", configured: false, revision: "0", policy: null,
      compiledHash: null, legacyUpgraded: false,
    });
    expect((await hooks.log()).observationTexts).toEqual([
      "Read the unconfigured workflow policy of ENG on demo.local at revision 0.",
    ]);
  });

  it("reads fresh every time: a policy republished between reads shows its new revision", async () => {
    const { session, mock } = setup();
    expect((await session.readWorkflowPolicy()).revision).toBe("3");
    const next = demoAnswer();
    next.head.revision = "4";
    next.head.policy.rules[1].effect = "allow";
    await mock.setWorkflowAnswers({ DEMO: next });
    const read = await session.readWorkflowPolicy();
    expect(read.revision).toBe("4");
    expect(read.policy!.rules![1]!.effect).toBe("allow");
  });

  it("fails a malformed answer closed: UNAVAILABLE, no data, no value, no observation", async () => {
    const { session, mock, hooks } = setup();
    const broken = demoAnswer();
    broken.head.policy.transitions[0].rules[0].unexpected = "canary-unexpected-key-value";
    await mock.setWorkflowAnswers({ DEMO: broken });
    const error = await failure(session.readWorkflowPolicy());
    expect(error).toBe(`InferOpsError: UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
    expect(error).not.toContain("canary-unexpected-key-value");
    traceFree(error);
    expect((await hooks.log()).observations).toEqual([]);
  });

  it("refuses a project that has gone with the one NOT_FOUND", async () => {
    const { hooks } = setup();
    const session = hooks.startWorkflowPolicySession({ accountId: crypto.randomUUID(), host: "demo.local", projectKey: "GONE" });
    expect(await failure(session.readWorkflowPolicy())).toBe("InferOpsError: NOT_FOUND: No such workflow policy is available to you.");
  });

  it("stops with the switch and resumes with it, and ends with the account", async () => {
    const { session, props, hooks } = setup();
    set("INFEROPS_WORKFLOW_POLICY_ENABLED", "false");
    expect(await failure(session.readWorkflowPolicy())).toMatch(/DISABLED/);
    set("INFEROPS_WORKFLOW_POLICY_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await failure(session.readWorkflowPolicy())).toMatch(/DISABLED/);
    set("INFEROPS_ENABLED", undefined);
    expect((await session.readWorkflowPolicy()).revision).toBe("3");
    await hooks.revokeAccount({ accountId: props.accountId });
    expect(await failure(session.readWorkflowPolicy())).toMatch(/UNAUTHORIZED/);
  });
});

describe("the workflow-policy binding", () => {
  it("admits no collaborator, even one who could read the policy", async () => {
    const { props, hooks } = setup();
    expect(await hooks.addWorkflowPolicyObserver(props)).toContain("private to the person who connected it");
  });

  it("has no actions, auto-approves nothing, and describes itself as one project's policy", async () => {
    const { props, hooks } = setup();
    const results = await hooks.workflowPolicyActions(props);
    expect(results).toHaveLength(3);
    for (const result of results) expect(result).toContain("read-only");
    expect(await hooks.describeWorkflowPolicy(props)).toMatchObject({
      url: WORKFLOW_URL, suggestedBindingName: "INFEROPS_WORKFLOW_POLICY",
      tsType: "InferOpsWorkflowPolicySession", autoApprovable: [],
    });
  });
});

// The Workflow policy client in jsdom, against a fake `gadget` whose answers the test releases one by
// one: what each state shows, that every part of the policy is drawn as written and as text, that it
// is read-only, that fields outside the projection are never drawn, and that only the latest load
// is drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadPolicyResult, WorkflowPolicyHead } from "../files/lib/protocol.ts";

const MARKUP = `<img src="x" onerror="globalThis.pwned = true">`;
const IDEAS = "20000000-0000-4000-8000-000000000007";
const DRAFTING = "20000000-0000-4000-8000-000000000008";
const PUBLISHED = "20000000-0000-4000-8000-000000000009";
const NAMED = "40000000-0000-4000-8000-000000000004";

/** A configured head shaped as the gatekeeper projects it (no reasons, agents or publisher). */
function configured(revision = "3", laneName = "Ideas"): WorkflowPolicyHead {
  return {
    projectId: "10000000-0000-4000-8000-000000000001",
    workflow: "content",
    configured: true,
    revision,
    policy: {
      schemaVersion: 2,
      workflow: "content",
      entryLaneId: IDEAS,
      lanes: [
        { id: IDEAS, name: laneName, group: "backlog" },
        { id: DRAFTING, name: "Drafting", group: "started" },
        { id: PUBLISHED, name: "Published", group: "completed" },
      ],
      fragments: [{
        id: "reviewers", version: 1,
        rules: [{ id: "reviewers-comment", effect: "allow", subjects: [{ role: "viewer" }], actions: ["read", "comment"] }],
      }],
      laneBindings: [{
        laneId: DRAFTING, use: ["reviewers"],
        rules: [{ id: "writer-drafts", effect: "allow", subjects: [{ principalId: NAMED }, { kind: "service_account" }], actions: ["edit", "claim"] }],
        guards: [{ kind: "required-field", field: "description" }, { kind: "actor-kind", actorKind: "user" }, { kind: "not-blocked" }],
      }],
      rules: [
        { id: "owners-all", effect: "allow", subjects: [{ role: "owner" }], actions: ["read", "approve", "publish"] },
        { id: "no-agent-publish", effect: "deny", subjects: [{ kind: "service_account" }], actions: ["publish"] },
      ],
      transitions: [
        {
          id: "draft-to-published", from: DRAFTING, to: PUBLISHED, subjects: [{ role: "owner" }, { principalId: NAMED }],
          guards: [{ kind: "approval-ref" }],
          rules: [{ id: "publish-edge", effect: "allow", subjects: [{ role: "owner" }], actions: ["move-out", "move-in"] }],
        },
        { id: "back-to-ideas", from: "*", to: IDEAS, subjects: [] },
      ],
    },
    compiledHash: "0d6f2c3b9a8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e",
    legacyUpgraded: false,
    publishedAt: "2026-10-01T12:00:00.000Z",
  };
}
const UNCONFIGURED: WorkflowPolicyHead = {
  projectId: "10000000-0000-4000-8000-000000000002", workflow: "content", configured: false, revision: "0",
  policy: null, compiledHash: null, legacyUpgraded: false,
};
const ok = (head: WorkflowPolicyHead): LoadPolicyResult => ({ ok: true, head });

/** Loads the client; each `loadPolicy` call waits until the test answers it. */
async function start(...answers: LoadPolicyResult[]) {
  const pending: Array<(result: LoadPolicyResult) => void> = [];
  (globalThis as { gadget?: unknown }).gadget = {
    loadPolicy: () => new Promise<LoadPolicyResult>(resolve => pending.push(resolve)),
  };
  const loaded = import("../files/client.ts");
  await vi.waitFor(() => expect(pending.length).toBe(1));
  pending.shift()!(answers[0]!);
  await loaded;
  return {
    answer: async (result: LoadPolicyResult) => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!(result);
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    pending,
  };
}

const text = () => document.querySelector("main")!.textContent ?? "";
const reload = () => (document.querySelector("header button") as HTMLButtonElement).click();
/** Every table's rows, as cell text. */
const tableRows = (label: string) =>
  [...document.querySelector(`table[aria-label="${label}"]`)!.querySelectorAll("tbody tr")]
    .map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent));

beforeEach(() => {
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
afterEach(() => {
  delete (globalThis as { gadget?: unknown }).gadget;
});

describe("InferOps Workflow policy client", () => {
  it("draws the head, with the source compiled hash labelled as source metadata", async () => {
    await start(ok(configured()));
    expect(document.querySelector("h1")!.textContent).toBe("Workflow policy");
    expect(document.querySelector("header .meta")!.textContent)
      .toBe("Revision 3 of project 10000000-0000-4000-8000-000000000001");
    const terms = [...document.querySelectorAll("dl.head dt")].map(dt => dt.textContent);
    const values = [...document.querySelectorAll("dl.head dd")].map(dd => dd.textContent);
    expect(Object.fromEntries(terms.map((term, i) => [term, values[i]]))).toEqual({
      Project: "10000000-0000-4000-8000-000000000001",
      Workflow: "content",
      Revision: "3",
      Published: "Yes",
      "Published at": "2026-10-01T12:00:00.000Z",
      "Source compiled hash": "0d6f2c3b9a8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e",
    });
    expect(text()).toContain("The source compiled hash is InferOps' hash of its compiled policy, not of this view.");
    expect(text()).toContain("This view does not work out who may do what.");
  });

  it("draws every lane, rule, fragment, binding and transition as written, in order", async () => {
    await start(ok(configured()));
    expect(tableRows("Lanes")).toEqual([
      ["1", "Ideas (entry)", "backlog", IDEAS], ["2", "Drafting", "started", DRAFTING], ["3", "Published", "completed", PUBLISHED],
    ]);
    expect(tableRows("Rules")).toEqual([
      ["owners-all", "Allow read, approve, publish", "role owner"],
      ["no-agent-publish", "Deny publish", "every agent"],
    ]);
    expect(tableRows("Rules of fragment reviewers")).toEqual([["reviewers-comment", "Allow read, comment", "role viewer"]]);
    expect(text()).toContain("Fragment reviewers, version 1");
    expect(text()).toContain("Drafting, uses reviewers; guards: required field: description; actor must be: person; not-blocked");
    expect(tableRows("Rules bound to Drafting")).toEqual([["writer-drafts", "Allow edit, claim", `principal ${NAMED}, every agent`]]);
    expect(tableRows("Transitions")).toEqual([
      ["draft-to-published", "Drafting", "Published", `role owner, principal ${NAMED}`, "approval-ref"],
      ["back-to-ideas", "Any lane", "Ideas", "Anyone the lanes' rules allow", "None"],
    ]);
    expect(tableRows("Rules on transition draft-to-published")).toEqual([["publish-edge", "Allow move-out, move-in", "role owner"]]);
  });

  it("draws text, never markup, and offers no control but Reload", async () => {
    await start(ok(configured("3", MARKUP)));
    expect(tableRows("Lanes")[0]![1]).toBe(`${MARKUP} (entry)`);
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    expect([...document.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Reload"]);
    expect(document.querySelectorAll("input, select, textarea, form, a")).toHaveLength(0);
  });

  it("never draws a field outside the projection, even if one arrived", async () => {
    // Negative probe: the gatekeeper already leaves these out; the client draws named fields only.
    const head = configured() as unknown as Record<string, any>;
    head.publishedBy = "c0b1b500-0000-4000-8000-0000000b1b51";
    head.policy.agents = [{ principalId: "c0a9e700-0000-4000-8000-0000000a9e71", responsibility: "canary-agent-2e7b" }];
    head.policy.rules[0].reason = "canary-top-reason-3f9a";
    head.policy.fragments[0].rules[0].reason = "canary-fragment-reason-5d1e";
    head.policy.laneBindings[0].rules[0].reason = "canary-binding-reason-8b2c";
    head.policy.transitions[0].rules[0].reason = "canary-transition-reason-6c4d";
    await start(ok(head as WorkflowPolicyHead));
    const shown = document.body.textContent ?? "";
    for (const canary of ["canary", "c0b1b500", "c0a9e700"]) expect(shown).not.toContain(canary);
    expect(tableRows("Rules")[0]).toEqual(["owners-all", "Allow read, approve, publish", "role owner"]);
  });

  it("shows an unconfigured project, the empty sections, and every refusal, each without a policy", async () => {
    const view = await start(ok(UNCONFIGURED));
    expect(text()).toContain("No workflow policy is published");
    expect(text()).toContain("revision 0");
    expect(document.querySelector("table")).toBeNull();

    const sparse = configured();
    sparse.policy = { ...sparse.policy!, fragments: undefined, laneBindings: [], rules: undefined, transitions: undefined };
    reload();
    await view.answer(ok(sparse));
    for (const none of ["No top-level rules.", "No fragments.", "No lane bindings.", "No transitions."]) {
      expect(text()).toContain(none);
    }

    for (const [result, shown] of [
      [{ ok: false, reason: "not-connected" }, "No InferOps workflow policy connected"],
      [{ ok: false, reason: "disabled", message: "off" }, "InferOps workflow policies are turned off"],
      [{ ok: false, reason: "unavailable", message: "No such workflow policy is available to you." }, "This workflow policy is not available to you"],
      [{ ok: false, reason: "error", message: "InferOps could not be reached." }, "The workflow policy could not be loaded"],
    ] as Array<[LoadPolicyResult, string]>) {
      reload();
      await view.answer(result);
      expect(text()).toContain(shown);
      expect(document.querySelector("table")).toBeNull();
      expect(document.querySelector("h1")!.textContent).toBe("InferOps workflow policy");
      expect(document.querySelector("header .meta")!.textContent).toBe("");
    }
  });

  it("clears the policy while loading and on a refusal, and shows it again on a reload that succeeds", async () => {
    const view = await start(ok(configured()));
    expect(text()).toContain("owners-all");
    reload();
    expect(text()).toContain("Loading the workflow policy");
    expect(text()).not.toContain("owners-all");
    await view.answer({ ok: false, reason: "unavailable", message: "No such workflow policy is available to you." });
    expect(text()).not.toContain("owners-all");
    (document.querySelector("main button") as HTMLButtonElement).click();
    await view.answer(ok(configured("4")));
    expect(document.querySelector("header .meta")!.textContent).toContain("Revision 4");
  });

  it("never draws a late answer to an earlier load", async () => {
    const view = await start(ok(configured("3")));
    const button = document.querySelector("header button") as HTMLButtonElement;
    reload();
    expect(button.disabled).toBe(true);
    // Two loads in flight at once, which the disabled button otherwise prevents: the older one
    // (say, for a binding since replaced) answers last and must not be drawn.
    button.disabled = false;
    reload();
    await vi.waitFor(() => expect(view.pending.length).toBe(2));
    const [older, newer] = [view.pending[0]!, view.pending[1]!];
    newer(ok(configured("5", "NEW-LANE")));
    await new Promise(resolve => setTimeout(resolve, 0));
    older(ok(configured("4", "OLD-LANE")));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("header .meta")!.textContent).toContain("Revision 5");
    expect(text()).toContain("NEW-LANE");
    expect(text()).not.toContain("OLD-LANE");
  });
});

// FAC-134 capability 2: a person's personal workflow, end to end through two real Overseer Durable
// Objects: S, the person's operate session, where the workflow is created and run by their own
// approval of an action that declared it; and W, a console workspace whose published console offers
// the person a command (FAC-14 K2), bound by its builder to W's InferOps board connection.
//
// Created only once every step's console workspace says, for this person now, that the command is
// one its console offers them at that revision, on the connection fixed at publication, in their own
// company, with an input that fits (r1's obligations 1 and 2). Run only in the owner's own session,
// for their own workflow (obligation 3). Each step is requested through W's kernel-only entry
// (requestPersonalWorkflowStep), which only S's runner reaches, vouched by S, and which makes every
// FAC-14 check but the open page (the lead's D1 (B)); it reads the issue's current revision (D2) and
// places a pending, manual-only request the console's builders decide. The outcome reaches the
// approved action's gatekeeper as `kind: "personal-workflow"`, `succeeded` meaning the requests were
// placed (D3).
//
// The user Durable Objects and both gatekeeper facets are fakes; the kernel between them is real.
// Synthetic bounded fixtures only.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ApprovedEffects, ApprovedRunOutcome } from "@gadgets/workshop-shared/gatekeeper";
import type { OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import {
  consoleCommandRef, personalWorkflowRef, PERSONAL_WORKFLOW_LIMITS,
} from "@gadgets/workshop-shared/personal-workflow";
import { autoApprovalRule } from "../src/auto-approval";
import { WorkspaceConsoleStore } from "../src/console-store";
import { COMMAND_OTHER_COMPANY, NO_CONSOLE_TOOL_ACCESS, UNVERIFIED_CONSOLE_TOOL_CALLER } from "../src/console-tools";
import {
  PERSONAL_WORKFLOW_FIELD_LABEL, PERSONAL_WORKFLOW_RUN_FIELD_LABEL, type OverseerDurableObject,
} from "../src/overseer.js";
import { bumpAuthzGeneration } from "../src/sharing";
import { OPERATE_AGENT_TOOL_NAMES } from "../src/agent";
import { actionContextOf } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";
import { onlyExplicitAlarms } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const BUILDER = "builder";
const PERSON = "operator-profile";
const OTHER = "other-profile";
const uid = (profileId: string) => `${profileId}-user-id`;
const PROPOSER = 41;
const BOARD = 51;
const ISSUE = "40000000-0000-4000-8000-000000000001";
const DONE = "40000000-0000-4000-8000-000000000002";
const ISSUE_2 = "40000000-0000-4000-8000-000000000003";
const FLAGS = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CONSOLE_TOOLS: "true" };
const TOOLS = [
  { name: "moveIssue", description: "Ask to move an issue.", effect: "write", command: "inferops.issue.transition" },
  { name: "moveAgain", description: "Declared, never bound.", effect: "write", command: "inferops.issue.transition" },
];
const FILES = { "server.js": `export class Gadget {}\n`, "tools.json": JSON.stringify(TOOLS) };
const PERSON_RESOLVER = { type: "user" as const, id: PERSON, name: "Operator" };

const idOf = (name: string) => env.TEST_OVERSEER.idFromName(name).toString();
async function withImpl<T>(name: string, fn: (impl: any, instance: OverseerDurableObject) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name),
      async (instance: OverseerDurableObject) => fn((instance as any).impl, instance));
}

/** W's board, as its fake gatekeeper answers: the issue's revision now, and what it was asked. */
type Board = {
  revision: string; company: string | null; transitions: string[][]; reads: number;
  callers: any[]; onRead?: () => void;
  /** An issue whose read never answers (a gatekeeper that hangs, r1's LOW 1). */
  hangOn?: string;
};
/** Who W's fake user Durable Objects say each person is. */
type Person = { profileId: string; session: string | null; company: string };

let reported: [string, number, ApprovedRunOutcome][] = [];
afterEach(() => { reported = []; });
// Each test runs S's runner itself: workerd's own alarm would race it (see onlyExplicitAlarms).
beforeAll(() => onlyExplicitAlarms());

/** W: a console workspace whose published console offers `moveIssue`, bound to its InferOps board. */
async function consoleWorkspace(opts: { person?: Partial<Person>; role?: "use" | null; companies?: boolean } = {}) {
  let name = `pw-w-${crypto.randomUUID()}`;
  let board: Board = { revision: "7", company: "acme-tenant", transitions: [], reads: 0, callers: [] };
  let people = new Map<string, Person>();
  let wImpl: any;
  let published = await withImpl(name, async impl => {
    // With a shared-configuration vendor named, the deployment has companies, and a command runs only
    // on a connection of the person's own (COMMAND_OTHER_COMPANY).
    let flags: Record<string, string> = { ...FLAGS, ...(opts.companies ? { SHARED_CONFIGURATION_GATEKEEPER: "inferops" } : {}) };
    impl.env = new Proxy(impl.env, { get: (target, prop) => prop in flags ? flags[prop as string] : Reflect.get(target, prop) });
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: (id: string) => ({
        whoami: async () => ({ type: "user", id: people.get(id)?.profileId ?? "nobody", name: "Operator" }),
        operateSessionWorkspaceId: async () => people.get(id)?.session ?? null,
        // The page shows no console: only a request through the console tools needs it open.
        getOperatePage: async () => ({ state: { console: null } }),
        currentPresentationCompany: async () => people.get(id)?.company ?? "",
        recordSharedGadgetOpen: async () => {},
      }),
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.recordGadgetAnalytics = () => {};
    impl.syncOutputsTo = async () => {};
    impl.ownerId = uid(BUILDER);
    impl.storage.ownerId.put(uid(BUILDER));
    impl.ownerProfileId = BUILDER;
    impl.storage.gatekeepers.put({ id: BOARD, resourceTitle: "Board ENG", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "inferops://acme.operations/project/board/ENG", typeUrlPattern: "" } });
    let nextAction = 100;
    impl.getGatekeeperFacet = () => ({
      connectionCompany: async () => board.company,
      startSession: async (queue: any) => ({
        openIssue: async (issueId: string) => ({
          read: async () => {
            board.reads++;
            if (issueId === board.hangOn) return await new Promise<never>(() => {});
            board.onRead?.();
            return { revision: board.revision };
          },
          transition: async (toStateId: string, expectedRevision: string) => {
            board.transitions.push([issueId, toStateId, expectedRevision]);
            return await queue.submitAction(nextAction++, {
              title: `Move ${issueId}`, description: `Moves it, at revision ${expectedRevision}.`,
              implementsRevert: true, descriptionIsComplete: true,
              fields: [{ label: "Expected revision", kind: "inline", value: expectedRevision }],
            });
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      }),
      applyAction: async () => {},
      rejectAction: async () => {},
    });
    let open = impl.openGatekeeperSession.bind(impl);
    impl.openGatekeeperSession = (id: number, facet: unknown, caller: unknown) => {
      board.callers.push(caller);
      return open(id, facet, caller);
    };
    let commit = await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(FILES)), {
      parents: [], author: { name: "Builder", email: "builder@example.com" }, message: "synthetic", timestamp: new Date(1700000000_000),
    });
    let record = impl.createGadget("Board tools", "BOARD_TOOLS", undefined, undefined, commit);
    record.installedFrom = { blueprintId: "bp-BOARD", version: 1, kind: "widget" };
    impl.storage.gadgets.put(record);
    impl.storage.canvases.put({ id: "floor", title: "Floor", revision: "0", sections: [{ id: "main", title: "Main", columns: 1, widgets: [] }] });
    let store = () => new WorkspaceConsoleStore(impl.ctx.storage, impl.storage, impl.env, impl.frozenInstalls());
    let content: OperateConsoleContent = { title: "Floor", fullChat: "off",
      views: [{ id: "v", title: "V", type: "screen", screen: "floor" }],
      widgets: [{ gadgetId: record.id, blueprintId: "bp-BOARD", version: 1, label: "Board tools", state: "resettable",
        commands: [{ name: "moveIssue", gatekeeperId: BOARD }] }] };
    let saved = store().create(content, await impl.readSourceCommits(store().sourceCommitIds(content)));
    let capture = store().capture(saved.id, saved.revision);
    let shown: OperateConsole = store().publish(saved.id, saved.revision, capture, await impl.readSourceCommits(capture.commitIds),
        undefined, (gatekeeperId: number, command: any) => impl.consoleCommandRefusal(gatekeeperId, command));
    if (opts.role !== null) {
      impl.storage.collaborators.put({ profile: { type: "user", id: PERSON, name: PERSON },
        addedBy: [{ type: "user", sharer: BUILDER, created: new Date(), role: opts.role ?? "use" }] });
    }
    wImpl = impl;
    return shown;
  });
  let w = {
    name, id: idOf(name), board, people, impl: wImpl,
    consoleId: published.id, revision: published.published!.revision,
    gadgetId: published.published!.content.widgets![0]!.gadgetId,
  };
  return w;
}
type W = Awaited<ReturnType<typeof consoleWorkspace>>;

/** S: the person's operate session, owned by `PERSON`, whose proposing gatekeeper records what it's told. */
async function operateSession(w: W, opts: { operate?: boolean; company?: string } = {}) {
  let name = `pw-s-${crypto.randomUUID()}`;
  let session = idOf(name);
  w.people.set(uid(PERSON), { profileId: PERSON, session, company: opts.company ?? "acme-tenant" });
  let seen: { effects?: ApprovedEffects; answers: unknown[]; during?: (effects: ApprovedEffects) => Promise<unknown> } = { answers: [] };
  await withImpl(name, impl => {
    if (opts.operate !== false) impl.storage.operateSession.put(true);
    impl.ownerId = uid(PERSON);
    impl.storage.ownerId.put(uid(PERSON));
    impl.ownerProfileId = PERSON;
    impl.users = { idFromName: (profileId: string) => ({ toString: () => uid(profileId) }), idFromString: (id: string) => id, get: () => ({}) };
    impl.storage.gatekeepers.put({ id: PROPOSER, resourceTitle: "InferOps", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "test://dot", typeUrlPattern: "test://*" } });
    impl.getGatekeeperFacet = () => ({
      applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
        seen.effects = effects;
        if (effects && seen.during) seen.answers.push(await seen.during(effects));
      },
      rejectAction: async () => {},
      workflowRunOutcome: async (action: number, outcome: ApprovedRunOutcome) => { reported.push([session, action, outcome]); },
    });
  });
  return { name, id: session, seen };
}
type S = Awaited<ReturnType<typeof operateSession>>;

const stepRef = (w: W, overrides: Partial<{ revision: string; gadgetId: number; command: string; workspaceId: string }> = {}) =>
  consoleCommandRef({ company: "acme", workspace: "operations", workspaceId: overrides.workspaceId ?? w.id,
    consoleId: w.consoleId, revision: overrides.revision ?? w.revision, gadgetId: overrides.gadgetId ?? w.gadgetId,
    command: overrides.command ?? "moveIssue" });
const createDescription = (steps: { reference: string; input: object }[]) => ({
  title: "Create a personal workflow", description: "The Dot proposes a workflow.", implementsRevert: false,
  descriptionIsComplete: true, personalWorkflow: { title: "Close out", steps },
});
const runDescription = (reference: string) => ({
  title: "Run a personal workflow", description: "The Dot proposes running it.", implementsRevert: false,
  descriptionIsComplete: true, personalWorkflowRun: { reference, reportOutcome: true },
});
const step = (w: W, input: object = { issueId: ISSUE, toStateId: DONE }, ref = stepRef(w)) => ({ reference: ref, input });

/** Submits `description` in S and applies it with `resolvedBy`; `during` uses the effects handed to the gatekeeper. */
async function approve(s: S, description: object, during: (effects: ApprovedEffects) => Promise<unknown>,
    opts: { resolvedBy?: object; autoApproved?: boolean; key?: number } = {}) {
  s.seen.effects = undefined;
  s.seen.answers = [];
  s.seen.during = during;
  return withImpl(s.name, async impl => {
    let key = opts.key ?? Math.floor(Math.random() * 1e6) + 1;
    await impl.submitAction(PROPOSER, key, description, { from: "agent", chatId: 1 });
    let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action" && a.action === key) as any;
    try { await impl.applyPendingAction(record, opts.resolvedBy ?? PERSON_RESOLVER, opts.autoApproved ?? false); } catch { /* recorded */ }
    return { record: impl.storage.actions.get(record.id), answer: s.seen.answers[0] as any, effects: s.seen.effects };
  });
}
const create = (s: S, steps: { reference: string; input: object }[], opts = {}) =>
  approve(s, createDescription(steps), effects => effects.createPersonalWorkflow(), opts);
async function created(s: S, w: W, steps = [step(w)]) {
  let { answer } = await create(s, steps);
  expect(answer).toMatchObject({ status: "created", sessionWorkspaceId: s.id });
  return answer.personalWorkflowId as string;
}
const runRef = (s: S, id: string, sessionWorkspaceId = s.id) =>
  personalWorkflowRef({ company: "acme", workspace: "operations", sessionWorkspaceId, personalWorkflowId: id });
const run = (s: S, reference: string, opts = {}) =>
  approve(s, runDescription(reference), effects => effects.runPersonalWorkflow(), opts);
const advance = (s: S) => withImpl(s.name, impl => impl.advancePersonalWorkflowRuns(Date.now() + 1e9));
const runs = (s: S) => withImpl(s.name, impl => Array.from(impl.storage.personalWorkflowRuns.list()) as any[]);
const pendingIn = (w: W) => withImpl(w.name, impl =>
  (Array.from(impl.storage.actions.list()) as any[]).filter(a => a.type === "action"));
const workflows = (s: S) => withImpl(s.name, impl => Array.from(impl.storage.personalWorkflows.list()) as any[]);

describe("declaring a personal workflow (submit)", () => {
  it("lists every step and its input in the kernel's own last field, saying each revision is read when it runs", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let { record } = await approve(s, createDescription([step(w), step(w, { issueId: ISSUE_2, toStateId: DONE })]), async () => null);
    let field = record.description.fields.at(-1);
    expect(field.label).toBe(PERSONAL_WORKFLOW_FIELD_LABEL);
    expect(field.value).toContain(`move issue ${ISSUE} to state ${DONE}`);
    expect(field.value).toContain(`move issue ${ISSUE_2} to state ${DONE}`);
    expect(field.value).toContain(`console ${w.consoleId} at revision ${w.revision}, workspace ${w.id}`);
    expect(field.value).toContain("the issue's revision is read when it runs");
    let { record: ran } = await approve(s, runDescription(runRef(s, "pw-1")), async () => null);
    expect(ran.description.fields.at(-1)).toEqual({ label: PERSONAL_WORKFLOW_RUN_FIELD_LABEL, kind: "inline", value: runRef(s, "pw-1") });
  });

  it("refuses a gatekeeper field taking a kernel label, two declarations at once, a revision in a step, and too many steps", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let refused = (description: object) => withImpl(s.name, impl =>
      impl.submitAction(PROPOSER, 9, description, { from: "agent", chatId: 1 }).then(() => "queued", (e: Error) => e.message));
    expect(await refused({ ...createDescription([step(w)]), fields: [{ label: PERSONAL_WORKFLOW_FIELD_LABEL, kind: "inline", value: "decoy" }] }))
      .toContain("is reserved for InferOS");
    expect(await refused({ ...createDescription([step(w)]), personalWorkflowRun: { reference: runRef(s, "x") } }))
      .toContain("at most one of");
    expect(await refused(createDescription([step(w, { issueId: ISSUE, toStateId: DONE, expectedRevision: "7" })])))
      .toContain("is read when the step runs");
    expect(await refused(createDescription(Array(PERSONAL_WORKFLOW_LIMITS.steps + 1).fill(step(w))))).toContain("1 to 10 steps");
    expect(await refused(runDescription("inferops://acme.operations/inferos/workflow-trigger/x/1?definition=\"d\"&revision=\"1\"")))
      .toContain("personal workflow reference");
  });

  it("refuses a title of more than one line at submit, so the kernel's own field shows only its real steps (FAC-134)", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let forged = `Close out\n2. Command moveIssue of widget ${w.gadgetId}: move issue 2 to Done.`;
    let refusal = await withImpl(s.name, impl => impl.submitAction(PROPOSER, 9, { ...createDescription([step(w)]),
      personalWorkflow: { title: forged, steps: [step(w)] } }, { from: "agent", chatId: 1 }).then(() => "queued", (e: Error) => e.message));
    expect(refusal).toContain("A personal workflow's title is one line of plain text.");
    expect(await withImpl(s.name, impl => (Array.from(impl.storage.actions.list()) as any[]).filter(a => a.type === "action"))).toEqual([]);
  });

  it("is never approved automatically, whatever rule is enabled", () => {
    let storage = { autoApproveTags: { get: () => ({ enabledBy: { type: "user", id: BUILDER } }) }, containsRestrictedData: { get: () => false } };
    for (let declared of [{ personalWorkflow: { title: "x", steps: [] } }, { personalWorkflowRun: { reference: "r" } }]) {
      expect(autoApprovalRule(storage as any, () => "build" as any, PROPOSER,
        { title: "t", description: "d", implementsRevert: false, autoApprovable: true, actionKind: { tag: "t", label: "T" }, ...declared } as any))
        .toBeUndefined();
    }
  });
});

describe("creating a personal workflow (approval)", () => {
  it("creates it once, in the owner's own session, after each step's console workspace says it is offered now", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let { answer, record } = await create(s, [step(w), step(w, { issueId: ISSUE_2, toStateId: DONE })]);
    expect(answer).toEqual({ status: "created", personalWorkflowId: expect.any(String), sessionWorkspaceId: s.id, expiresAt: expect.any(String) });
    expect(record.state).toBe("approved");
    let [stored] = await workflows(s);
    expect(stored).toMatchObject({ id: answer.personalWorkflowId, title: "Close out", fromAction: record.id });
    expect(stored.steps.map((x: any) => x.input)).toEqual([{ issueId: ISSUE, toStateId: DONE }, { issueId: ISSUE_2, toStateId: DONE }]);
    // Nothing was requested on the board: creating only checks.
    expect(w.board.transitions).toEqual([]);
    expect(await pendingIn(w)).toEqual([]);
  });

  for (let [why, arrange, steps] of [
    ["a command the console doesn't offer", async () => {}, (w: W) => [step(w), step(w, undefined, stepRef(w, { command: "moveAgain" }))]],
    ["another revision of the console", async () => {}, (w: W) => [step(w, undefined, stepRef(w, { revision: String(BigInt(w.revision) + 1n) }))]],
    ["another widget", async () => {}, (w: W) => [step(w, undefined, stepRef(w, { gadgetId: w.gadgetId + 99 }))]],
    ["a workspace id that names no workspace", async () => {}, (w: W) => [step(w, undefined, stepRef(w, { workspaceId: "not-a-workspace" }))]],
    ["a board of another company", async (w: W) => { w.board.company = "other-tenant"; }, (w: W) => [step(w)]],
    ["a connection no longer an InferOps board", async (w: W) => {
      await withImpl(w.name, impl => impl.storage.gatekeepers.put({ ...impl.storage.gatekeepers.get(BOARD),
        creationSpec: { type: "gatekeeper", vendorId: "github", resourceUrl: "https://github.com/x/y", typeUrlPattern: "" } }));
    }, (w: W) => [step(w)]],
  ] as const) {
    it(`refuses ${why}, creating nothing and never saying which check`, async () => {
      let w = await consoleWorkspace({ companies: true });
      let s = await operateSession(w);
      await arrange(w);
      let { answer } = await create(s, steps(w) as any);
      expect(answer).toMatchObject({ status: "refused", reason: expect.stringMatching(/^Step \d+ of this workflow isn't a command a console offers you now/) });
      expect(await workflows(s)).toEqual([]);
      expect(w.board.transitions).toEqual([]);
    });
  }

  it("refuses a person who may not use the console's workspace, and one in another company", async () => {
    let w = await consoleWorkspace({ role: null });
    let s = await operateSession(w);
    expect((await create(s, [step(w)])).answer).toMatchObject({ status: "refused" });
    let w2 = await consoleWorkspace({ companies: true });
    let s2 = await operateSession(w2, { company: "other-tenant" });
    expect((await create(s2, [step(w2)])).answer).toMatchObject({ status: "refused" });
    expect([...await workflows(s), ...await workflows(s2)]).toEqual([]);
  });

  it("gives no effects to an automatic or another kind of resolver, and refuses outside the owner's own session", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    expect((await create(s, [step(w)], { autoApproved: true })).effects).toBeUndefined();
    expect((await create(s, [step(w)], { resolvedBy: { type: "agent", id: "a", name: "Agent" } })).effects).toBeUndefined();
    // Another person's approval in this session: never theirs to keep here.
    expect((await create(s, [step(w)], { resolvedBy: { type: "user", id: OTHER, name: "Other" } })).answer)
      .toMatchObject({ status: "refused", reason: "Personal workflows are kept and run only in your own operate session." });
    let plain = await operateSession(w, { operate: false });
    expect((await create(plain, [step(w)])).answer).toMatchObject({ status: "refused" });
    expect([...await workflows(s), ...await workflows(plain)]).toEqual([]);
  });
});

describe("listing a person's personal workflows", () => {
  it("lists only the owner's own, in their own session, and is refused to a use collaborator", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w);
    expect((await withImpl(s.name, impl => impl.personalWorkflowsOf(PERSON))).map((x: any) => x.id)).toEqual([id]);
    expect(await withImpl(s.name, impl => impl.personalWorkflowsOf(OTHER))).toEqual([]);
    let plain = await operateSession(w, { operate: false });
    expect(await withImpl(plain.name, impl => impl.personalWorkflowsOf(PERSON))).toEqual([]);
    let viewer = await openFakeOverseer({}, { role: "use" });
    await expect((viewer as any).listPersonalWorkflows()).rejects.toThrow();
  });
});

describe("running a personal workflow", () => {
  it("requests each step in order, at the issue's revision read when it runs, pending for the builders; reports requests placed", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w, [step(w), step(w, { issueId: ISSUE_2, toStateId: DONE })]);
    // D2: the issue changes between approval and run, and the step sends the new revision.
    w.board.revision = "12";
    let { answer, record } = await run(s, runRef(s, id));
    expect(answer).toEqual({ status: "started", runId: expect.any(String) });
    expect(w.board.transitions).toEqual([]);
    await advance(s);
    expect(w.board.transitions).toEqual([[ISSUE, DONE, "12"], [ISSUE_2, DONE, "12"]]);
    let placed = await pendingIn(w);
    expect(placed).toHaveLength(2);
    for (let action of placed) {
      // A request the console's builders decide, never applied unseen, showing the revision read.
      expect(action).toMatchObject({ state: "pending", gatekeeperId: BOARD,
        caller: { from: "operateAgent", profileId: PERSON, sessionWorkspaceId: s.id, personalWorkflowStep: { runId: answer.runId } } });
      expect(action.description.fields).toContainEqual({ label: "Expected revision", kind: "inline", value: "12" });
      // r1's LOW 3: the decider is told it is a step of the person's own approved personal workflow.
      expect(actionContextOf(action)).toMatchObject({ kind: "agent-turn", onBehalfOf: { profileId: PERSON },
        personalWorkflowStep: { runId: answer.runId, index: expect.any(Number) } });
      expect(autoApprovalRule(await withImpl(w.name, impl => impl.storage), () => "build" as any, BOARD, action.description)).toBeUndefined();
    }
    let [ended] = await runs(s);
    expect(ended).toMatchObject({ state: "succeeded", results: [{ status: "requested" }, { status: "requested" }] });
    expect(reported).toEqual([[s.id, record.action, {
      kind: "personal-workflow", runId: answer.runId, outcome: "succeeded", requestedBy: PERSON, ranAs: "gadget_bindings", actionApplied: true,
    }]]);
    // Once: a later pass reports nothing again.
    await advance(s);
    expect(reported).toHaveLength(1);
  });

  it("stops at a refused step with nothing after it sent, reporting step-refused and keeping the cause only in its own record", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w, [step(w), step(w, { issueId: ISSUE_2, toStateId: DONE })]);
    // The person's role in W ends after the workflow was created.
    await withImpl(w.name, impl => impl.storage.collaborators.delete(PERSON));
    let { answer } = await run(s, runRef(s, id));
    await advance(s);
    expect(w.board.transitions).toEqual([]);
    let [ended] = await runs(s);
    expect(ended).toMatchObject({ state: "failed", reason: "step-refused", results: [{ status: "refused", detail: NO_CONSOLE_TOOL_ACCESS }] });
    expect(reported.map(r => r[2])).toEqual([expect.objectContaining({ runId: answer.runId, outcome: "failed", reason: "step-refused" })]);
    expect(JSON.stringify(reported)).not.toContain(NO_CONSOLE_TOOL_ACCESS);
  });

  it("re-checks every FAC-14 check at each step: the generation, the revision, the binding, the company and the input", async () => {
    let cases: [string, (w: W, s: S) => Promise<void>, string | RegExp][] = [
      ["the authz generation moves during the request", async w => {
        w.board.onRead = () => { bumpAuthzGeneration(w.impl.storage); };
      }, /changed/i],
      ["the console is no longer published", async w => {
        await withImpl(w.name, impl => {
          let store = new WorkspaceConsoleStore(impl.ctx.storage, impl.storage, impl.env, impl.frozenInstalls());
          let shown = store.list().find(c => c.id === w.consoleId)!;
          store.delete(shown.id, shown.revision);
        });
      }, /./],
      ["the binding is no longer an InferOps board", async w => {
        await withImpl(w.name, impl => impl.storage.gatekeepers.put({ ...impl.storage.gatekeepers.get(BOARD),
          creationSpec: { type: "gatekeeper", vendorId: "github", resourceUrl: "https://github.com/x/y", typeUrlPattern: "" } }));
      }, /isn't an InferOps board|is not an InferOps board/],
      ["the board's company is another", async w => { w.board.company = "other-tenant"; }, COMMAND_OTHER_COMPANY],
      ["the stored input no longer fits the command", async (_w, s) => {
        await withImpl(s.name, impl => {
          for (let workflow of impl.storage.personalWorkflows.list()) {
            impl.storage.personalWorkflows.put({ ...workflow, steps: workflow.steps.map((x: any) => ({ ...x, input: { issueId: "nope", toStateId: DONE } })) });
          }
        });
      }, /must be a UUID/],
    ];
    for (let [why, arrange, refusal] of cases) {
      let w = await consoleWorkspace({ companies: true });
      let s = await operateSession(w);
      let id = await created(s, w);
      await arrange(w, s);
      await run(s, runRef(s, id));
      await advance(s);
      let [ended] = await runs(s);
      expect(ended.state, why).toBe("failed");
      expect(ended.results[0].status, why).toBe("refused");
      if (typeof refusal === "string") expect(ended.results[0].detail, why).toBe(refusal);
      else expect(ended.results[0].detail, why).toMatch(refusal);
      // Nothing was placed: at most the read happened.
      expect(await pendingIn(w), why).toEqual([]);
    }
  });

  it("is uncertain, never sent again, when a step was found still sending (a restart mid-request)", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w);
    await run(s, runRef(s, id));
    await withImpl(s.name, impl => {
      let [started] = Array.from(impl.storage.personalWorkflowRuns.list()) as any[];
      impl.storage.personalWorkflowRuns.put({ ...started, sending: 0 });
    });
    await advance(s);
    expect(w.board.transitions).toEqual([]);
    let [ended] = await runs(s);
    expect(ended).toMatchObject({ state: "uncertain", reason: "step-unknown", results: [{ status: "unknown" }] });
    expect(reported.map(r => r[2])).toEqual([expect.objectContaining({ outcome: "uncertain", reason: "step-unknown" })]);
  });

  it("runs only one of the owner's own workflows, in this session: another session's reference or an unknown one is refused", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w);
    let elsewhere = await run(s, runRef(s, id, idOf(`pw-s-${crypto.randomUUID()}`)));
    expect(elsewhere.answer).toMatchObject({ status: "refused" });
    expect((await run(s, runRef(s, "no-such-workflow"))).answer).toMatchObject({ status: "refused" });
    // Another person approving it here is refused too.
    expect((await run(s, runRef(s, id), { resolvedBy: { type: "user", id: OTHER, name: "Other" } })).answer).toMatchObject({ status: "refused" });
    expect(await runs(s)).toEqual([]);
    await advance(s);
    expect(w.board.transitions).toEqual([]);
  });
});

describe("the console workspace's step entry (the lead's D1 (B))", () => {
  it("bounds a step whose gatekeeper never answers: step-unknown, and the session's next run isn't held (r1's LOW 1)", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let stuck = await created(s, w, [step(w, { issueId: ISSUE_2, toStateId: DONE })]);
    let fine = await created(s, w, [step(w)]);
    w.board.hangOn = ISSUE_2;
    w.impl.personalWorkflowStepDeadlineMs = 500;
    await withImpl(s.name, impl => { impl.personalWorkflowStepDeadlineMs = 500; });
    await run(s, runRef(s, stuck));
    await run(s, runRef(s, fine));
    await advance(s);
    let ended = await runs(s);
    expect(ended.find(r => r.workflowId === stuck)).toMatchObject({ state: "uncertain", reason: "step-unknown", results: [{ status: "unknown" }] });
    expect(ended.find(r => r.workflowId === fine)).toMatchObject({ state: "succeeded", results: [{ status: "requested" }] });
    expect(w.board.transitions).toEqual([[ISSUE, DONE, "7"]]);
  });

  it("bounds a step whose console workspace doesn't answer in time: the session's own bound gives step-unknown, and its next run still runs", async () => {
    let w = await consoleWorkspace();
    let other = await consoleWorkspace();
    let s = await operateSession(w);
    // The same person, offered a console in a second workspace.
    other.people.set(uid(PERSON), w.people.get(uid(PERSON))!);
    let stuck = await created(s, w);
    let fine = await created(s, other, [step(other)]);
    // W's step entry answers only after 20 s, past the session's bound (100 ms + its 5 s margin),
    // so W's own deadline can't end it: only the session's bound can. (A promise that never settles
    // would be cancelled by the runtime as hung, which proves nothing about the bound.)
    // (On the implementation the Durable Object delegates to: RPC reaches only its class's methods.)
    await withImpl(w.name, impl => {
      impl.requestPersonalWorkflowStep = () =>
        new Promise(resolve => setTimeout(() => resolve({ status: "requested" }), 20_000));
    });
    await withImpl(s.name, impl => { impl.personalWorkflowStepDeadlineMs = 100; });
    await run(s, runRef(s, stuck));
    await run(s, runRef(s, fine));
    await advance(s);
    let ended = await runs(s);
    expect(ended.find(r => r.workflowId === stuck)).toMatchObject({ state: "uncertain", reason: "step-unknown", results: [{ status: "unknown" }] });
    expect(ended.find(r => r.workflowId === fine)).toMatchObject({ state: "succeeded", results: [{ status: "requested" }] });
    expect(w.board.transitions).toEqual([]);
    expect(other.board.transitions).toEqual([[ISSUE, DONE, "7"]]);
  }, 30_000);

  it("requests a step once, ever: a second request for it during its sending window places nothing (r1's LOW 2)", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w);
    await run(s, runRef(s, id));
    let [started] = await runs(s);
    await withImpl(s.name, impl => impl.storage.personalWorkflowRuns.put({ ...started, sending: 0 }));
    let person = { userId: uid(PERSON), profileId: PERSON, sessionWorkspaceId: s.id };
    let ask = () => withImpl(w.name, (_impl, instance) => (instance as any).requestPersonalWorkflowStep(person, { runId: started.runId, index: 0 }));
    expect(await ask()).toEqual({ status: "requested" });
    expect(await ask()).toEqual({ status: "refused", detail: "This step's request was already asked for." });
    expect(w.board.transitions).toHaveLength(1);
    expect(await pendingIn(w)).toHaveLength(1);
  });

  it("is no operate agent tool: none is named for a personal workflow or its steps (r1's LOW 4)", () => {
    expect(OPERATE_AGENT_TOOL_NAMES.filter(name => /personal|workflowStep|PersonalWorkflow/i.test(name))).toEqual([]);
  });

  it("requests nothing for a session that isn't running that step, another person's session, or itself", async () => {
    let w = await consoleWorkspace();
    let s = await operateSession(w);
    let id = await created(s, w);
    await run(s, runRef(s, id));
    let [started] = await runs(s);
    let ask = (caller: object, request: object) => withImpl(w.name, (_impl, instance) =>
      (instance as any).requestPersonalWorkflowStep(caller, request));
    let person = { userId: uid(PERSON), profileId: PERSON, sessionWorkspaceId: s.id };
    // A step the session isn't sending now: the run is started but its runner hasn't reached it.
    expect(await ask(person, { runId: started.runId, index: 0 })).toEqual({ status: "refused", detail: "This step isn't one your operate session is running now." });
    // Marked as sending, but asked for another run or another step.
    await withImpl(s.name, impl => impl.storage.personalWorkflowRuns.put({ ...started, sending: 0 }));
    expect((await ask(person, { runId: crypto.randomUUID(), index: 0 })).status).toBe("refused");
    expect((await ask(person, { runId: started.runId, index: 1 })).status).toBe("refused");
    // Another person naming this session, or their own session that runs nothing.
    expect((await ask({ userId: uid(OTHER), profileId: OTHER, sessionWorkspaceId: s.id }, { runId: started.runId, index: 0 })).status).toBe("refused");
    let other = await operateSession(w);
    expect((await ask({ ...person, sessionWorkspaceId: other.id }, { runId: started.runId, index: 0 })).status).toBe("refused");
    // A caller naming the console workspace itself.
    expect(await ask({ ...person, sessionWorkspaceId: w.id }, { runId: started.runId, index: 0 }))
      .toEqual({ status: "refused", detail: UNVERIFIED_CONSOLE_TOOL_CALLER });
    expect(w.board.transitions).toEqual([]);
    expect(await pendingIn(w)).toEqual([]);
  });

  it("is on no client interface: the owner's, a use collaborator's and an operate session's lack it", async () => {
    for (let opened of [await openFakeOverseer({}), await openFakeOverseer({}, { role: "use" })]) {
      for (let method of ["requestPersonalWorkflowStep", "checkPersonalWorkflowStep", "personalWorkflowStepFor", "advancePersonalWorkflowRuns"]) {
        expect((opened as any)[method], `${opened.constructor.name}.${method}`).toBeUndefined();
      }
    }
  });

  it("leaves the console tools' own command path requiring the open page", async () => {
    let w = await consoleWorkspace();
    await operateSession(w);
    let outcome = await withImpl(w.name, (_impl, instance) => instance.invokeConsoleTool(
      { userId: uid(PERSON), profileId: PERSON, sessionWorkspaceId: w.people.get(uid(PERSON))!.session! },
      { consoleId: w.consoleId, revision: w.revision, gadgetId: w.gadgetId, tool: "moveIssue",
        inputJson: JSON.stringify({ issueId: ISSUE, toStateId: DONE, expectedRevision: "7" }), deadlineAt: Date.now() + 10_000 }));
    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("is not open in your operate session") });
    expect(w.board.transitions).toEqual([]);
  });
});

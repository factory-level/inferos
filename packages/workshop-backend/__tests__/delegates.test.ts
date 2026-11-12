// FAC-134 capability 3 (ADR 0020): a delegate a person's Dot launches, end to end in a real Overseer
// Durable Object that is that person's operate session. Launched only by their own approval of an
// action that declared it, once, with a ceiling fixed at that approval (the session's own connections
// of the declared types that an operate chat may use, and the declared tools); every call it makes,
// and every turn it starts, checks again that its starter still holds this session at the
// authorization generation it was launched at, and a change cancels it. It can't launch another, and
// reports only its outcome (`kind: "delegate"`, `ranAs: "person"`).
//
// The user Durable Objects, the gatekeeper facets and the model are fakes; the kernel is real.
// Synthetic bounded fixtures only.
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ApprovedEffects, ApprovedRunOutcome } from "@gadgets/workshop-shared/gatekeeper";
import { DELEGATE_DEFAULT_TOOLS } from "@gadgets/workshop-shared/delegate";
import { autoApprovalRule } from "../src/auto-approval";
import {
  DELEGATE_FIELD_LABEL, DELEGATE_PROMPT_FIELD_LABEL, DELEGATE_NO_RELAUNCH, DELEGATE_OUTSIDE_CEILING, DELEGATE_OWN_SESSION, DELEGATE_REVOKED, DELEGATE_TAINTED,
  isReservedFieldLabel, type OverseerDurableObject,
} from "../src/overseer.js";
import { runAgent } from "../src/agent";
import { bumpAuthzGeneration } from "../src/sharing";
import { markConsoleToolTainted } from "../src/chat-taint";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const PERSON = "operator-profile";
const OTHER = "other-profile";
const uid = (profileId: string) => `${profileId}-user-id`;
const PROPOSER = 41; // the person's InferOps connection, through which the Dot proposes
const BOARD = 52; // another InferOps connection of theirs
const GITHUB = 53; // a connection of another type
const SECRET = 54; // an InferOps connection of a type an operate chat may not use
const PERSON_RESOLVER = { type: "user" as const, id: PERSON, name: "Operator" };
const MODEL = { profile: { type: "agent", id: "faux-model", name: "Faux" }, config: { provider: "cloudflare", model: "faux-model", apiToken: "" } };
const VENDORS = [{ id: "inferops", description: { displayName: "InferOps" },
  supportedResources: [{ title: "Secrets", urlPattern: "inferops://*/secret/*", excludeFromOperateChat: true }] }];
const BRIEF = { title: "Triage the open bugs", prompt: "Read the board.\nList the bugs with no owner.", connections: ["inferops"] };

let reported: [number, ApprovedRunOutcome][] = [];
afterEach(() => { reported = []; });

async function withImpl<T>(name: string, fn: (impl: any) => Promise<T> | T): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name),
      async (instance: OverseerDurableObject) => fn((instance as any).impl));
}

/** S: the person's operate session, with their connections, a fake model and a recording start. */
async function operateSession() {
  let name = `dl-s-${crypto.randomUUID()}`;
  let seen: { effects?: ApprovedEffects; answers: unknown[]; during?: (effects: ApprovedEffects) => Promise<unknown> } = { answers: [] };
  await withImpl(name, impl => {
    impl.storage.operateSession.put(true);
    impl.ownerId = uid(PERSON);
    impl.storage.ownerId.put(uid(PERSON));
    impl.ownerProfileId = PERSON;
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: () => ({
        getChatContext: async () => ({ aiModel: MODEL, profile: { type: "user", id: PERSON, name: "Operator" } }),
        listGatekeeperVendors: async () => VENDORS,
        setGadgetLastActive: async () => {},
      }),
    };
    let put = (id: number, vendorId: string, resourceUrl: string) => impl.storage.gatekeepers.put({ id, resourceTitle: `C${id}`,
      class: {} as any, resourceUrl, creationSpec: { type: "gatekeeper", vendorId, resourceUrl, typeUrlPattern: "" } });
    put(PROPOSER, "inferops", "inferops://acme.operations/dot");
    put(BOARD, "inferops", "inferops://acme.operations/project/board/ENG");
    put(GITHUB, "github", "https://github.com/acme/app");
    put(SECRET, "inferops", "inferops://acme.operations/secret/keys");
    impl.getGatekeeperFacet = () => ({
      applyAction: async (_action: number, _cache: unknown, effects?: ApprovedEffects) => {
        seen.effects = effects;
        if (effects && seen.during) seen.answers.push(await seen.during(effects));
      },
      rejectAction: async () => {},
      workflowRunOutcome: async (action: number, outcome: ApprovedRunOutcome) => { reported.push([action, outcome]); },
    });
    impl.started = [] as unknown[][];
    impl.startAgent = (...args: unknown[]) => { impl.started.push(args); };
  });
  return { name, seen };
}
type S = Awaited<ReturnType<typeof operateSession>>;

const description = (delegate: object = BRIEF) => ({
  title: "Launch a delegate", description: "The Dot proposes a delegate.", implementsRevert: false,
  descriptionIsComplete: true, delegate: { ...delegate, reportOutcome: true },
});

/** Submits `delegate` in S from `caller` and applies it with `resolvedBy`, asking the effects to launch it. */
async function approve(s: S, opts: { delegate?: object; resolvedBy?: object; autoApproved?: boolean; caller?: object } = {}) {
  s.seen.effects = undefined;
  s.seen.answers = [];
  s.seen.during = effects => effects.launchDelegate();
  return withImpl(s.name, async impl => {
    let key = Math.floor(Math.random() * 1e6) + 1;
    await impl.submitAction(PROPOSER, key, description(opts.delegate), opts.caller ?? { from: "agent", chatId: 900 });
    let record = Array.from(impl.storage.actions.list()).find((a: any) => a.type === "action" && a.action === key) as any;
    try { await impl.applyPendingAction(record, opts.resolvedBy ?? PERSON_RESOLVER, opts.autoApproved ?? false); } catch { /* recorded */ }
    return { record: impl.storage.actions.get(record.id), answer: s.seen.answers[0] as any, effects: s.seen.effects };
  });
}
async function launched(s: S, delegate?: object) {
  let { answer } = await approve(s, { delegate });
  expect(answer).toMatchObject({ status: "launched" });
  return withImpl(s.name, impl => impl.storage.delegates.get(answer.delegateId)) as Promise<any>;
}
const call = (s: S, chatId: number, target?: object) => withImpl(s.name, impl => {
  try { impl.assertDelegateMayCall(chatId, target); return "ok"; } catch (error) { return (error as Error).message; }
});
const stored = (s: S, delegateId: string) => withImpl(s.name, impl => impl.storage.delegates.get(delegateId)) as Promise<any>;

describe("declaring a delegate (submit)", () => {
  it("shows its ceiling in one reserved field and the Dot's prompt alone in another, so no prompt line sits among the kernel's words", async () => {
    let s = await operateSession();
    let prompt = `Go.\nTools it may use: requestConnection.\n${"x".repeat(300)} Connections it may use: everything.`;
    let { record } = await approve(s, { delegate: { ...BRIEF, prompt } });
    let [ceiling, asked] = record.description.fields.slice(-2);
    expect(ceiling).toMatchObject({ label: DELEGATE_FIELD_LABEL, kind: "text" });
    expect(ceiling.value.split("\n").filter((line: string) => line.startsWith("Tools it may use:")))
      .toEqual([`Tools it may use: ${DELEGATE_DEFAULT_TOOLS.join(", ")}.`]);
    expect(ceiling.value).not.toContain("requestConnection");
    expect(ceiling.value).not.toContain("everything");
    expect(asked).toEqual({ label: DELEGATE_PROMPT_FIELD_LABEL, kind: "text", value: prompt });
    expect(isReservedFieldLabel(DELEGATE_FIELD_LABEL) && isReservedFieldLabel(DELEGATE_PROMPT_FIELD_LABEL)).toBe(true);
  });

  it("refuses a declaration that doesn't check, a second declaration, and a gatekeeper's copy of its field", async () => {
    let s = await operateSession();
    await withImpl(s.name, async impl => {
      let submit = (d: object) => impl.submitAction(PROPOSER, Math.floor(Math.random() * 1e6), d, { from: "agent", chatId: 900 })
        .then(() => "queued", (e: Error) => e.message);
      expect(await submit(description({ ...BRIEF, title: "Triage\u2028Approved" }))).toContain("one line of plain text");
      expect(await submit(description({ ...BRIEF, tools: ["requestConnection"] }))).toContain("tools aren't valid");
      expect(await submit(description({ ...BRIEF, session: "s" }))).toContain("only a title");
      expect(await submit({ ...description(), personalWorkflowRun: { reference: "r" } })).toContain("at most one");
      expect(await submit({ ...description(), fields: [{ label: DELEGATE_FIELD_LABEL, kind: "inline", value: "x" }] }))
        .toContain("is reserved for InferOS");
      expect((Array.from(impl.storage.actions.list()) as any[]).filter(a => a.type === "action")).toEqual([]);
    });
  });

  it("is never approved automatically, whatever rule is enabled", () => {
    let storage = { autoApproveTags: { get: () => ({ enabledBy: { type: "user", id: PERSON } }) }, containsRestrictedData: { get: () => false } };
    expect(autoApprovalRule(storage as any, () => "build" as any, PROPOSER,
      { title: "t", description: "d", implementsRevert: false, autoApprovable: true, actionKind: { tag: "t", label: "T" },
        delegate: BRIEF } as any)).toBeUndefined();
  });

  it("refuses one declared from a delegate's own chat: a delegate can't launch another", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    let { record } = await withImpl(s.name, async impl => ({ record: await impl.submitAction(PROPOSER, 7, description(),
      { from: "agent", chatId: delegate.chatId }).then(() => "queued", (e: Error) => e.message) }));
    expect(record).toBe(DELEGATE_NO_RELAUNCH);
  });

  it("refuses one declared from a chat that read console output: a tainted chat creates no chat", async () => {
    let s = await operateSession();
    let refusal = await withImpl(s.name, async impl => {
      markConsoleToolTainted(impl.storage, 900);
      return impl.submitAction(PROPOSER, 8, description(), { from: "agent", chatId: 900 }).then(() => "queued", (e: Error) => e.message);
    });
    expect(refusal).toBe(DELEGATE_TAINTED);
  });
});

describe("launching a delegate (approval)", () => {
  it("launches it on the person's own account, with a ceiling of their usable connections of the declared types", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    expect(Object.values(delegate.ceiling.connections).toSorted()).toEqual([PROPOSER, BOARD]);
    expect(delegate.ceiling.tools).toEqual([...DELEGATE_DEFAULT_TOOLS]);
    expect(delegate).toMatchObject({ starterProfileId: PERSON, state: "running", reportOutcome: true, declared: ["inferops"] });
    await withImpl(s.name, impl => {
      // Its seed bindings are the ceiling's connections only, and it starts from the prompt, as the person.
      expect(impl.storage.chatContext.get(delegate.chatId).bindings).toEqual(delegate.ceiling.connections);
      let messages = (Array.from(impl.storage.chats.list()) as any[]).filter(m => m.chatId === delegate.chatId);
      expect(messages.map(m => m.message)).toEqual([BRIEF.prompt]);
      expect(impl.started).toEqual([[delegate.chatId, MODEL, expect.anything(), uid(PERSON)]]);
    });
  });

  it("launches once per action: asking again in the same apply gives the same delegate", async () => {
    let s = await operateSession();
    s.seen.during = async effects => [await effects.launchDelegate(), await effects.launchDelegate()];
    await withImpl(s.name, async impl => {
      await impl.submitAction(PROPOSER, 11, description(), { from: "agent", chatId: 900 });
      let record = (Array.from(impl.storage.actions.list()) as any[]).find(a => a.action === 11);
      await impl.applyPendingAction(record, PERSON_RESOLVER, false);
      let [first, second] = s.seen.answers[0] as any[];
      expect(second).toEqual(first);
      expect(Array.from(impl.storage.delegates.list())).toHaveLength(1);
    });
  });

  it("launches nothing for an automatic approval, anyone else's, outside a live operate session, or a delegate's own action", async () => {
    let s = await operateSession();
    expect((await approve(s, { autoApproved: true })).effects).toBeUndefined();
    expect((await approve(s, { resolvedBy: { type: "user", id: OTHER, name: "Other" } })).answer)
      .toMatchObject({ status: "refused", reason: DELEGATE_OWN_SESSION });
    let delegate = await launched(s);
    // An action a delegate's chat proposed, however it got past submit, launches nothing.
    await withImpl(s.name, async impl => {
      await impl.submitAction(PROPOSER, 21, description(), { from: "agent", chatId: 900 });
      let record = (Array.from(impl.storage.actions.list()) as any[]).find(a => a.action === 21);
      impl.storage.actions.put({ ...record, caller: { from: "agent", chatId: delegate.chatId } });
      s.seen.answers = [];
      await impl.applyPendingAction(impl.storage.actions.get(record.id), PERSON_RESOLVER, false);
      expect(s.seen.answers[0]).toMatchObject({ status: "refused", reason: DELEGATE_NO_RELAUNCH });
    });
    await withImpl(s.name, impl => { impl.storage.operateSessionRetired.put(true); });
    expect((await approve(s)).answer).toMatchObject({ status: "refused", reason: DELEGATE_OWN_SESSION });
    expect(await withImpl(s.name, impl => Array.from(impl.storage.delegates.list()).length)).toBe(1);
  });
});

describe("a delegate's authority, checked on every call", () => {
  it("reaches only its ceiling's connections: never another the person holds, a gadget or git", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    expect(await call(s, delegate.chatId, { type: "gatekeeper", id: BOARD })).toBe("ok");
    for (let target of [{ type: "gatekeeper", id: GITHUB }, { type: "gatekeeper", id: SECRET }, { type: "gadget", id: 1 }, { type: "git" }]) {
      expect(await call(s, delegate.chatId, target)).toBe(DELEGATE_OUTSIDE_CEILING);
    }
    // Through the binding entry itself, before anything else runs.
    let entry = await withImpl(s.name, impl => Promise.resolve()
      .then(() => impl.startGatekeeperSession({ type: "gatekeeper", id: GITHUB }, { from: "agent", chatId: delegate.chatId }))
      .then(() => "opened", (e: Error) => e.message));
    expect(entry).toBe(DELEGATE_OUTSIDE_CEILING);
    // Any other chat is untouched.
    expect(await call(s, 900, { type: "gatekeeper", id: GITHUB })).toBe("ok");
    expect((await stored(s, delegate.delegateId)).state).toBe("running");
  });

  it("is cancelled at its next call once its starter's access changes: a grant change, another owner, a retired session", async () => {
    for (let change of ["generation", "owner", "retired"] as const) {
      let s = await operateSession();
      let delegate = await launched(s);
      await withImpl(s.name, impl => {
        if (change === "generation") bumpAuthzGeneration(impl.storage);
        if (change === "owner") impl.ownerProfileId = OTHER;
        if (change === "retired") impl.storage.operateSessionRetired.put(true);
      });
      expect(await call(s, delegate.chatId, { type: "gatekeeper", id: BOARD }), change).toBe(DELEGATE_REVOKED);
      expect(await stored(s, delegate.delegateId), change).toMatchObject({ state: "failed", reason: "requester-revoked" });
      // Ended, it stays refused.
      expect(await call(s, delegate.chatId, { type: "gatekeeper", id: BOARD }), change).toBe(DELEGATE_REVOKED);
    }
  });

  it("starts no turn, after an approval, a restart or a delivered call, once its starter's access changed", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    await withImpl(s.name, impl => {
      bumpAuthzGeneration(impl.storage);
      let meta = impl.storage.chatMeta.get(delegate.chatId);
      impl.storage.chatMeta.put({ ...meta, activeAgent: MODEL.profile });
      // The real start, which every resume goes through.
      Object.getPrototypeOf(impl).startAgent.call(impl, delegate.chatId, MODEL, MODEL.profile, uid(PERSON));
      expect(impl.storage.activeAgents.get(delegate.chatId)).toBeUndefined();
      expect(impl.storage.chatMeta.get(delegate.chatId).activeAgent).toBeUndefined();
      let last = (Array.from(impl.storage.chats.list()) as any[]).filter(m => m.chatId === delegate.chatId).at(-1);
      expect(JSON.stringify(last)).toContain(DELEGATE_REVOKED);
    });
    expect(await stored(s, delegate.delegateId)).toMatchObject({ state: "failed", reason: "requester-revoked" });
  });
});

// Runs one agent turn in `chatId`, the faux model answering each step in turn; returns the tools offered.
let turns = 0;
async function runScriptedTurn(impl: any, chatId: number, steps: ReturnType<typeof fauxAssistantMessage>[]) {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  let offered: string[][] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    contexts.push({ messages: structuredClone(context.messages) });
    offered.push(getCurrentTools(context.messages).map(tool => tool.name).toSorted());
    return step;
  }));
  impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(Date.now() + 60_000 * ++turns),
    author: PERSON_RESOLVER, type: "message", message: "Go." });
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, chatId, MODEL.profile as any,
      new AbortController().signal, PERSON_RESOLVER as any, MODEL.config as any);
  return { contexts, offered };
}
const toolStep = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const results = (context: Context) => context.messages.flatMap(message => message.role === "toolResult"
  ? [{ name: message.toolName, text: message.content.map(part => part.type === "text" ? part.text : "").join(""), isError: message.isError }]
  : []);

describe("a delegate's tools", () => {
  it("are only its ceiling's, offered and run, and each call checks its starter first", async () => {
    let s = await operateSession();
    let delegate = await launched(s, { ...BRIEF, tools: ["grep", "describeBinding"] });
    await withImpl(s.name, async impl => {
      expect(impl.delegateToolsFor(delegate.chatId)).toEqual(["grep", "describeBinding"]);
      expect(impl.delegateToolsFor(900)).toBeNull();
      let { offered, contexts } = await runScriptedTurn(impl, delegate.chatId, [
        toolStep(fauxToolCall("describeBinding", { name: "NOPE" })),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      expect(offered[0]).toEqual(["describeBinding", "grep"]);
      // Its starter's access changes mid-turn: the next call is refused, and the delegate cancelled.
      bumpAuthzGeneration(impl.storage);
      let second = await runScriptedTurn(impl, delegate.chatId, [
        toolStep(fauxToolCall("describeBinding", { name: "BOARD" })),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      expect(results(second.contexts.at(-1)!).at(-1)).toMatchObject({ name: "describeBinding", isError: true });
      expect(results(second.contexts.at(-1)!).at(-1)!.text).toContain(DELEGATE_REVOKED);
      expect(contexts).toHaveLength(2);
    });
    expect((await stored(s, delegate.delegateId)).reason).toBe("requester-revoked");
  });
});

describe("a delegate's outcome", () => {
  it("succeeds when a turn ends with nothing of its own pending, and fails on a turn that threw", async () => {
    let s = await operateSession();
    let a = await launched(s);
    let b = await launched(s);
    let c = await launched(s);
    await withImpl(s.name, async impl => {
      // c proposed an action still waiting for the person: it keeps running.
      await impl.submitAction(PROPOSER, 31, { title: "Write", description: "d", implementsRevert: false, descriptionIsComplete: true },
        { from: "agent", chatId: c.chatId });
      impl.settleDelegateAfterTurn(a.chatId, null);
      impl.settleDelegateAfterTurn(b.chatId, "runtime-error");
      impl.settleDelegateAfterTurn(c.chatId, null);
      impl.settleDelegateAfterTurn(900, "runtime-error");
    });
    expect(await stored(s, a.delegateId)).toMatchObject({ state: "succeeded" });
    expect(await stored(s, b.delegateId)).toMatchObject({ state: "failed", reason: "runtime-error" });
    expect(await stored(s, c.delegateId)).toMatchObject({ state: "running" });
  });

  it("is reported once to the action that launched it, as the person's delegate run, and never what it said", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    await withImpl(s.name, async impl => {
      impl.stopDelegate(PERSON, delegate.delegateId);
      await impl.reportDelegates(Date.now() + 1e9);
      await impl.reportDelegates(Date.now() + 2e9);
    });
    expect(reported).toEqual([[expect.any(Number), {
      kind: "delegate", runId: delegate.runId, outcome: "failed", reason: "cancelled", requestedBy: PERSON, ranAs: "person",
      actionApplied: true,
    }]]);
  });

  it("is listed and stopped only by its starter, in their own live session", async () => {
    let s = await operateSession();
    let delegate = await launched(s);
    await withImpl(s.name, impl => {
      expect(impl.delegatesOf(PERSON)).toEqual([expect.objectContaining({ delegateId: delegate.delegateId, state: "running",
        connections: ["inferops"], tools: [...DELEGATE_DEFAULT_TOOLS], chatId: delegate.chatId })]);
      expect(impl.delegatesOf(OTHER)).toEqual([]);
      expect(() => impl.stopDelegate(OTHER, delegate.delegateId)).toThrow(DELEGATE_OWN_SESSION);
      expect(() => impl.stopDelegate(PERSON, "no-such")).toThrow("No such delegate.");
    });
    expect((await stored(s, delegate.delegateId)).state).toBe("running");
  });
});

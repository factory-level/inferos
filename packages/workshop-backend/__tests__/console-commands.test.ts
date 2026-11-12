// A widget's declared command (FAC-14 K2), run in a real OverseerDurableObject W: its builder binds
// the board transition to one of W's own connections at publication, and the operate agent, for a
// person, may only request it. W verifies the person as for a console tool, then asks the
// connection's gatekeeper in a session of its own, as `{from: "operateAgent"}`, which submits one
// pending action that a person decides. No authored code runs. The user Durable Objects and the
// connection's gatekeeper facet are fakes; the kernel between them (the session, the approval
// queue, the action record, auto-approval and the decision) is real.
//
// Fixtures are synthetic only.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ConsoleWidgetEntry, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { OperateConsoleRun } from "@gadgets/workshop-shared/operate-session";
import { SHARED_CONFIGURATION_REFUSED } from "@gadgets/workshop-shared/api";
import { WorkspaceConsoleStore } from "../src/console-store";
import {
  COMMAND_OTHER_COMPANY, NO_CONSOLE_TOOL_ACCESS, UNVERIFIED_CONSOLE_TOOL_CALLER,
  type ConsoleToolCaller, type ConsoleToolOutcome,
} from "../src/console-tools";
import { actionContextOf, type OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OUT = { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 0, maximum: 9 } } };
const TOOLS = [
  { name: "count", description: "Synthetic count.", method: "count", effect: "read",
    input: { type: "object", properties: {} }, output: OUT },
  { name: "moveIssue", description: "Ask to move an issue.", effect: "write", command: "inferops.issue.transition" },
  { name: "moveAgain", description: "Declared, never bound.", effect: "write", command: "inferops.issue.transition" },
];
const FILES = {
  "server.js": `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  count() { return { n: 1 }; }
}
`,
  "tools.json": JSON.stringify(TOOLS),
};

const OWNER = "owner";
const uid = (profileId: string) => `${profileId}-user-id`;
const FLAGS = { COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", CONSOLE_TOOLS: "true" };
const BOARD = 41;
const ELSEWHERE = 42;
const ISSUE = "40000000-0000-4000-8000-000000000001";
const DONE = "40000000-0000-4000-8000-000000000002";
const INPUT = { issueId: ISSUE, toStateId: DONE, expectedRevision: "7" };
const TAG = "inferops.issue-transition";

type Person = {
  profileId: string; session: string | null; page: OperateConsoleRun | null; company: string;
  /** What their account answers when asked whether they may build shared configuration. */
  holds?: boolean;
  /** Runs while their page is being read, before it is returned (a change racing a request). */
  onPage?: () => Promise<void>;
};

type Board = {
  /** Each transition the board was asked for. */
  transitions: unknown[][];
  /** Each action the board applied, and each it was told was rejected. */
  applied: number[];
  rejected: number[];
  /** The company the board's connected account is in. */
  company: string | null;
  /** The caller each session the kernel opened on the board named. */
  callers: unknown[];
  /** What the board's description of its write asks of auto-approval. */
  autoApprovable: boolean;
};

type Harness = {
  impl: any;
  instance: OverseerDurableObject;
  workspaceId: string;
  people: Map<string, Person>;
  flags: Record<string, string | undefined>;
  store: () => WorkspaceConsoleStore;
  published: OperateConsole;
  widget: number;
  board: Board;
  publish: (content: OperateConsoleContent) => Promise<OperateConsole>;
  content: (commands?: ConsoleWidgetEntry["commands"]) => OperateConsoleContent;
};

let counter = 0;

const entry = (gadgetId: number, commands?: ConsoleWidgetEntry["commands"]): ConsoleWidgetEntry =>
  ({ gadgetId, blueprintId: "bp-BOARD", version: 1, label: "Board tools", state: "resettable",
    ...(commands ? { commands } : {}) });

async function withConsole(fn: (h: Harness) => Promise<void>, name = `console-commands-${++counter}`): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let people = new Map<string, Person>();
    let flags: Record<string, string | undefined> = { ...FLAGS };
    let realEnv = impl.env;
    impl.env = new Proxy(realEnv, { get: (target, prop) => prop in flags ? flags[prop as string] : Reflect.get(target, prop) });
    impl.users = {
      idFromName: (profileId: string) => ({ toString: () => uid(profileId) }),
      idFromString: (id: string) => id,
      get: (id: string) => ({
        id,
        whoami: async () => ({ type: "user", id: people.get(id)?.profileId ?? "nobody", name: "Someone" }),
        operateSessionWorkspaceId: async () => people.get(id)?.session ?? null,
        getOperatePage: async () => {
          let person = people.get(id);
          let race = person?.onPage;
          if (person) person.onPage = undefined;
          await race?.();
          return { state: { console: people.get(id)?.page ?? null } };
        },
        holdsSharedConfiguration: async () => people.get(id)?.holds ?? false,
        currentPresentationCompany: async () => people.get(id)?.company ?? "",
        recordSharedGadgetOpen: async () => {},
        getChatContext: async () => ({ profile: { type: "user", id: OWNER, name: "Owner" } }),
      }),
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.recordGadgetAnalytics = () => {};
    impl.syncOutputsTo = async () => {};
    impl.ownerId = uid(OWNER);
    impl.storage.ownerId.put(uid(OWNER));
    impl.ownerProfileId = OWNER;
    let workspaceId = impl.ctx.id.toString();

    // W's own connections: an InferOps board, and a connection of another kind.
    impl.storage.gatekeepers.put({ id: BOARD, resourceTitle: "Board ENG", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "inferops://acme.operations/project/board/ENG", typeUrlPattern: "" } });
    impl.storage.gatekeepers.put({ id: ELSEWHERE, resourceTitle: "Wiki", class: {} as any,
      creationSpec: { type: "gatekeeper", vendorId: "inferops", resourceUrl: "inferops://acme.operations/knowledge/wiki/x", typeUrlPattern: "" } });
    let board: Board = { transitions: [], applied: [], rejected: [], company: "acme-tenant", callers: [], autoApprovable: false };
    let nextAction = 100;
    impl.getGatekeeperFacet = () => ({
      connectionCompany: async () => board.company,
      startSession: async (queue: any) => ({
        openIssue: async (issueId: string) => ({
          transition: async (toStateId: string, expectedRevision: string) => {
            board.transitions.push([issueId, toStateId, expectedRevision]);
            let action = nextAction++;
            return await queue.submitAction(action, {
              title: "Move ENG-1 to Done", description: "Moves ENG-1 to Done.", implementsRevert: true,
              descriptionIsComplete: true,
              ...(board.autoApprovable ? { autoApprovable: true, actionKind: { tag: TAG, label: "Moves" } } : {}),
            });
          },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      }),
      applyAction: async (action: number) => { board.applied.push(action); },
      rejectAction: async (action: number) => { board.rejected.push(action); },
    });
    // The kernel's caller for each session opened on the board.
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
    let content = (commands?: ConsoleWidgetEntry["commands"]): OperateConsoleContent => ({ title: "Floor", fullChat: "off",
      views: [{ id: "v", title: "V", type: "screen", screen: "floor" }], widgets: [entry(record.id, commands)] });
    let saved: OperateConsole | null = null;
    let publish = async (next: OperateConsoleContent) => {
      let commits = await impl.readSourceCommits(store().sourceCommitIds(next));
      saved = saved ? store().replace(saved.id, saved.revision, next, commits) : store().create(next, commits);
      let capture = store().capture(saved!.id, saved!.revision);
      let shown = store().publish(saved!.id, saved!.revision, capture, await impl.readSourceCommits(capture.commitIds),
          undefined, (gatekeeperId: number, command: any) => impl.consoleCommandRefusal(gatekeeperId, command));
      saved = shown;
      return shown;
    };
    let published = await publish(content([{ name: "moveIssue", gatekeeperId: BOARD }]));
    let h: Harness = { impl, instance, workspaceId, people, flags, store, published,
      widget: published.published!.content.widgets![0]!.gadgetId, board, publish, content };
    await fn(h);
  });
}

const page = (h: Harness, overrides: Partial<OperateConsoleRun> = {}): OperateConsoleRun => ({
  workspaceId: h.workspaceId, consoleId: h.published.id, title: "Floor", source: "published",
  revision: h.published.published!.revision, fullChat: "off", viewId: "v", screenId: null, ...overrides,
});

function operator(h: Harness, profileId: string, role?: "use" | "build", company = "acme-tenant"): ConsoleToolCaller {
  if (role) {
    h.impl.storage.collaborators.put({ profile: { type: "user", id: profileId, name: profileId },
      addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role }] });
  }
  let session = `session-of-${profileId}`;
  h.people.set(uid(profileId), { profileId, session, page: page(h), company });
  return { userId: uid(profileId), profileId, sessionWorkspaceId: session };
}

function request(h: Harness, caller: ConsoleToolCaller, tool = "moveIssue", input: unknown = INPUT): Promise<ConsoleToolOutcome> {
  return h.instance.invokeConsoleTool(caller, {
    consoleId: h.published.id, revision: h.published.published!.revision, gadgetId: h.widget,
    tool, inputJson: JSON.stringify(input), deadlineAt: Date.now() + 10_000,
  });
}

const actions = (h: Harness) => Array.from(h.impl.storage.actions.list()).filter((a: any) => a.type === "action") as any[];

async function refusedAsking(h: Harness, outcome: Promise<ConsoleToolOutcome>, reason: string | RegExp) {
  let result = await outcome;
  expect(result.status).toBe("failed");
  if (typeof reason === "string") expect(result).toEqual({ status: "failed", reason });
  else expect(result.status === "failed" && result.reason).toMatch(reason);
  expect(h.board.transitions).toEqual([]);
  expect(actions(h)).toEqual([]);
}

describe("a declared command, bound by the builder (FAC-14 K2)", () => {
  it("is frozen at publication with its connection, and listed as a request a person approves", () =>
    withConsole(async h => {
      expect(h.published.published!.content.widgets![0]!.frozen!.commands).toEqual([
        { name: "moveIssue", description: "Ask to move an issue.", effect: "write", command: "inferops.issue.transition", gatekeeperId: BOARD },
      ]);
      let listed = await h.instance.listConsoleTools(operator(h, "ada", "use"), {
        consoleId: h.published.id, revision: h.published.published!.revision, deadlineAt: Date.now() + 10_000 });
      expect(listed.status).toBe("ok");
      let text = listed.status === "ok" ? listed.text : "";
      expect(text).toContain('"name":"moveIssue"');
      expect(text).toContain('"effect":"request"');
      expect(text).not.toContain("moveAgain");
      expect(text).not.toContain(String(BOARD));
    }));

  it("is requested once, pending, as the operate agent for the person: never applied until a person decides", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      let outcome = await request(h, ada);
      expect(outcome.status).toBe("ok");
      expect(outcome.status === "ok" && outcome.text).toContain('"requested":true');
      expect(h.board.transitions).toEqual([[ISSUE, DONE, "7"]]);
      expect(h.board.callers).toEqual([{ from: "operateAgent", userId: uid("ada"), profileId: "ada",
        sessionWorkspaceId: "session-of-ada", name: "Someone" }]);
      let [record] = actions(h);
      expect(record).toMatchObject({ state: "pending", gatekeeperId: BOARD, caller: { from: "operateAgent", profileId: "ada" } });
      expect(h.board.applied).toEqual([]);
    }));

  it("names the person it asked for to whoever decides it, by profile and display name", () =>
    withConsole(async h => {
      await request(h, operator(h, "ada", "use"));
      let [record] = actions(h);
      expect(actionContextOf(record)).toEqual({ kind: "agent-turn", onBehalfOf: { profileId: "ada", name: "Someone" } });
    }));

  it("can't be decided by the person who asked, with use: approving and rejecting are refused, nothing applies", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      await request(h, ada);
      let [record] = actions(h);
      let client: any = await h.instance.open(ada.userId, ada.profileId, new NativeRpcStub<() => void>(() => {}));
      await expect(client.approveAction(record.id)).rejects.toThrow();
      await expect(client.rejectAction(record.id)).rejects.toThrow();
      expect(h.impl.storage.actions.get(record.id).state).toBe("pending");
      expect(h.board.applied).toEqual([]);
      expect(h.board.rejected).toEqual([]);
    }));

  it("is decided through the decision calls: a decider's approval runs it once, their rejection runs nothing", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      await request(h, ada);
      await request(h, ada, "moveIssue", { ...INPUT, expectedRevision: "8" });
      let [first, second] = actions(h);
      // The owner, whose shared-configuration authority holds, decides here (#requireDecider).
      h.flags.SHARED_CONFIGURATION_GATEKEEPER = "inferops";
      h.impl.isSharedConfiguration = async () => true;
      operator(h, OWNER);
      h.people.get(uid(OWNER))!.holds = true;
      let decider: any = await h.instance.open(uid(OWNER), OWNER, new NativeRpcStub<() => void>(() => {}));
      await decider.approveAction(first.id);
      await decider.rejectAction(second.id);
      expect(h.board.applied).toEqual([first.action]);
      expect(h.board.rejected).toEqual([second.action]);
      expect(h.impl.storage.actions.get(first.id).state).toBe("approved");
      expect(h.impl.storage.actions.get(second.id).state).toBe("rejected");
    }));

  it("is refused to a builder whose shared-configuration authority says no (#requireDecider): nothing applies or is rejected", () =>
    withConsole(async h => {
      await request(h, operator(h, "ada", "use"));
      let [record] = actions(h);
      h.flags.SHARED_CONFIGURATION_GATEKEEPER = "inferops";
      h.impl.isSharedConfiguration = async () => true;
      // The owner opened a building session while the authority held; it says no by the decision,
      // which #requireDecider asks again at that point.
      operator(h, OWNER);
      h.people.get(uid(OWNER))!.holds = true;
      let client: any = await h.instance.open(uid(OWNER), OWNER, new NativeRpcStub<() => void>(() => {}));
      h.people.get(uid(OWNER))!.holds = false;
      await expect(client.approveAction(record.id)).rejects.toThrow(SHARED_CONFIGURATION_REFUSED);
      await expect(client.rejectAction(record.id)).rejects.toThrow(SHARED_CONFIGURATION_REFUSED);
      expect(h.impl.storage.actions.get(record.id).state).toBe("pending");
      expect(h.board.applied).toEqual([]);
      expect(h.board.rejected).toEqual([]);
    }));

  it("is never auto-approved, even under an enabled rule for its kind", () =>
    withConsole(async h => {
      h.board.autoApprovable = true;
      h.impl.storage.autoApproveTags.put({ gatekeeperId: BOARD, actionKind: { tag: TAG, label: "Moves" },
        enabledBy: { type: "user", id: OWNER } });
      expect((await request(h, operator(h, "ada", "use"))).status).toBe("ok");
      await h.impl.drainAutoApprovals(BOARD);
      expect(actions(h)[0].state).toBe("pending");
      expect(h.board.applied).toEqual([]);
    }));

  it("runs once when a person approves it, and nothing when a person rejects it", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      await request(h, ada);
      await request(h, ada, "moveIssue", { ...INPUT, expectedRevision: "8" });
      let [first, second] = actions(h);
      await h.impl.applyPendingAction(first, { type: "user", id: OWNER, name: "Owner" }, false);
      await h.impl.rejectPendingAction(second);
      expect(h.board.applied).toEqual([first.action]);
      expect(h.impl.storage.actions.get(first.id).state).toBe("approved");
      expect(h.impl.storage.actions.get(second.id).state).toBe("rejected");
    }));
});

describe("refused, asking the board nothing (FAC-14 K2)", () => {
  it("an undeclared command, and one declared but not bound", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      await refusedAsking(h, request(h, ada, "deleteIssue"), /offers no tool by that name/);
      await refusedAsking(h, request(h, ada, "moveAgain"), /offers no tool by that name/);
    }));

  it("a person without use here, and one whose page shows another console", () =>
    withConsole(async h => {
      await refusedAsking(h, request(h, operator(h, "stranger")), NO_CONSOLE_TOOL_ACCESS);
      let ada = operator(h, "ada", "use");
      h.people.get(uid("ada"))!.page = page(h, { consoleId: "another-console" });
      await refusedAsking(h, request(h, ada), /is not open in your operate session/);
    }));

  it("a forged caller: another person's profile, or this workspace named as the session", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      operator(h, "bob", "use");
      await refusedAsking(h, request(h, { ...ada, profileId: "bob" }), UNVERIFIED_CONSOLE_TOOL_CALLER);
      await refusedAsking(h, request(h, { ...ada, sessionWorkspaceId: h.workspaceId }), UNVERIFIED_CONSOLE_TOOL_CALLER);
    }));

  it("a person of a second company, or a connection whose company can't be told", () =>
    withConsole(async h => {
      h.flags.SHARED_CONFIGURATION_GATEKEEPER = "inferops";
      let eve = operator(h, "eve", "use", "other-tenant");
      await refusedAsking(h, request(h, eve), COMMAND_OTHER_COMPANY);
      let ada = operator(h, "ada", "use");
      h.board.company = null;
      await refusedAsking(h, request(h, ada), COMMAND_OTHER_COMPANY);
      h.board.company = "acme-tenant";
      expect((await request(h, ada)).status).toBe("ok");
      expect(h.board.transitions).toHaveLength(1);
    }));

  it("an input the template doesn't take", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      await refusedAsking(h, request(h, ada, "moveIssue", { ...INPUT, expectedRevision: "07" }), /does not match tool moveIssue/);
      await refusedAsking(h, request(h, ada, "moveIssue", { ...INPUT, title: "x" }), /does not match tool moveIssue/);
    }));

  it("an offer withdrawn while the request was being checked: the final check stops it before the board", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      // A republish that drops the binding lands during the page read, the last await before the
      // final, await-free check (`stillOffered`). The page still shows the old revision.
      h.people.get(uid("ada"))!.onPage = async () => { await h.publish(h.content()); };
      await refusedAsking(h, request(h, ada), /The console changed or your access ended during the call/);
    }));

  it("a binding whose connection is gone by the time it is requested", () =>
    withConsole(async h => {
      let ada = operator(h, "ada", "use");
      h.impl.storage.gatekeepers.delete(BOARD);
      await refusedAsking(h, request(h, ada), /cannot be requested now/);
    }));
});

describe("binding at publication (FAC-14 K2)", () => {
  it("refuses a command the widget doesn't declare, and a connection that isn't one of this workspace's boards", () =>
    withConsole(async h => {
      await expect(h.publish(h.content([{ name: "deleteIssue", gatekeeperId: BOARD }]))).rejects.toThrow(/is not one its widget declares/);
      await expect(h.publish(h.content([{ name: "moveIssue", gatekeeperId: ELSEWHERE }]))).rejects.toThrow(/is not an InferOps board/);
      await expect(h.publish(h.content([{ name: "moveIssue", gatekeeperId: 999 }]))).rejects.toThrow(/is not one of this workspace's/);
    }));

  it("offers nothing once a later publication drops the binding", () =>
    withConsole(async h => {
      h.published = await h.publish(h.content());
      h.widget = h.published.published!.content.widgets![0]!.gadgetId;
      await refusedAsking(h, request(h, operator(h, "ada", "use")), /offers no tool by that name/);
    }));
});


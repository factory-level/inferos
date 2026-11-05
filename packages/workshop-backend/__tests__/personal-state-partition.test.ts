// FAC-88: a person's presentation state (the operate page, with its selection and flow position,
// and their widget local states) is theirs alone and belongs to the company they work in. The
// company comes from the person's own connected accounts, never from a caller: when it changes,
// the former company's presentation state is dropped, not kept and not restored on switching back.
// Business records are never held here; the page names references only.
import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { INITIAL_OPERATE_PAGE, type OperateEvent, type OperateFlowPage } from "@gadgets/workshop-shared/operate-session";
import { widgetStateKey, type WidgetStateMachine } from "@gadgets/workshop-shared/widget-state";
import { presentationCompanyOf, type UserDurableObject } from "../src/user.js";
import type { SubjectPresenceDurableObject } from "../src/subject-presence.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_SUBJECT_PRESENCE: DurableObjectNamespace<SubjectPresenceDurableObject>;
  }
}

const MACHINE: WidgetStateMachine = {
  version: 1, initial: "viewing", persistence: "person",
  states: ["viewing", "editing"],
  transitions: [{ event: "edit", from: "viewing", to: "editing" }, { event: "cancel", from: "editing", to: "viewing" }],
};
const REF = { workspaceId: "console-ws", consoleId: "intake", revision: "3", gadgetId: 41 };
const KEY = widgetStateKey(REF);
const PAGES: OperateFlowPage[] = [
  { name: "intake", states: ["empty", "filled"], routes: [{ label: "Review", to: "review" }] },
  { name: "review", routes: [{ label: "Send back", to: "intake" }] },
];
const START: OperateEvent = {
  type: "startFlow", workspaceId: "console-ws", flowId: "claims", title: "Claims",
  steps: ["scr-intake", "scr-review"], pages: PAGES,
};
const BOARD = { workspaceId: "console-ws", boardRef: "inferops://acme.operations/project/board/ENG" };

/** A person whose connected accounts currently say they work in `company.now`. */
async function person(company: { now: string }) {
  let user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, (instance: UserDurableObject) => {
    instance.presentationCompanyReader = async () => company.now;
  });
  return user;
}

/** Moves a person's page and widget: a flow at its second page, and the widget in `editing`. */
async function workOn(user: DurableObjectStub<UserDurableObject>) {
  let page = await user.getOperatePage();
  page = await user.dispatchOperateEvent(START, page.seq, "person");
  page = await user.dispatchOperateEvent({ type: "navigateFlow", to: "review" }, page.seq, "person");
  await user.transitionWidgetState(KEY, MACHINE, "edit", 0);
  return page;
}

const code = async (operation: PromiseLike<unknown>) => {
  try { await operation; return "accepted"; } catch (error) { return getOperateSessionErrorCode(error) ?? String(error); }
};

describe("two people in one company", () => {
  it("move their own page, flow and widget without changing each other's", async () => {
    let company = { now: "tenant-a" };
    let a = await person(company);
    let b = await person(company);
    let bBefore = await b.getOperatePage();
    let aPage = await workOn(a);
    // A's flow is on its second page, with the first in its back history.
    expect(aPage.state.flow?.index).toBe(1);
    expect(aPage.state.flow?.history).toEqual([0]);
    expect(await b.getOperatePage()).toEqual(bBefore);
    expect((await b.readWidgetState(KEY, MACHINE)).state).toBe("viewing");
    // B moving changes nothing of A's.
    await b.transitionWidgetState(KEY, MACHINE, "edit", 0);
    await b.transitionWidgetState(KEY, MACHINE, "cancel", 1);
    expect((await a.readWidgetState(KEY, MACHINE)).state).toBe("editing");
    expect((await a.getOperatePage()).state.flow?.pageState).toBe(aPage.state.flow?.pageState);
  });

  it("gives B only B's own state for the very reference A's is kept under", async () => {
    let company = { now: "tenant-a" };
    let a = await person(company);
    let b = await person(company);
    await workOn(a);
    // The widget reference names a console and install, never a person: the same key read by B is B's.
    expect(await b.readWidgetState(KEY, MACHINE)).toEqual({ state: "viewing", seq: 0, events: ["edit"] });
    expect((await b.getOperatePage()).state.flow).toBeNull();
    expect(await b.listOperateEvents(0, 50)).toEqual([]);
  });
});

describe("one person in two companies", () => {
  it("sees nothing of company 1 after switching to company 2, and starts afresh on switching back", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    await workOn(user);
    let selected = await user.getOperatePage();
    expect(selected.state.flow).not.toBeNull();

    company.now = "tenant-b";
    let inB = await user.getOperatePage();
    expect(inB.state).toEqual(INITIAL_OPERATE_PAGE);
    expect(inB.seq).toBeGreaterThan(selected.seq);
    expect((await user.readWidgetState(KEY, MACHINE)).state).toBe("viewing");
    // Nor can company 1's history be listed from company 2.
    let log = await user.listOperateEvents(0, 50);
    expect(log.map(record => record.event.type)).toEqual(["companyChanged"]);

    // Work in company 2, then switch back: the documented policy is a reset, never a restore.
    let page = await user.dispatchOperateEvent({ type: "setChatOpen", open: false }, inB.seq, "person");
    expect(page.state.chatOpen).toBe(false);
    company.now = "tenant-a";
    expect((await user.getOperatePage()).state).toEqual(INITIAL_OPERATE_PAGE);
    expect((await user.readWidgetState(KEY, MACHINE)).state).toBe("viewing");
  });

  it("drops the former company's state before any write lands, an agent's included", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    let before = await workOn(user);
    company.now = "tenant-b";
    // A client still holding company 1's page writes at its seq: a conflict, never applied unseen.
    expect(await code(user.dispatchOperateEvent({ type: "backFlow" }, before.seq, "person")))
      .toBe(OPERATE_SESSION_ERROR_CODES.conflict);
    // The agent acts on whatever page is current: company 2's fresh one, not company 1's.
    let page = await user.dispatchOperateEvent({ type: "setChatOpen", open: false }, null, "agent");
    expect(page.state.flow).toBeNull();
    expect(page.seq).toBe(before.seq + 2);
    // A widget transition at company 1's seq is refused the same way, and the widget is fresh.
    expect(await code(user.transitionWidgetState(KEY, MACHINE, "cancel", 1))).toMatch(/WIDGET_STATE_CONFLICT/);
    expect((await user.transitionWidgetState(KEY, MACHINE, "edit", 0)).state).toBe("editing");
  });

  it("drops state from before any company was recorded, rather than give it to the first one read", async () => {
    let company = { now: "tenant-x" };
    let user = await person(company);
    await workOn(user);
    let workspace = await user.claimOperateSessionWorkspace("legacy-ws");
    // As a user DO from before FAC-88: the state is there, and no company is recorded beside it.
    await runInDurableObject(user, (instance: UserDurableObject) => {
      (instance as unknown as { storage: { presentationCompany: { put(v: null): void } } })
        .storage.presentationCompany.put(null);
    });
    company.now = "tenant-y";
    expect((await user.getOperatePage()).state).toEqual(INITIAL_OPERATE_PAGE);
    expect((await user.readWidgetState(KEY, MACHINE)).state).toBe("viewing");
    expect((await user.listOperateEvents(0, 50)).map(record => record.event.type)).toEqual(["companyChanged"]);
    expect(await user.operateSessionWorkspaceId()).toBeNull();
    expect(await user.claimOperateSessionWorkspace("fresh-ws")).not.toBe(workspace);
  });

  it("starts a fresh operate session workspace in each company, and never hands back the old one", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    expect(await user.claimOperateSessionWorkspace("ws-a")).toBe("ws-a");
    expect(await user.claimOperateSessionWorkspace("unused")).toBe("ws-a");
    company.now = "tenant-b";
    // The chat and its agent's context belong to company A's workspace: company B gets a new one.
    expect(await user.operateSessionWorkspaceId()).toBeNull();
    expect(await user.claimOperateSessionWorkspace("ws-b")).toBe("ws-b");
    // Retired, the old one is neither listed nor the session's, also after switching back.
    company.now = "tenant-a";
    expect(await user.claimOperateSessionWorkspace("ws-a2")).toBe("ws-a2");
    let listed = (await user.listGadgets()).map(gadget => gadget.id);
    for (let id of ["ws-a", "ws-b", "ws-a2"]) expect(listed).not.toContain(id);
    expect(await user.getGadget("ws-a")).toBeFalsy();
  });

  it("names the company a handover compares, after moving to it", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    expect(await user.currentPresentationCompany()).toBe("tenant-a");
    company.now = "tenant-b";
    expect(await user.currentPresentationCompany()).toBe("tenant-b");
  });

  it("keeps the state while the company stays the same", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    let page = await workOn(user);
    expect((await user.getOperatePage()).seq).toBe(page.seq);
    expect((await user.readWidgetState(KEY, MACHINE)).state).toBe("editing");
  });

  it("refuses rather than guessing when the company can't be told", async () => {
    let user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, (instance: UserDurableObject) => {
      instance.presentationCompanyReader = async () => { throw new Error("gatekeeper down"); };
    });
    expect(await code(user.getOperatePage())).toBe(OPERATE_SESSION_ERROR_CODES.companyUnavailable);
    expect(await code(user.readWidgetState(KEY, MACHINE))).toBe(OPERATE_SESSION_ERROR_CODES.companyUnavailable);
    expect(await code(user.dispatchOperateEvent({ type: "setChatOpen", open: false }, 0, "person")))
      .toBe(OPERATE_SESSION_ERROR_CODES.companyUnavailable);
  });

  it("refuses a dispatched companyChanged: only the kernel resets a page", async () => {
    let user = await person({ now: "tenant-a" });
    for (let actor of ["person", "agent"] as const) {
      expect(await code(user.dispatchOperateEvent({ type: "companyChanged" } as OperateEvent, null, actor)))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
  });
});

describe("a handover", () => {
  const HANDOVER = {
    id: "h1", from: { id: "alice", name: "Alice" }, to: { id: "bob", name: "Bob" },
    boardRef: BOARD.boardRef, issueId: null, note: "Yours",
  };

  it("is refused, appending nothing, when the recipient now works in another company", async () => {
    // The sender read company A; the recipient switched to B before the handover arrived.
    let company = { now: "tenant-b" };
    let recipient = await person(company);
    await recipient.dispatchOperateEvent({ type: "setChatOpen", open: false }, 0, "person");
    let before = await recipient.listOperateEvents(0, 50);
    expect(await code(recipient.receiveHandover(HANDOVER, "tenant-a"))).toBe(OPERATE_SESSION_ERROR_CODES.recipientUnavailable);
    expect(await recipient.listOperateEvents(0, 50)).toEqual(before);
    expect((await recipient.getOperatePage()).state.handovers).toEqual([]);
  });

  it("compares the company it resolves in the same step as the append, whenever the switch lands", async () => {
    // The recipient's company read is held open; the switch to B lands while it is pending, so
    // the company compared, and the page appended to, are B's: the handover from A is refused.
    let company = { now: "tenant-a" };
    let recipient = await person(company);
    await recipient.getOperatePage();
    let release!: () => void;
    let held = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(recipient, (instance: UserDurableObject) => {
      instance.presentationCompanyReader = async () => { await held; return company.now; };
    });
    let delivery = code(recipient.receiveHandover(HANDOVER, "tenant-a"));
    company.now = "tenant-b";
    release();
    expect(await delivery).toBe(OPERATE_SESSION_ERROR_CODES.recipientUnavailable);
    expect((await recipient.listOperateEvents(0, 50)).map(record => record.event.type)).toEqual(["companyChanged"]);
  });

  it("is appended for a recipient in the sender's company", async () => {
    let recipient = await person({ now: "tenant-a" });
    let page = await recipient.receiveHandover(HANDOVER, "tenant-a");
    expect(page.state.handovers.map(handover => handover.id)).toEqual(["h1"]);
  });

  it("is never dispatched: only receiveHandover records one", async () => {
    let recipient = await person({ now: "tenant-a" });
    for (let actor of ["person", "agent"] as const) {
      expect(await code(recipient.dispatchOperateEvent({ type: "handoverReceived", handover: HANDOVER }, null, actor)))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    }
  });
});

describe("streams a company switch ends or keeps", () => {
  it("keeps the page stream, which from the switch on carries only the new company's page", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    await workOn(user);
    let updates: { state: unknown }[] = [];
    let stub = new NativeRpcStub((update: { state: unknown }) => { updates.push(update); });
    using _subscription = await user.subscribeOperateSession(stub as never);
    await scheduler.wait(10);
    let before = updates.length;
    company.now = "tenant-b";
    await user.getOperatePage();
    await user.dispatchOperateEvent({ type: "setChatOpen", open: false }, null, "person");
    await scheduler.wait(10);
    let after = updates.slice(before);
    expect(after.length).toBe(2);
    expect(after[0]!.state).toEqual(INITIAL_OPERATE_PAGE);
    expect(after[1]!.state).toEqual({ ...INITIAL_OPERATE_PAGE, chatOpen: false });
  });

  it("takes the person out of the former board's live presence before serving anything", async () => {
    let company = { now: "tenant-a" };
    let user = await person(company);
    let alice = { type: "user" as const, id: `alice-${crypto.randomUUID()}`, name: "Alice" };
    let board = `${BOARD.boardRef}-${crypto.randomUUID()}`;
    await runInDurableObject(user, (instance: UserDurableObject) => {
      (instance as unknown as { storage: { profile: { put(p: typeof alice): void } } }).storage.profile.put(alice);
    });
    // The same namespace the user DO reaches through ctx.exports.
    let presence = env.TEST_SUBJECT_PRESENCE.getByName(board);
    let page = await user.getOperatePage();
    await user.dispatchOperateEvent({ type: "openBoard", board: { ...BOARD, boardRef: board } }, page.seq, "person");
    // Alice's tab, and Bob watching the same board.
    let aliceSeen: string[] = [];
    let aliceTab = new NativeRpcStub({
      init: async () => { aliceSeen.push("init"); }, add: async () => { aliceSeen.push("add"); },
      remove: async () => { aliceSeen.push("remove"); }, onRpcBroken() {},
    });
    let bobRoster: string[][] = [];
    let bobTab = new NativeRpcStub({
      init: async (people: { user: { id: string } }[]) => { bobRoster.push(people.map(p => p.user.id)); },
      add: async () => {}, remove: async () => { bobRoster.push(["removed"]); }, onRpcBroken() {},
    });
    await presence.join(alice, null, aliceTab);
    await presence.join({ type: "user", id: "bob", name: "Bob" }, null, bobTab);
    await scheduler.wait(10);
    let seenBefore = aliceSeen.length;

    company.now = "tenant-b";
    await user.getOperatePage();
    await scheduler.wait(10);
    // Bob saw Alice leave; a later join on that board reaches only Bob.
    expect(bobRoster.at(-1)).toEqual(["removed"]);
    await presence.join({ type: "user", id: "carol", name: "Carol" }, null, new NativeRpcStub({
      init: async () => {}, add: async () => {}, remove: async () => {}, onRpcBroken() {},
    }));
    await scheduler.wait(10);
    expect(aliceSeen.length).toBe(seenBefore);
  });
});

describe("business records stay shared", () => {
  it("holds only a board reference on each page, so both read the same board live", async () => {
    let company = { now: "tenant-a" };
    let a = await person(company);
    let b = await person(company);
    for (let user of [a, b]) {
      let page = await user.getOperatePage();
      page = await user.dispatchOperateEvent({ type: "openBoard", board: BOARD }, page.seq, "person");
      expect(page.state.board).toEqual({ ...BOARD, issueId: null });
    }
  });
});

describe("the company a person works in", () => {
  type Records = Parameters<typeof presentationCompanyOf>[0];
  const account = (id: number, answer: string | null | Error, vendorId = "inferops") => ({
    id, vendorId, description: {}, credentialsExpired: id === 9,
    account: { presentationCompany: async () => { if (answer instanceof Error) throw answer; return answer; } },
  }) as unknown as Records extends Iterable<infer R> ? R : never;

  it("is one partition for a deployment that names no company gatekeeper", async () => {
    expect(await presentationCompanyOf([account(1, "tenant-a")], null)).toBe("");
  });

  it("comes from the person's own accounts of that vendor, expired ones included", async () => {
    expect(await presentationCompanyOf([], "inferops")).toBe("");
    expect(await presentationCompanyOf([account(1, "tenant-a", "google")], "inferops")).toBe("");
    expect(await presentationCompanyOf([account(9, "tenant-a")], "inferops")).toBe("tenant-a");
    expect(await presentationCompanyOf([account(1, null), account(2, "tenant-a")], "inferops")).toBe("tenant-a");
    expect(await presentationCompanyOf([account(1, "tenant-a"), account(2, "tenant-a")], "inferops")).toBe("tenant-a");
  });

  it("is its own partition for accounts in several companies, whatever their order", async () => {
    let both = await presentationCompanyOf([account(1, "tenant-b"), account(2, "tenant-a")], "inferops");
    expect(both).toBe(await presentationCompanyOf([account(2, "tenant-a"), account(1, "tenant-b")], "inferops"));
    expect(both).not.toBe("tenant-a");
    expect(both).not.toBe("tenant-b");
  });

  it("can't be told when any account fails to answer", async () => {
    await expect(presentationCompanyOf([account(1, "tenant-a"), account(2, new Error("down"))], "inferops"))
      .rejects.toThrow();
  });
});

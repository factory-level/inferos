// FAC-116 (inferos ADR 0012, proposed): a requested run's settled result moves the requester's page
// only when it reaches a page that's open, at most once per run and attachment, and only while that
// page still shows the console and screen the move was checked against. A page that isn't open
// keeps the move only in memory, briefly, for a reconnect of the same session; a later reopen never
// moves it. Over the person's real user DO.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import type { OperateEvent, RunNavigationRequest } from "@gadgets/workshop-shared/operate-session";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const OPEN: OperateEvent = { type: "openConsole", workspaceId: "console-ws", consoleId: "intake", title: "Intake",
  source: "published", revision: "3", fullChat: "off", viewId: "v-form" };

async function person(setUp: OperateEvent[] = [OPEN, { type: "showScreen", screenId: "form" }]) {
  let user = env.TEST_USER.getByName(crypto.randomUUID());
  for (let event of setUp) {
    let { seq } = await user.getOperatePage();
    await user.dispatchOperateEvent(event, seq, "person");
  }
  return user;
}

/** A page subscriber, as an open tab is; dispose it to close the tab. */
async function open(user: Awaited<ReturnType<typeof person>>) {
  let updates: number[] = [];
  let subscription = await user.subscribeOperateSession(new RpcStub((update: { seq: number }) => { updates.push(update.seq); }) as never);
  return { updates, close: () => subscription[Symbol.dispose]() };
}

async function request(user: Awaited<ReturnType<typeof person>>, overrides: Partial<RunNavigationRequest> = {}): Promise<RunNavigationRequest> {
  return {
    workspaceId: "console-ws", consoleId: "intake", revision: "3", pageSeq: (await user.getOperatePage()).seq,
    invocationId: "inv-1", attachmentId: "done", move: { type: "openView", viewId: "v-done" }, ...overrides,
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("a run's result moving an open page (FAC-116)", () => {
  it("moves an open page once, recorded as the run's, and a duplicate is a no-op", async () => {
    let user = await person();
    let tab = await open(user);
    let asked = await request(user);
    expect(await user.applyRunNavigation(asked)).toBe("shown");
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-done" });
    let last = (await user.listOperateEvents(0, 50)).at(-1)!;
    expect(last).toMatchObject({ event: { type: "openView", viewId: "v-done" }, actor: "workflow-run" });
    // The same run's result again, even checked against the new page, moves nothing.
    expect(await user.applyRunNavigation(await request(user))).toBe("already");
    expect((await user.listOperateEvents(0, 50)).at(-1)!.seq).toBe(last.seq);
    tab.close();
  });

  it("refuses a page that moved, another console or revision, or a running flow, moving nothing", async () => {
    let user = await person();
    let tab = await open(user);
    let before = (await user.getOperatePage()).seq;
    expect(await user.applyRunNavigation(await request(user, { pageSeq: before - 1 }))).toBe("refused");
    expect(await user.applyRunNavigation(await request(user, { revision: "2", invocationId: "inv-2" }))).toBe("refused");
    expect(await user.applyRunNavigation(await request(user, { consoleId: "other", invocationId: "inv-3" }))).toBe("refused");
    expect(await user.applyRunNavigation(await request(user, { move: { type: "openConsole" } as never, invocationId: "inv-4" }))).toBe("refused");
    expect((await user.getOperatePage()).seq).toBe(before);
    // A refused one can be delivered later; it isn't marked as applied.
    expect(await user.applyRunNavigation(await request(user, { invocationId: "inv-2" }))).toBe("shown");
    tab.close();
  });

  it("doesn't move a closed page, but applies the move when the same session reconnects unchanged", async () => {
    let user = await person();
    expect(await user.applyRunNavigation(await request(user))).toBe("not-open");
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-form" });
    let tab = await open(user);
    await settle();
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-done" });
    expect((await user.listOperateEvents(0, 50)).at(-1)).toMatchObject({ actor: "workflow-run" });
    tab.close();
  });

  it("doesn't apply a waiting move once the page moved on, even when it reconnects", async () => {
    let user = await person();
    expect(await user.applyRunNavigation(await request(user))).toBe("not-open");
    // The person moved the page themselves before reconnecting.
    let { seq } = await user.getOperatePage();
    await user.dispatchOperateEvent({ type: "showScreen", screenId: "review" }, seq, "person");
    let tab = await open(user);
    await settle();
    expect((await user.getOperatePage()).state.console).toMatchObject({ viewId: "v-form", screenId: "review" });
    tab.close();
  });
});

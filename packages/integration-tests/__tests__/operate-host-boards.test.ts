// Host boards (MVP-26 slice 2, kernel): a console offers a host-rendered board, and each operator
// reads it through a connection they selected themselves, in their own operate session workspace,
// never through the publisher's or the console workspace's.
//
// The real Workshop and InferOps gatekeeper Worker, against the fake InferLab and InferOps
// (src/inferops-fake.ts, serving `project.board_snapshot` with per-person synthetic boards) behind
// the network interceptor, with per-person accounts from the real connect flow. All data is synthetic.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, ConsoleHostBoard, OperateSession } from "@gadgets/workshop-shared/api";
import type { ConsoleRef, HostBoardSelectionUpdate, OperateConsole, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import { startHarness, type Harness } from "../src/harness.js";
import { INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, boardUrl, type FakePerson, type WorkspaceSlug } from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, logIn, nextUsernames, signUp, callbackStubFor, waitFor, type ConnectedAccount } from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG = boardUrl("operations", "ENG");
const WEB = boardUrl("operations", "WEB");

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;
const holds: { release: () => void }[] = [];

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars,
          INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
          INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops",
          INFEROPS_HOST_BOARDS: "true",
        };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", INFEROPS_HOST_BOARDS: "true" };
    },
  });
});

afterAll(async () => {
  for (const hold of holds) hold.release();
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson; account: ConnectedAccount };

async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

/** A Workshop user with an InferOps account connected as a fresh synthetic InferLab person. */
async function newUser(prefix: string, workspaces: WorkspaceSlug[] = ["operations"]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  await api.completeConnectHandoff(await signInTicket(url, person), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person, account };
}

/** Reconnect the user's account as the same person (same account id, new connection). */
async function reconnect(user: User): Promise<void> {
  const { url, nonce } = await user.api.reconnectAccount(user.account.id);
  const ticket = await signInTicket(url, user.person);
  using popup = await logIn(connect(harness.url), user.username);
  await popup.completeConnectHandoff(ticket, nonce);
}

const snapshotRequestsOf = (person: FakePerson) => fake.requests.filter(r =>
  r.path.startsWith("/project/board-snapshot") && r.token !== null && fake.accessTokensOf(person).includes(r.token));

const hostBoard = (target = ENG, name = "board") =>
  ({ kind: "host-board" as const, label: "Board", requirement: { name, resource: "inferops-board" as const, target } });

/**
 * A publisher's console workspace: the publisher's own ENG connection (which operators must never
 * use), a screen, and a published console offering one host board, shared for use with `operators`.
 */
async function consoleSpace(publisher: User, operators: User[], hostBoards = [hostBoard()]) {
  const ws = await publisher.api.newGadget();
  if (!await ws.newGatekeeper(publisher.account.id, ENG)) throw new Error("The publisher could not connect ENG");
  const screen = await ws.createCanvas({ title: "Floor", sections: [] });
  const content: OperateConsoleContent = { title: "Floor", fullChat: "off",
    views: [{ id: "floor", title: "Floor", type: "screen", screen: screen.id }], hostBoards };
  const draft = await ws.createConsole(content);
  const published = await ws.publishConsole(draft.id, draft.revision);
  for (const operator of operators) expect(await ws.addCollaborator(operator.username, "use")).toBeTruthy();
  const { id: workspaceId } = await ws.getMetadata();
  return { ws, workspaceId, published };
}

async function openConsole(session: RpcStub<OperateSession>, workspaceId: string, shown: OperateConsole,
    source: "published" | "draft" = "published") {
  const { seq } = await session.listEvents(0, 200).then(events => ({ seq: events.at(-1)?.seq ?? 0 }));
  await session.dispatch({ type: "openConsole", workspaceId, consoleId: shown.id, title: shown.title, source,
    revision: shown.revision, fullChat: shown.fullChat, viewId: shown.views[0]!.id }, seq);
}

const refOf = (shown: OperateConsole, source: "published" | "draft" = "published"): ConsoleRef =>
  ({ consoleId: shown.id, source, revision: shown.revision });

/** The operator opens the console, selects their own account for its board, and gets the handle. */
async function operatorBoard(operator: User, workspaceId: string, published: OperateConsole, select = true) {
  const session = await operator.api.getOperateSession();
  await openConsole(session, workspaceId, published);
  const entryId = published.hostBoards![0]!.id!;
  if (select) {
    expect(await session.selectHostBoardConnection(refOf(published), entryId, operator.account.id,
      `sel-${operator.username}`)).toEqual({ status: "selected" });
  }
  const board: RpcStub<ConsoleHostBoard> = await session.getConsoleHostBoard(refOf(published), entryId);
  return { session, board, entryId };
}

const elapsed = async (work: () => Promise<unknown>) => {
  const start = Date.now();
  const result = await work();
  return { result, ms: Date.now() - start };
};

describe("host boards", () => {
  it("reads each operator's own board with their own bearer, never the publisher's, and audits privately", async () => {
    const publisher = await newUser("hbpublisher");
    const [alice, bob] = [await newUser("hbalice"), await newUser("hbbob")];
    fake.boardNameFor.set(alice.username, "Alice's synthetic board");
    fake.boardNameFor.set(bob.username, "Bob's synthetic board");
    const { ws, workspaceId, published } = await consoleSpace(publisher, [alice, bob]);
    expect(published.published!.content.hostBoards).toEqual([{ ...hostBoard(), id: expect.any(String) }]);

    const a = await operatorBoard(alice, workspaceId, published);
    const b = await operatorBoard(bob, workspaceId, published);
    const readA = await a.board.readRequirement("board");
    const readB = await b.board.readRequirement("board");
    expect(readA).toMatchObject({ status: "ok", publicationRevision: published.revision,
      board: { project: { identifier: "ENG", name: "Alice's synthetic board" } } });
    expect(readB).toMatchObject({ status: "ok", board: { project: { name: "Bob's synthetic board" } } });
    expect(snapshotRequestsOf(alice.person).length).toBeGreaterThan(0);
    expect(snapshotRequestsOf(bob.person).length).toBeGreaterThan(0);
    expect(snapshotRequestsOf(publisher.person)).toEqual([]);

    // The audit is the reader's own, with exactly the allowlisted fields.
    const audit = await a.session.listHostBoardReads();
    expect(audit).toEqual([{ kind: "host-board-read", consoleId: published.id, entryId: a.entryId,
      requirementName: "board", status: "ok", at: expect.any(String) }]);
    // Nothing about the read lands in the console workspace, or in the reader's action log.
    expect((await ws.listActions({ filter: "all" })).entries).toEqual([]);
    using own = await a.session.getWorkspace();
    expect((await own.listActions({ filter: "all" })).entries).toEqual([]);
  });

  it("is not-connected without a selection, after a disconnect, and unavailable once the provider refuses", async () => {
    const publisher = await newUser("hbncpublisher");
    const operator = await newUser("hbncoperator");
    const { workspaceId, published } = await consoleSpace(publisher, [operator]);
    const unselected = await operatorBoard(operator, workspaceId, published, false);
    // Before any selection the operator's session workspace has no host-board state, so this
    // read is not-connected without an audit record.
    expect(await unselected.board.readRequirement("board")).toEqual({ status: "not-connected" });
    expect(snapshotRequestsOf(operator.person)).toEqual([]);

    expect(await unselected.session.selectHostBoardConnection(refOf(published), unselected.entryId,
      operator.account.id, "nc-1")).toEqual({ status: "selected" });
    expect((await unselected.board.readRequirement("board")).status).toBe("ok");
    // The operator leaves the workspace: the target is the publisher's alone now.
    fake.setWorkspaces(operator.person, []);
    expect(await unselected.board.readRequirement("board")).toEqual({ status: "unavailable" });
    fake.setWorkspaces(operator.person, ["operations"]);
    await operator.api.disconnectAccount(operator.account.id);
    expect(await unselected.board.readRequirement("board")).toEqual({ status: "not-connected" });
    expect((await unselected.session.listHostBoardReads()).map(entry => entry.status))
      .toEqual(["not-connected", "unavailable", "ok"]);
  });

  it("refuses forged entries, names, revisions, accounts and request keys", async () => {
    const publisher = await newUser("hbfpublisher");
    const operator = await newUser("hbfoperator");
    const { workspaceId, published } = await consoleSpace(publisher, [operator]);
    const { session, board, entryId } = await operatorBoard(operator, workspaceId, published, false);
    await expect(session.getConsoleHostBoard(refOf(published), "forged")).rejects.toThrow(/not open/);
    await expect(session.getConsoleHostBoard({ ...refOf(published), revision: "0" }, entryId)).rejects.toThrow(/not open/);
    await expect(session.getConsoleHostBoard(refOf(published, "draft"), entryId)).rejects.toThrow(/not open/);
    await expect(board.readRequirement("other")).rejects.toThrow(/no requirement/);
    // Another person's account id is not the caller's.
    expect(await session.selectHostBoardConnection(refOf(published), entryId, publisher.account.id + 1000, "f-1"))
      .toEqual({ status: "failed" });
    expect(await session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "f-2"))
      .toEqual({ status: "selected" });
    // A same-key retry returns the outcome; reusing the key for another payload is refused.
    expect(await session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "f-2"))
      .toEqual({ status: "selected" });
    await expect(session.selectHostBoardConnection(refOf(published), entryId, operator.account.id + 1, "f-2"))
      .rejects.toThrow(/different selection/);
    // A forged entry id cannot be saved either: ids are minted by the server.
    await expect(publisher.api.newGadget().then(ws => ws.createCanvas({ title: "S", sections: [] }).then(screen =>
      ws.createConsole({ title: "F", fullChat: "off", views: [{ id: "v", title: "V", type: "screen", screen: screen.id }],
        hostBoards: [{ ...hostBoard(), id: "made-up" }] })))).rejects.toThrow(/not this console's/);
  });

  it("discards a paused read released after a reconnect, a selection change, a console move or a republish", async () => {
    const publisher = await newUser("hbppublisher");
    const operator = await newUser("hbpoperator");
    const { ws, workspaceId, published } = await consoleSpace(publisher, [operator]);
    const { session, board, entryId } = await operatorBoard(operator, workspaceId, published);
    const paused = async (change: () => Promise<unknown>) => {
      const hold = fake.holdSnapshots();
      holds.push(hold);
      const reading = board.readRequirement("board");
      await hold.arrived;
      await change();
      hold.release();
      return reading;
    };
    expect(await paused(() => reconnect(operator))).toEqual({ status: "stale" });
    expect(await paused(() => session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "p-2")))
      .toEqual({ status: "stale" });
    expect(await paused(async () => {
      const seq = (await session.listEvents(0, 200)).at(-1)!.seq;
      await session.dispatch({ type: "showScreen", screenId: null }, seq);
    })).toEqual({ status: "stale" });
    expect(await paused(() => ws.publishConsole(published.id, published.revision))).toEqual({ status: "stale" });
    // None of them was audited.
    expect(await session.listHostBoardReads()).toEqual([]);
  });

  it("answers unavailable at the 10 s deadline for a stalled fetch or body, and never lands the late answer", async () => {
    const publisher = await newUser("hbspublisher");
    const operator = await newUser("hbsoperator");
    const { workspaceId, published } = await consoleSpace(publisher, [operator]);
    const { session, board } = await operatorBoard(operator, workspaceId, published);
    for (const body of [false, true]) {
      const hold = fake.holdSnapshots({ body });
      holds.push(hold);
      const { result, ms } = await elapsed(async () => await board.readRequirement("board"));
      expect(result).toEqual({ status: "unavailable" });
      expect(ms).toBeGreaterThanOrEqual(9_500);
      expect(ms).toBeLessThan(12_500);
      // The provider answers late: nothing is returned, pinned or audited for that read.
      hold.release();
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await session.listHostBoardReads()).toEqual([]);
    }
    expect((await board.readRequirement("board")).status).toBe("ok");
  }, 60_000);

  it("refuses a target that now resolves to another project (a reused key) until the operator selects again", async () => {
    const publisher = await newUser("hbrpublisher");
    const operator = await newUser("hbroperator");
    const { workspaceId, published } = await consoleSpace(publisher, [operator]);
    const { session, board, entryId } = await operatorBoard(operator, workspaceId, published);
    expect((await board.readRequirement("board")).status).toBe("ok");
    fake.snapshotProjectId.set("ENG", "1e000000-0000-4000-8000-0000000000ff");
    try {
      expect(await board.readRequirement("board")).toEqual({ status: "not-connected" });
      expect(await session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "r-2"))
        .toEqual({ status: "selected" });
      expect((await board.readRequirement("board")).status).toBe("ok");
    } finally {
      fake.snapshotProjectId.delete("ENG");
    }
  });

  it("previews a draft with the builder's own selection only, and a draft edit invalidates it", async () => {
    const publisher = await newUser("hbvpublisher");
    const { ws, workspaceId, published } = await consoleSpace(publisher, []);
    const draft = (await ws.getConsole(published.id, "draft"))!;
    const session = await publisher.api.getOperateSession();
    await openConsole(session, workspaceId, draft, "draft");
    const entryId = draft.hostBoards![0]!.id!;
    const preview = await session.getConsoleHostBoard(refOf(draft, "draft"), entryId);
    // The console workspace's own ENG connection is never a shortcut.
    expect(await preview.readRequirement("board")).toEqual({ status: "not-connected" });
    expect(await session.selectHostBoardConnection(refOf(draft, "draft"), entryId, publisher.account.id, "v-1"))
      .toEqual({ status: "selected" });
    expect((await preview.readRequirement("board")).status).toBe("ok");
    await ws.replaceConsole(draft.id, draft.revision, { title: "Edited", fullChat: "off", views: draft.views,
      hostBoards: draft.hostBoards });
    expect(await preview.readRequirement("board")).toEqual({ status: "stale" });
  });

  it("subscribes to one entry's selection: a snapshot first, ordered full states, none on removal, unknown once the context moves", async () => {
    const publisher = await newUser("hbubpublisher");
    const operator = await newUser("hbuboperator");
    const { ws, workspaceId, published } = await consoleSpace(publisher, [operator],
      [hostBoard(), hostBoard(WEB, "web")]);
    const { session, board, entryId } = await operatorBoard(operator, workspaceId, published, false);
    const updates: HostBoardSelectionUpdate[] = [];
    using _sub = await board.subscribeSelection(callbackStubFor((update: HostBoardSelectionUpdate) => { updates.push(update); }));
    await waitFor("the first state", async () => updates.length > 0 || null);
    expect(updates[0]).toEqual({ state: "none", changeSeq: 0, selectionEpoch: null });
    await session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "u-1");
    await waitFor("the committed state", async () => updates.some(u => u.state === "selected") || null);
    const seqs = updates.flatMap(u => "changeSeq" in u ? [u.changeSeq] : []);
    expect(seqs).toEqual(seqs.toSorted((x, y) => x - y));
    expect(updates.at(-1)).toMatchObject({ state: "selected", selectionEpoch: 1 });
    // Removing the connection clears the selection.
    using own = await session.getWorkspace();
    using connection = await own.getGatekeeperByResourceUrl(ENG);
    await connection!.remove();
    await waitFor("the cleared state", async () => updates.at(-1)?.state === "none" || null);
    // A republish moves the console on. Once the operator selects again on the new revision, the
    // old subscription's next delivery says unknown, and it ends.
    const republished = await ws.publishConsole(published.id, published.revision);
    await expect(session.selectHostBoardConnection(refOf(published), entryId, operator.account.id, "u-2"))
      .rejects.toThrow(/not open/);
    await openConsole(session, workspaceId, republished);
    expect(await session.selectHostBoardConnection(refOf(republished), entryId, operator.account.id, "u-3"))
      .toEqual({ status: "selected" });
    await waitFor("a final unknown", async () => updates.at(-1)?.state === "unknown" || null);
    const ended = updates.length;
    await connection!.remove().catch(() => null);
    using again = await own.getGatekeeperByResourceUrl(ENG);
    await again?.remove();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(updates).toHaveLength(ended);
  });
});

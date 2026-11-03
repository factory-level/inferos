// An InferOps account binding (inferos ADR 0015): one `inferops://<tenant>/account` binding opens
// every board and Wiki the person's own account can open in that organization, each checked when it
// is opened, each action recording and fingerprinting the board or Wiki it was proposed on, and each
// board or Wiki read tracked as its own data set for collaborators (strategy C). Over the mock's demo
// data; the connected person's own workspaces are covered in account.test.ts.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountUrl, parseAccountUrl, resourceKind } from "../src/resources";
import type { AccountBindingProps } from "./worker";

const ACCOUNT_URL = "inferops://demo.local/account";
const DEMO_BOARD = "inferops://demo.local/project/board/DEMO";
const ENG_BOARD = "inferops://demo.local/project/board/ENG";
const DEMO_WIKI = "inferops://demo.local/knowledge/wiki";
const NO_SUCH_BOARD = "NOT_FOUND: No such InferOps board is available to this connection.";
const NO_SUCH_WIKI = "NOT_FOUND: No such InferMind Wiki is available to this connection.";

const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const ENG_41 = "30000000-0000-4000-8000-000000000021";
const READY = "20000000-0000-4000-8000-000000000001";
const WORKING = "20000000-0000-4000-8000-000000000002";
const PURPOSE = "61000000-0000-4000-8000-000000000001";
const HANDBOOK = "60000000-0000-4000-8000-000000000001";

/** A fresh demo account (so a fresh copy of the demo data) and its account binding. */
function setup() {
  const props: AccountBindingProps = { accountId: crypto.randomUUID(), tenant: "demo.local" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
  return { props, hooks, mock, session: hooks.startAccountSession(props) };
}

/** The message an RPC call failed with, with its RPC prefix dropped, or "" when it succeeded. */
async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error).replace(/^.*?(?=NOT_FOUND|INVALID_REQUEST|CONFLICT)/, "");
  }
}

describe("the account URL", () => {
  it("is one tenant label, or demo.local, and nothing else", () => {
    expect(parseAccountUrl("inferops://acme/account")).toEqual({ tenant: "acme" });
    expect(parseAccountUrl(`${ACCOUNT_URL}/`)).toEqual({ tenant: "demo.local" });
    expect(accountUrl({ tenant: "acme" })).toBe("inferops://acme/account");
    expect(resourceKind("inferops://acme/account")).toBe("account");
    for (const url of [
      "inferops://acme.operations/account", "inferops://ACME/account", "inferops://acme:1/account",
      "inferops://acme/account/ENG", "inferops:///account", "inferops://other.local/account",
    ]) {
      expect(() => parseAccountUrl(url), url).toThrow(/expected inferops:\/\/<tenant>\/account/);
    }
  });

  it("is offered beside the other kinds, kept out of Operate chat, and binds the demo as mock data", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    const resource = (await hooks.supportedResources(account)).find(r => r.urlPattern === "inferops://*/account");
    expect(resource).toMatchObject({ title: "InferOps account", excludeFromOperateChat: true });
    expect(await hooks.boundResourcePattern(account, ACCOUNT_URL)).toBe("inferops://*/account");
    expect(await hooks.mockOf(account, ACCOUNT_URL)).toBe(true);
    expect(await hooks.configuratorFor(account, "inferops://*/account")).toBeNull();
    // An account with no person behind it (the stopgap connection) gets no account binding.
    expect(await hooks.boundResourcePattern(account, "inferops://acme/account"))
      .toBe("refused: No InferOps account is available to you in acme.");
  });

  it("describes itself as the INFEROPS binding of one organization", async () => {
    const { props, hooks } = setup();
    expect(await hooks.describeAccountBinding(props)).toMatchObject({
      url: ACCOUNT_URL, suggestedBindingName: "INFEROPS", tsType: "InferOpsAccountSession",
    });
  });
});

describe("opening boards and Wikis", () => {
  it("reads the demo boards and Wiki through one binding, each read an observation", async () => {
    const { hooks, session } = setup();

    expect((await session.openBoard(DEMO_BOARD).readBoard()).project.identifier).toBe("DEMO");
    expect((await session.openBoard(ENG_BOARD).readBoard()).project.identifier).toBe("ENG");
    expect((await session.openWiki(DEMO_WIKI).listDocuments()).map(d => d.id)).toContain(HANDBOOK);
    expect(await session.listWorkspaces()).toEqual([
      { slug: "local", name: "Demo data", product: "inferops" },
      { slug: "local", name: "Demo data", product: "infermind" },
    ]);
    const found = await session.findBoards("the platform team's kanban");
    expect(found[0]).toMatchObject({ projectKey: "ENG", boardRef: ENG_BOARD });

    expect((await hooks.log()).observations).toEqual([
      "Read InferOps board DEMO", "Read InferOps board ENG", "List InferMind Wiki pages",
      "Listed your InferOps workspaces in demo.local", "Searched InferOps boards in demo.local",
    ]);
  });

  it.each([
    ["another organization's board", "inferops://acme.operations/project/board/DEMO"],
    ["a project that does not exist", "inferops://demo.local/project/board/NOPE"],
    ["a coding dispatch reference", "inferops://demo.local/project/dispatch/DEMO"],
    ["a workflow policy reference", "inferops://demo.local/project/workflow/DEMO"],
    ["a custom table reference", "inferops://demo.local/object/table/70000000-0000-4000-8000-000000000001"],
    ["a members reference", "inferops://demo.local/portal/members"],
    ["a Wiki page reference", "inferops://demo.local/knowledge/document/handbook"],
    ["a Wiki reference", DEMO_WIKI],
    ["the account itself", ACCOUNT_URL],
    ["something that is not a reference", "https://example.com/board"],
  ])("refuses openBoard of %s with the one missing-board message", async (_, ref) => {
    const { session } = setup();
    expect(await failure(session.openBoard(ref))).toBe(NO_SUCH_BOARD);
  });

  it.each([
    ["another organization's Wiki", "inferops://acme.knowledge/knowledge/wiki"],
    ["a board reference", DEMO_BOARD],
    ["a Wiki page reference", "inferops://demo.local/knowledge/document/handbook"],
    ["a dispatch reference", "inferops://demo.local/project/dispatch/DEMO"],
  ])("refuses openWiki of %s with the one missing-Wiki message", async (_, ref) => {
    const { session } = setup();
    expect(await failure(session.openWiki(ref))).toBe(NO_SUCH_WIKI);
  });

  it("keeps a board session working after the account session that opened it is gone", async () => {
    const { props, hooks } = setup();
    const board = hooks.openBoardThenDispose(props, DEMO_BOARD);
    expect((await board.readBoard()).project.identifier).toBe("DEMO");
    await board.openIssue(DEMO_1).transition(WORKING, "1");
    expect((await hooks.log()).actions).toHaveLength(1);
  });
});

describe("actions through an account binding", () => {
  it("keeps each board's pending actions to that board", async () => {
    const { props, hooks, session } = setup();
    const demo = session.openBoard(DEMO_BOARD);
    const eng = session.openBoard(ENG_BOARD);

    await demo.openIssue(DEMO_1).transition(WORKING, "1");
    await eng.createIssue({ title: "Only on ENG" });

    const demoBoard = await demo.readBoard();
    const engBoard = await eng.readBoard();
    const titles = (board: typeof demoBoard) => board.columns.flatMap(c => c.issues.map(i => i.title));
    expect(titles(demoBoard)).not.toContain("Only on ENG");
    expect(titles(engBoard)).toContain("Only on ENG");
    expect(demoBoard.columns.find(c => c.state.id === WORKING)!.issues.map(i => i.id)).toContain(DEMO_1);
    expect(engBoard.columns.flatMap(c => c.issues).some(i => i.id === DEMO_1)).toBe(false);
    // A second session over the same binding sees the same per-board state.
    const again = await hooks.startAccountSession(props).openBoard(ENG_BOARD).readBoard();
    expect(titles(again)).toContain("Only on ENG");

    expect(await hooks.accountRawKeys(props, "scope:")).toEqual([
      "scope:board:demo.local::DEMO/action:1", "scope:board:demo.local::ENG/action:2",
    ]);
  });

  it("names the board or Wiki on its approval, and stores the target it was proposed on", async () => {
    const { props, hooks, session } = setup();
    await session.openBoard(DEMO_BOARD).openIssue(DEMO_1).transition(WORKING, "1");
    await session.openWiki(DEMO_WIKI).updateSection(PURPOSE, "Purpose, rewritten.", 1);

    const [move, edit] = (await hooks.log()).actions;
    expect(move).toMatchObject({ title: "Move DEMO-1 to Working" });
    expect(move!.labels[0]).toBe("Target");
    expect(move!.fields.Target).toBe("Board DEMO on demo.local");
    expect(edit!.fields.Target).toBe("Wiki of demo.local");
    expect(await hooks.getAccountRaw(props, "scope:board:demo.local::DEMO/action:1"))
      .toMatchObject({ scope: { kind: "board", host: "demo.local", projectKey: "DEMO" } });
    expect(await hooks.getAccountRaw(props, "scope:wiki:demo.local:/action:2"))
      .toMatchObject({ scope: { kind: "wiki", host: "demo.local" } });
  });

  it("routes approve, reject and revert by action id to the board or Wiki it belongs to", async () => {
    const { props, hooks, mock, session } = setup();
    const demo = session.openBoard(DEMO_BOARD);
    const eng = session.openBoard(ENG_BOARD);
    const wiki = session.openWiki(DEMO_WIKI);
    await demo.openIssue(DEMO_1).transition(WORKING, "1");
    await eng.createIssue({ title: "Rejected on ENG" });
    await wiki.updateSection(PURPOSE, "Purpose, approved.", 1);
    await eng.openIssue(ENG_41).update({ title: "ENG-41, renamed" }, "1");
    expect((await hooks.log()).actions.map(a => a.id)).toEqual([1, 2, 3, 4]);

    expect(await hooks.applyAccount(props, 1)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: WORKING, revision: "2" });

    await hooks.rejectAccount(props, 2);
    expect((await eng.readBoard()).columns.flatMap(c => c.issues).some(i => i.title === "Rejected on ENG"))
      .toBe(false);
    expect(await hooks.getAccountRaw(props, "actionScope:2")).toBeUndefined();

    expect(await hooks.applyAccount(props, 3)).toBeNull();
    const page = await wiki.readDocument(HANDBOOK);
    expect(page.sections.find(s => s.id === PURPOSE)).toMatchObject({ body: "Purpose, approved." });
    expect(await hooks.applyAccount(props, 4)).toBeNull();
    expect(await mock.readIssue("ENG", ENG_41)).toMatchObject({ title: "ENG-41, renamed" });

    expect(await hooks.revertAccount(props, 1)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: READY });
    expect(await hooks.revertAccount(props, 99)).toContain("never applied");
    expect(await hooks.applyAccount(props, 99)).toContain("Unknown InferOps action 99");
  });

  it("gives every action of the binding its own id and idempotency key, whatever its target", async () => {
    const { props, hooks, session } = setup();
    await session.openBoard(DEMO_BOARD).openIssue(DEMO_1).transition(WORKING, "1");
    await session.openBoard(ENG_BOARD).openIssue(ENG_41).update({ title: "Renamed" }, "1");
    await session.openWiki(DEMO_WIKI).updateSection(PURPOSE, "Purpose.", 1);
    expect(await hooks.applyAccount(props, 1)).toBeNull();
    expect(await hooks.applyAccount(props, 2)).toBeNull();

    expect(await hooks.getAccountRaw(props, "nextActionId")).toBe(4);
    const instance = await hooks.getAccountRaw(props, "instanceId");
    expect(instance).toEqual(expect.any(String));
    // One facet-wide instance id and one facet-wide counter: `<instance>:<action>` never repeats.
    const scopes = await Promise.all([1, 2, 3].map(id => hooks.getAccountRaw(props, `actionScope:${id}`)));
    expect(scopes).toEqual(["board:demo.local::DEMO", "board:demo.local::ENG", "wiki:demo.local:"]);
  });

  it("refuses a stored action whose recorded target was changed, before sending", async () => {
    const { props, hooks, mock, session } = setup();
    await session.openBoard(DEMO_BOARD).openIssue(DEMO_1).transition(WORKING, "1");
    const key = "scope:board:demo.local::DEMO/action:1";
    const record = await hooks.getAccountRaw(props, key) as { scope: { projectKey: string } };
    record.scope.projectKey = "ENG";
    await hooks.putAccountRaw(props, key, record);

    expect(await hooks.applyAccount(props, 1)).toContain("no longer matches the one proposed");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: READY, revision: "1" });
  });
});

describe("collaborators (strategy C)", () => {
  const ALL = { projects: ["DEMO", "ENG"], wikis: ["demo.local"] };

  it("admits a collaborator against every board and Wiki read so far, and no further", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addAccountObserver(props, "early", { projects: [], wikis: [] })).toBeNull();
    await session.openBoard(DEMO_BOARD).readBoard();
    await session.openWiki(DEMO_WIKI).listDocuments();

    expect(await hooks.addAccountObserver(props, "board-only", { projects: ["DEMO"], wikis: [] }))
      .toContain("cannot open every InferOps board and Wiki");
    expect(await hooks.addAccountObserver(props, "both", ALL)).toBeNull();
  });

  it("checks every collaborator again the first time a board or Wiki is read, and excludes those who cannot open it", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addAccountObserver(props, "demo-only", { projects: ["DEMO"], wikis: [] })).toBeNull();
    expect(await hooks.addAccountObserver(props, "everything", ALL)).toBeNull();

    await session.openBoard(DEMO_BOARD).readBoard();
    await session.openBoard(ENG_BOARD).readBoard();
    await session.openWiki(DEMO_WIKI).listDocuments();

    expect((await hooks.log()).excluded).toEqual([[], ["demo-only"], ["demo-only"]]);
  });

  it("keeps workspace lists and board searches from every collaborator", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addAccountObserver(props, "everything", ALL)).toBeNull();
    await session.listWorkspaces();
    await session.findBoards("platform");
    await session.openBoard(DEMO_BOARD).findBoards("platform");
    await hooks.removeAccountObserver(props, "everything");
    await session.listWorkspaces();
    expect((await hooks.log()).excluded).toEqual([["everything"], ["everything"], ["everything"], []]);
  });

  it("refuses a Wiki proposal approval while the binding has a collaborator", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addAccountObserver(props, "everything", ALL)).toBeNull();
    const wiki = session.openWiki(DEMO_WIKI);
    const [proposal] = await wiki.listProposals("in_review");
    expect(await failure(wiki.approveProposal(proposal!.id, proposal!.proposalHash)))
      .toContain("A shared gadget cannot approve Wiki proposals");
  });
});

// Use-role operators on a role console (#63): they read the console and the screens it shows
// without Build, and every board on those screens resolves through the operator's own InferOps
// account in their own operate session's workspace, never through the console owner's connection.
//
// The real Workshop and InferOps gatekeeper Worker, against the fake InferLab and InferOps
// (src/inferops-fake.ts) behind the network interceptor, with per-person accounts from the real
// connect flow, as in inferops-isolation.test.ts.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import type { CanvasWidget } from "@gadgets/workshop-shared/canvas";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, WORKSPACES, boardUrl, type FakePerson,
  type WorkspaceSlug,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG_BOARD = boardUrl("operations", "ENG");
const OPERATIONS = WORKSPACES.operations.id;
const DENIED = /Unauthorized: this collaborator only has permission/;

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;

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
        };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson | null; account: ConnectedAccount | null };

/** A Workshop user, with an InferOps account connected as a fresh InferLab person when `workspaces` is given. */
async function newUser(prefix: string, workspaces?: WorkspaceSlug[]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  if (!workspaces) return { username: username!, api, person: null, account: null };
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person, account };
}

const requestsBy = (person: FakePerson | null) => person
  ? fake.requests.filter(r => r.path !== "/workspaces" && r.token !== null && fake.accessTokensOf(person).includes(r.token))
  : [];

const boardCard: CanvasWidget = {
  id: "eng-board", version: 1, kind: "inferops.project-board", targetRef: ENG_BOARD,
  params: { workflow: "software", showCompleted: false }, size: "wide",
};

/** The owner's console workspace: a connection to ENG, a Board screen showing it, and a console over the screen. */
async function consoleWorkspace(owner: User) {
  const ws = await owner.api.newGadget();
  await ws.newChat("Operations console", null);
  const connection = await ws.newGatekeeper(owner.account!.id, ENG_BOARD);
  if (!connection) throw new Error("The owner could not connect ENG");
  const screen = await ws.createCanvas({ title: "Board", sections: [{ id: "main", title: "Main", columns: 1, widgets: [boardCard] }] });
  const hidden = await ws.createCanvas({ title: "Drafts", sections: [] });
  const created = await ws.createConsole({
    title: "Operations lead", fullChat: "off", views: [{ id: "board", title: "Board", type: "screen", screen: screen.id }],
  });
  const { id: workspaceId } = await ws.getMetadata();
  return { ws, workspaceId, screen, hidden, console: created };
}

/** What a use-role operator's console board resolves to: their own session workspace's connection, or null. */
async function operatorBoard(operator: User, workspaceId: string) {
  const useWs = await operator.api.openGadget(workspaceId);
  const session = await operator.api.getOperateSession();
  const own: RpcStub<Overseer> = session.getWorkspace();
  return { useWs, own, lookup: await own.getGatekeeperByResourceUrl(ENG_BOARD) };
}

it("a use-role operator reads the console's screens and its board through their own InferOps account", async () => {
  const owner = await newUser("consoleowner", ["operations"]);
  const { workspaceId, screen, hidden, console: saved } = await consoleWorkspace(owner);
  const operator = await newUser("consoleoperator", ["operations"]);
  if (!await (await owner.api.openGadget(workspaceId)).addCollaborator(operator.username, "use")) {
    throw new Error("Failed to share");
  }

  const { useWs, own, lookup } = await operatorBoard(operator, workspaceId);
  // The console and the screen it shows are readable without Build; nothing else is.
  expect(await useWs.listConsoles()).toEqual([saved]);
  expect(await useWs.listCanvases()).toEqual([screen]);
  expect(await useWs.getCanvas(hidden.id)).toBeNull();
  expect((await useWs.getCanvas(screen.id))?.sections[0]?.widgets[0]?.targetRef).toBe(ENG_BOARD);
  // The owner's connection is never reachable from the console workspace.
  await expect(useWs.getGatekeeperByResourceUrl(ENG_BOARD)).rejects.toThrow(DENIED);
  await expect(useWs.getGatekeeperById(1)).rejects.toThrow(DENIED);

  // The operator's own session workspace holds no connection yet: the "connect" state.
  expect(lookup).toBeNull();
  const ownerRequestsBefore = requestsBy(owner.person).length;
  const connection = await own.newGatekeeper(operator.account!.id, ENG_BOARD);
  if (!connection) throw new Error("The operator could not connect ENG");
  using resolved = await own.getGatekeeperByResourceUrl(ENG_BOARD);
  expect(resolved).not.toBeNull();
  using session = await resolved!.openSession() as RpcStub<InferOpsProjectSession>;
  expect((await session.readBoard()).project.identifier).toBe("ENG");

  // InferOps saw the operator's own token in the workspace the URL named, and nothing of the owner's.
  const theirs = requestsBy(operator.person);
  expect(theirs.length).toBeGreaterThan(0);
  expect(theirs.every(r => r.workspaceId === OPERATIONS && r.person === operator.username)).toBe(true);
  expect(requestsBy(owner.person)).toHaveLength(ownerRequestsBefore);
  // The read is recorded in the operator's own session workspace.
  expect((await own.listActions({ filter: "observation" })).entries)
    .toEqual([expect.objectContaining({ resourceUrl: ENG_BOARD })]);
});

it("an operator with no InferOps account, or one without the project, gets no board and never the owner's", async () => {
  const owner = await newUser("noacctowner", ["operations"]);
  const { ws, workspaceId } = await consoleWorkspace(owner);
  const unconnected = await newUser("noacctoperator");
  const outsider = await newUser("outsideoperator", ["knowledge"]);
  expect(await ws.addCollaborator(unconnected.username, "use")).toBeTruthy();
  expect(await ws.addCollaborator(outsider.username, "use")).toBeTruthy();
  const ownerRequestsBefore = requestsBy(owner.person).length;

  // No account: nothing resolves and there is no account to connect with.
  const none = await operatorBoard(unconnected, workspaceId);
  expect(none.lookup).toBeNull();
  expect((await listConnectedAccounts(unconnected.api)).filter(a => a.vendorId === VENDOR)).toEqual([]);
  await expect(none.useWs.getGatekeeperByResourceUrl(ENG_BOARD)).rejects.toThrow(DENIED);

  // An account without the project: its own connection is refused like a missing project.
  const denied = await operatorBoard(outsider, workspaceId);
  expect(denied.lookup).toBeNull();
  await expect(denied.own.newGatekeeper(outsider.account!.id, ENG_BOARD))
    .rejects.toThrow("No InferOps project ENG is available on acme.operations.");
  expect(await denied.own.getGatekeeperByResourceUrl(ENG_BOARD)).toBeNull();
  expect(requestsBy(outsider.person).filter(r => r.workspaceId === OPERATIONS)).toEqual([]);

  // Neither operator caused a read with the owner's credential.
  expect(requestsBy(owner.person)).toHaveLength(ownerRequestsBefore);
});

it("a build collaborator still reads through the workspace's connection", async () => {
  const owner = await newUser("buildowner", ["operations"]);
  const { ws, workspaceId } = await consoleWorkspace(owner);
  const builder = await newUser("buildcollab", ["operations"]);
  expect(await ws.addCollaborator(builder.username, "build")).toBeTruthy();
  // Build scope verifies the collaborator against every connection with their own account.
  using choose = stubFor(new ObserverConfigRecorder().alwaysChoose(builder.account!.id, MAX_OBSERVER_PROMPTS));
  using buildWs = await builder.api.openGadget(workspaceId, undefined, choose);
  using connection = await buildWs.getGatekeeperByResourceUrl(ENG_BOARD);
  expect(connection).not.toBeNull();
  using ownerConnection = await ws.getGatekeeperByResourceUrl(ENG_BOARD);
  expect(await connection!.getId()).toBe(await ownerConnection!.getId());
});

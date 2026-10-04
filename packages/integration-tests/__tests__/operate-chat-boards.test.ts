// The operate chat finding boards (#61), end to end with a scripted model: the agent searches with
// `findBoards` on a board the person pasted, through the real Workshop and InferOps gatekeeper
// against the fake InferLab and InferOps (src/inferops-fake.ts). What a real model says is not
// tested here; what is: several plausible boards come back as candidates and nothing opens, no
// match is an empty list and nothing opens, and a candidate that is not (or no longer) connected or
// readable is refused when opened, leaving the page where it was rather than showing another board.

import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, CapsuleSpecifier } from "@gadgets/workshop-shared/api";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, WORKSPACES, boardUrl, type FakePerson, type WorkspaceSlug,
} from "../src/inferops-fake.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, logIn, waitFor } from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const ENG_BOARD = boardUrl("operations", "ENG");
const WEB_BOARD = boardUrl("operations", "WEB");
const OPS_BOARD = boardUrl("knowledge", "OPS");

const find = (id: string, query: string) => ({
  toolCall: {
    id, name: "executeCode",
    arguments: {
      code: `export default async function(self, env) { ` +
        `console.log(JSON.stringify(await env.INFEROPS_BOARD.findBoards(${JSON.stringify(query)}))); }`,
    },
  },
});
const openBoard = (id: string, boardRef: string) => ({
  toolCall: { id, name: "operatePage", arguments: { action: "openBoard", boardRef } },
});

// One script, consumed in test order.
const model = scriptedChatCompletions([
  // Ambiguous: two boards fit, so the agent asks rather than opening one.
  find("ambiguous", "where do we write or refresh things?"),
  { text: "Two boards fit: Engineering (ENG) and Website (WEB). Which one do you mean?" },
  // Empty: nothing fits, so the agent says so and opens nothing.
  find("empty", "the payroll calendar"),
  { text: "I found no board you can open that matches that. Can you describe it differently?" },
  // Stale: a board in another workspace of the person, found but not connected, then revoked.
  find("other-workspace", "on-call roster"),
  openBoard("open-unconnected", OPS_BOARD),
  { text: "OPS isn't connected here; connect it first." },
  find("after-revoke", "on-call roster"),
  openBoard("open-revoked", OPS_BOARD),
  { text: "That board is no longer available to you." },
]);
const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler, model.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
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
    expect(model.remainingSteps()).toBe(0);
  } finally {
    network.uninstall();
  }
});

/** Connect the person's own InferOps account through the real connect flow. */
async function connectInferOps(api: RpcStub<AuthenticatedApi>, person: FakePerson) {
  const { url, nonce } = await api.connectAccount(VENDOR);
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, url, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  await api.completeConnectHandoff(JSON.parse(literal[1]!), nonce);
  return waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
}

type Operator = { session: WorkshopAgentSession; person: FakePerson; eng: CapsuleSpecifier };

/**
 * A person with their own InferOps account, an operate chat, and their ENG board connected in the
 * operate session workspace, ready to paste into a prompt.
 */
async function operator(label: string, workspaces: WorkspaceSlug[]): Promise<Operator> {
  let eng: CapsuleSpecifier | undefined;
  let person: FakePerson | undefined;
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    operateSession: true,
    usernamePrefix: label,
    prepare: async (api, username) => {
      person = fake.addPerson(username, workspaces);
      const account = await connectInferOps(api, person);
      using operate = await api.getOperateSession();
      using own = await operate.getWorkspace();
      using connection = await own.newGatekeeper(account.id, ENG_BOARD);
      if (!connection) throw new Error("Could not connect ENG");
      eng = { position: 0, length: 3, gatekeeperId: await connection.getId(),
              description: await connection.describe(), vendorId: VENDOR };
    },
  });
  return { session, person: person!, eng: eng! };
}

/** What the agent was told its tool call `id` returned, read from the request that followed it. */
const toolResult = (id: string) => {
  for (const request of model.requests) {
    const { messages } = request as { messages: { role: string; tool_call_id?: string; content: string }[] };
    const found = messages.find(message => message.role === "tool" && message.tool_call_id === id);
    if (found) return found.content;
  }
  throw new Error(`No result recorded for tool call ${id}`);
};

/** The candidates a scripted `findBoards` call logged, as the agent saw them. */
const candidates = (id: string) => {
  const line = toolResult(id).split("\n").find(text => text.startsWith("["));
  if (!line) throw new Error(`No candidates in ${toolResult(id)}`);
  return JSON.parse(line) as { projectKey: string; workspace: string; boardRef: string; reasons: string[] }[];
};

async function pageEvents(username: string) {
  using publicApi = connect(harness.url);
  using person = await logIn(publicApi, username);
  using operate = await person.getOperateSession();
  return (await operate.listEvents(0, 20)).map(record => record.event);
}

it("returns every plausible board for an ambiguous request, and opens none of them", async () => {
  const { session, eng } = await operator("ambiguous", ["operations"]);
  await using _ = session;
  const first = model.requests.length;
  const result = await session.runTurn("[0] where do we write or refresh things?", { capsules: [eng] });
  expect(result.outcome).toEqual({ status: "completed" });

  // Both boards come back, each with why, for the person to choose between; the system prompt
  // tells the agent to ask rather than choose.
  const found = candidates("ambiguous");
  expect(found.map(c => c.projectKey)).toEqual(["ENG", "WEB"]);
  expect(found.map(c => c.boardRef)).toEqual([ENG_BOARD, WEB_BOARD]);
  for (const candidate of found) expect(candidate.reasons.length).toBeGreaterThan(0);
  const { messages } = model.requests[first] as { messages: { role: string; content: string }[] };
  expect(messages[0]!.content).toMatch(/If more than one fits, ask which one they mean; never choose for them/);
  expect(await pageEvents(session.username)).toEqual([]);
});

it("answers a request nothing matches with no candidates, and opens nothing", async () => {
  const { session, eng } = await operator("emptysearch", ["operations"]);
  await using _ = session;
  expect((await session.runTurn("[0] the payroll calendar", { capsules: [eng] })).outcome)
    .toEqual({ status: "completed" });
  expect(candidates("empty")).toEqual([]);
  expect(await pageEvents(session.username)).toEqual([]);
});

it("refuses to open a candidate that is not connected, and one whose access was revoked, opening nothing else", async () => {
  const { session, person, eng } = await operator("stalecandidate", ["operations", "knowledge"]);
  await using _ = session;
  expect((await session.runTurn("[0] find the on-call roster board", { capsules: [eng] })).outcome)
    .toEqual({ status: "completed" });
  // Found in the person's other workspace, with its own reference...
  expect(candidates("other-workspace")).toEqual([expect.objectContaining({
    projectKey: "OPS", workspace: "knowledge", boardRef: OPS_BOARD,
  })]);
  // ...but not connected in this session, so opening it is refused and the agent is told not to
  // open something else instead.
  expect(toolResult("open-unconnected")).toMatch(/No connection here is for inferops:\/\/acme\.knowledge\/project\/board\/OPS.*do not open a different board/);
  expect(fake.requests.filter(r => r.workspaceId === WORKSPACES.knowledge.id).every(r => r.person === session.username)).toBe(true);

  // Membership of that workspace revoked at InferOps: the same search no longer names it, and the
  // stale candidate is still refused.
  fake.setWorkspaces(person, ["operations"]);
  expect((await session.runTurn("Search again and open it.")).outcome).toEqual({ status: "completed" });
  expect(candidates("after-revoke")).toEqual([]);
  expect(toolResult("open-revoked")).toMatch(/No connection here is for inferops:\/\/acme\.knowledge\/project\/board\/OPS/);
  expect(await pageEvents(session.username)).toEqual([]);
});

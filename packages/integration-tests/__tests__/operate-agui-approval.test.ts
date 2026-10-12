// Real authenticated HTTP + stock AG-UI 1.0.2 client, real Workshop/Gatekeeper Workers.
// InferLab identities and InferOps transport/data are synthetic; no model or external write.
import { beforeAll, afterAll, expect, it } from "vitest";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import Ajv2020 from "ajv/dist/2020.js";
type Event = Parameters<NonNullable<AgentSubscriber["onEvent"]>>[0]["event"];
type Interrupt = HttpAgent["pendingInterrupts"][number];
import type { RpcStub } from "capnweb";
import type { ApprovalAnswer, OperateApprovalSnapshot } from "@gadgets/workshop-shared/operate-approval";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types";
import { startHarness, type Harness } from "../src/harness";
import { connect, signUp, nextUsernames, listConnectedAccounts, waitFor } from "../src/rpc-client";
import { InferOpsFake, INFERLAB_ORIGIN, INFEROPS_ORIGIN, PROJECTS, boardUrl } from "../src/inferops-fake";
import { NetworkInterceptor } from "../src/network-interceptor";

const fake = new InferOpsFake();
let writeGate: {arrived: () => void; wait: Promise<void>} | undefined;
const network = new NetworkInterceptor({handlers: [async (url, method) => {
  if (writeGate && url.origin === INFEROPS_ORIGIN && method === "POST" && url.pathname.endsWith("/transition")) {
    writeGate.arrived();
    await writeGate.wait;
  }
  return null;
}, fake.handler]});
let harness: Harness;
const schema = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../workshop-backend/__tests__/fixtures/agui/agui-1.0.schema.json"), "utf8"));
const ajv = new Ajv2020({strict: false, allErrors: true});
ajv.addSchema(schema);
const validEvent = ajv.compile({$ref: `${schema.$id}#/$defs/Event`});
beforeAll(async () => {
  network.install();
  harness = await startHarness({gatekeepers: [{binding: "INFEROPS",
    dir: resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops"),
    patch(config) {
      if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
      config.vars = {...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN,
        INFEROPS_BASE_URL: INFEROPS_ORIGIN, BASE_URL: "http://workshop.test/gatekeeper/inferops"};
    }}]});
});
afterAll(async () => {
  try { await harness?.server.close(); expect(network.getUnmockedCalls()).toEqual([]); }
  finally { network.uninstall(); }
});

async function fixture() {
  const stack = new DisposableStack();
  const publicApi = stack.use(connect(harness.url));
  const username = nextUsernames("approval")[0]!;
  const api = stack.use(await signUp(publicApi, username));
  const token = await publicApi.login(username,
    new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
  if (!token) throw new Error("Fixture sign-in failed");
  const person = fake.addPerson(username, ["operations"]);
  const flow = await api.connectAccount("inferops");
  const start = await harness.fetchWorker("gatekeeper-inferops", flow.url, {redirect: "manual"});
  const callback = fake.authorize(start.headers.get("location")!, person);
  const done = await harness.fetchWorker("gatekeeper-inferops", callback);
  const ticket = /var ticket = (".*?");\n/.exec(await done.text());
  if (!ticket) throw new Error("No handoff ticket");
  await api.completeConnectHandoff(JSON.parse(ticket[1]!), flow.nonce);
  const account = await waitFor("connected account", async () =>
    (await listConnectedAccounts(api)).find(value => value.vendorId === "inferops") ?? null);
  const workspace = stack.use(await api.newGadget());
  const workspaceId = (await workspace.getMetadata()).id;
  const connection = stack.use(await workspace.newGatekeeper(account.id, boardUrl("operations", "ENG")));
  if (!connection) throw new Error("No board connection");
  const session = stack.use(await connection.openSession() as RpcStub<InferOpsProjectSession>);
  const issue = fake.issue("ENG-1");
  const before = {...issue};
  const target = PROJECTS.ENG.states.find(value => value.id !== issue.stateId)!;
  using issueSession = await session.openIssue(issue.id);
  await issueSession.transition(target.id, issue.revision);
  const action = (await workspace.listActions({filter: "pending"})).entries[0]!;
  const threadId = randomUUID();
  const forwardedProps = {approval: {workspaceId, actionId: action.id}};
  let agent = new HttpAgent({url: new URL("/api/operate/agui/approval", harness.url).href,
    headers: {Authorization: `Bearer ${token}`}, threadId});
  const run = async (answer?: {interrupt: Interrupt; payload: ApprovalAnswer}, reload = false) => {
    if (reload) agent = new HttpAgent({url: agent.url, headers: {Authorization: `Bearer ${token}`}, threadId});
    const events: Event[] = [];
    await agent.runAgent({runId: randomUUID(), forwardedProps,
      ...(answer ? {resume: [{interruptId: answer.interrupt.id, status: "resolved", payload: answer.payload}]} : {})},
      {onEvent({event}) {expect(validEvent(event), JSON.stringify(ajv.errors)).toBe(true); events.push(event);}});
    const finished = events.at(-1)!;
    if (finished.type !== "RUN_FINISHED") throw new Error("No terminal run");
    const interrupt = agent.pendingInterrupts[0];
    return {events, interrupt, snapshot: agent.state.approval as OperateApprovalSnapshot};
  };
  const raw = (body: object, auth = token) => fetch(agent.url, {method: "POST",
    headers: {Authorization: `Bearer ${auth}`, "Content-Type": "application/json"},
    body: JSON.stringify({threadId, runId: randomUUID(), messages: [], forwardedProps, ...body})});
  return {username, api, workspace, workspaceId, action, connection, session, person, token, agent, before, target,
    forwardedProps, threadId, run, raw, [Symbol.dispose]() {stack.dispose();}};
}

it("snapshots then interrupts; unchanged approve writes once, replay and reload retain the receipt", async () => {
  using f = await fixture();
  const commits = fake.commits.length;
  const first = await f.run();
  expect(first.events.map(e => e.type)).toEqual(["RUN_STARTED", "STATE_SNAPSHOT", "MESSAGES_SNAPSHOT", "RUN_FINISHED"]);
  expect(first.interrupt).toMatchObject({reason: "inferos.gatekeeper.approval.v1",
    responseSchema: {required: ["approved"]}, metadata: {actionId: f.action.id}});
  expect(Date.parse(first.interrupt!.expiresAt!) - Date.now()).toBeGreaterThan(500_000);
  expect(first.snapshot.status).toBe("pending");
  expect(fake.issue("ENG-1")).toEqual(f.before);
  const payload = {approved: true};
  expect((await f.run({interrupt: first.interrupt!, payload})).snapshot.status).toBe("applied");
  expect((await f.run({interrupt: first.interrupt!, payload})).snapshot.status).toBe("applied");
  expect((await f.run(undefined, true)).snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);
  expect(fake.issue("ENG-1").stateId).toBe(f.target.id);
  expect(fake.commits.at(-1)?.person).toBe(f.username);
  const conflict = await f.raw({resume: [{interruptId: first.interrupt!.id, status: "resolved", payload: {approved: false}}]});
  expect(conflict.status).toBe(403);
});

it("rejects without a write and reconciles decisions from the existing action surface", async () => {
  using f = await fixture();
  const commits = fake.commits.length;
  const first = await f.run();
  expect((await f.run({interrupt: first.interrupt!, payload: {approved: false}})).snapshot.status).toBe("rejected");
  expect(fake.commits.length).toBe(commits);
  using other = await fixture();
  const external = await other.run();
  await other.workspace.approveAction(other.action.id);
  expect((await other.run({interrupt: external.interrupt!, payload: {approved: true}})).snapshot.status).toBe("applied");
  expect((await other.run(undefined, true)).snapshot.status).toBe("applied");
});

it("invalid edits do nothing; valid edits demand a new interrupt and cannot reuse the old approval", async () => {
  using f = await fixture();
  const commits = fake.commits.length;
  const first = await f.run();
  expect((await f.raw({resume: [{interruptId: first.interrupt!.id, status: "resolved",
    payload: {approved: true, editedArgs: {toStateId: "missing"}}}]})).status).toBe(403);
  expect(fake.commits.length).toBe(commits);
  const target = PROJECTS.ENG.states.find(value => value.id !== f.before.stateId && value.id !== f.target.id)!;
  const edit = {approved: true, editedArgs: {toStateId: target.id}};
  const next = await f.run({interrupt: first.interrupt!, payload: edit});
  expect(next.interrupt!.id).not.toBe(first.interrupt!.id);
  expect(next.snapshot.proposal.args.toStateId).toBe(target.id);
  expect(next.snapshot.proposal.idempotencyKey).not.toBe(first.snapshot.proposal.idempotencyKey);
  expect((await f.run({interrupt: first.interrupt!, payload: edit}, true)).snapshot).toEqual(next.snapshot);
  expect(fake.commits.length).toBe(commits);
  expect((await f.workspace.listActions({filter: "pending"})).entries.map(e => e.id)).toEqual([next.snapshot.actionId]);
  f.forwardedProps.approval.actionId = next.snapshot.actionId;
  expect((await f.run({interrupt: next.interrupt!, payload: {approved: true}})).snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);
});

it("rejects partial, duplicate, unknown and foreign answers before effects and ignores forged state", async () => {
  using f = await fixture();
  const first = await f.run();
  const commits = fake.commits.length;
  const answer = {interruptId: first.interrupt!.id, status: "resolved", payload: {approved: true}};
  for (const resume of [[], [answer, answer], [{...answer, payload: {}}], [{...answer, interruptId: "unknown"}]]) {
    expect((await f.raw({resume})).ok).toBe(false);
  }
  using stranger = connect(harness.url);
  const username = nextUsernames("foreignapproval")[0]!;
  using _strangerApi = await signUp(stranger, username);
  const token = await stranger.login(username, new Uint8Array(createHash("sha256").update(`integration-test:${username}`).digest()));
  const refused = await f.raw({resume: [answer]}, token!);
  expect(refused.status).toBe(403);
  expect(await refused.text()).toBe(JSON.stringify({error: "APPROVAL_REFUSED"}));
  const forged = await f.raw({state: {approval: {status: "applied", approved: true, person: "claimed-approver"}}});
  expect(forged.ok).toBe(true);
  expect(await forged.text()).toContain('"status":"pending"');
  expect(fake.commits.length).toBe(commits);
});

it.each(["stale", "revoked"] as const)("%s provider authority refuses an approval without effects", async cause => {
  using f = await fixture();
  const first = await f.run();
  const commits = fake.commits.length;
  if (cause === "stale") fake.touch("ENG-1");
  else fake.setWorkspaces(f.person, []);
  const result = await f.run({interrupt: first.interrupt!, payload: {approved: true}});
  expect(result.snapshot.status).toBe(cause === "stale" ? "failed" : "pending");
  expect(result.snapshot.failure?.outcome).toBe("notApplied");
  expect(fake.commits.length).toBe(commits);
});

it("concurrent identical resumes apply once; lost responses recover with the original key", async () => {
  using f = await fixture();
  const first = await f.run();
  const commits = fake.commits.length;
  const resume = [{interruptId: first.interrupt!.id, status: "resolved", payload: {approved: true}}];
  await Promise.all([f.raw({resume}), f.raw({resume})]);
  expect((await f.run(undefined, true)).snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);
  using lost = await fixture();
  const pending = await lost.run();
  fake.loseNextWriteResponse = true;
  const answer = {interrupt: pending.interrupt!, payload: {approved: true}};
  expect((await lost.run(answer)).snapshot.status).toBe("unknown");
  expect((await lost.run(answer)).snapshot.status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 2);
  expect(fake.replays.length).toBeGreaterThan(0);
});

it("unknown outcomes remain unknown after a later refusal, and wire data excludes credentials", async () => {
  using f = await fixture();
  const first = await f.run();
  fake.loseNextWriteResponse = true;
  const answer = {interrupt: first.interrupt!, payload: {approved: true}};
  expect((await f.run(answer)).snapshot.status).toBe("unknown");
  fake.setWorkspaces(f.person, []);
  const result = await f.run(answer);
  expect(result.snapshot.status).toBe("unknown");
  expect(result.snapshot.failure?.outcome).toBe("unknown");
  const wire = JSON.stringify([...first.events, ...result.events]);
  for (const secret of [...fake.issuedTokens(), ...fake.descriptions()]) expect(wire).not.toContain(secret);
});

it("disconnect during apply and Worker restart reconcile durable correlation without another effect", async () => {
  using f = await fixture();
  const first = await f.run();
  const commits = fake.commits.length;
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  writeGate = {arrived: arrived.resolve, wait: release.promise};
  const controller = new AbortController();
  const resume = [{interruptId: first.interrupt!.id, status: "resolved" as const, payload: {approved: true}}];
  const request = fetch(f.agent.url, {method: "POST", signal: controller.signal,
    headers: {Authorization: `Bearer ${f.token}`, "Content-Type": "application/json"},
    body: JSON.stringify({threadId: f.threadId, runId: randomUUID(), messages: [], forwardedProps: f.forwardedProps, resume})})
    .then(() => "response", () => "disconnected");
  try {
    await arrived.promise;
    controller.abort();
    expect(await request).toBe("disconnected");
  } finally {writeGate = undefined; release.resolve();}
  await waitFor("durable apply after disconnect", async () =>
    (await f.workspace.listActions()).entries.find(e => e.id === f.action.id && e.state === "approved") ?? null);
  await harness.server.update(options => ({...options}));
  harness.url = (await harness.server.listen()).url;
  const reloaded = new HttpAgent({url: new URL("/api/operate/agui/approval", harness.url).href,
    headers: {Authorization: `Bearer ${f.token}`}, threadId: f.threadId});
  await reloaded.runAgent({runId: randomUUID(), forwardedProps: f.forwardedProps, resume});
  expect((reloaded.state.approval as OperateApprovalSnapshot).status).toBe("applied");
  expect(fake.commits.length).toBe(commits + 1);
});

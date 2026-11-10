// A console's widgets in InferOps' widget index (FAC-11 slice 2): publishing a console lists each
// widget its publication registers in InferOps (`widget.publish`), for the company, as the person
// publishing, with their own sign-in; a version no published console of the workspace lists any
// more is withdrawn (`widget.withdraw`). InferOps decides against the person's own grant; InferOS
// records what it answered and never claims a listing it didn't get.
//
// The real Workshop and InferOps gatekeeper Worker, against the fake InferLab and InferOps
// (src/inferops-fake.ts) behind the network interceptor, with per-person accounts from the real
// connect flow. All data is synthetic.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ConsoleWidgetEntry, OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { WidgetSearchAnswer } from "@gadgets/workshop-shared/gatekeeper";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness } from "../src/harness.js";
import { INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, WORKSPACES, type FakePerson, type WorkspaceSlug } from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder } from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR = resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;
let reader: RpcStub<AuthenticatedApi>;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = { ...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL: "http://workshop.test/gatekeeper/inferops" };
      },
    }],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true", SHARED_CONFIGURATION_GATEKEEPER: VENDOR };
    },
  });
  reader = await signUp(connect(harness.url), nextUsernames("indexreader")[0]!);
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson };

async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, fake.authorize(start.headers.get("location")!, person));
  const literal = /var ticket = (".*?");\n/.exec(await done.text());
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

/** A Workshop user with an InferOps account connected as a fresh synthetic person of `workspaces`. */
async function newUser(prefix: string, workspaces: WorkspaceSlug[]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  await api.completeConnectHandoff(await signInTicket(url, person), nonce);
  await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person };
}

const widgetFiles = (version: string): Record<string, string> => ({
  "server.js": `import { DurableObject } from "cloudflare:workers";\nexport class Gadget extends DurableObject { async version() { return ${JSON.stringify(version)}; } }\n`,
  "client.js": `document.body.textContent = ${JSON.stringify(version)};\n`,
});

/** A widget blueprint `author` built and published, version 1, with a description. */
async function publishWidget(author: RpcStub<AuthenticatedApi>, title: string): Promise<string> {
  const workspace = await author.newGadget("widget");
  const workpieces = new WorkpieceRecorder();
  await workspace.subscribeToWorkpieces(stubFor(workpieces));
  await workpieces.loaded;
  const gadget = workspace.createGadget(title, undefined, "STATUS");
  const gadgetId = await gadget.getId();
  const content = (files: Record<string, string>): CodeContent => new Map([[gadgetId, new Map(Object.entries(files))]]);
  const baseCommit = await waitFor(`gadget ${gadgetId}'s head`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  const chatId = await workspace.newChat("Edit", null);
  await workspace.submitCodeChange(chatId, { generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{ gadgetId, baseCommit }], change: diffFiles(content({}), content(widgetFiles("v1"))) });
  expect(await workspace.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  const blueprint = await gadget.createBlueprint(title, `Shows who is free for a job (${title}).`);
  await waitFor("the published blueprint", () => reader.getBlueprintInfo(blueprint.id));
  return blueprint.id;
}

const screenWith = (space: RpcStub<Overseer>, gadgetIds: WorkpieceId[]) => space.createCanvas({
  title: "Shift",
  sections: [{ id: "main", title: "Now", columns: 1, widgets: gadgetIds.map(id => ({
    id: `w${id}`, version: 1 as const, kind: "inferos.gadget" as const, targetRef: `gadget:${id}`, params: {}, size: "normal" as const,
  })) }],
});

const consoleOf = (screenId: string, widgets: ConsoleWidgetEntry[], title = "Floor"): OperateConsoleContent => ({
  title, views: [{ id: "now", title: "Now", type: "screen", screen: screenId }], fullChat: "off", widgets,
});

/** An operations space of `builder` with the widget installed and a draft console registering it. */
async function consoleSpace(builder: User, blueprintId: string) {
  const space = await builder.api.newGadget("app");
  const installed = await space.installBlueprint(blueprintId, {}, { version: 1, kind: "widget" });
  const entry: ConsoleWidgetEntry = { gadgetId: installed, blueprintId, version: 1, label: "Free technicians", state: "resettable" };
  const screen = await screenWith(space, [installed]);
  return { space, installed, entry, screen };
}

const widgetWrites = (person: FakePerson) => fake.requests.filter(r =>
  r.path.startsWith("/knowledge/widget-definitions") && r.token !== null && fake.accessTokensOf(person).includes(r.token));

describe("a console's widgets in InferOps' widget index", () => {
  it("lists each published widget for the company as the publisher, once, and withdraws it when no console lists it", async () => {
    const builder = await newUser("indexbuilder", ["operations", "mind"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    const blueprintId = await publishWidget(builder.api, "Technicians");
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const draft = await space.createConsole(consoleOf(screen.id, [entry]));
    // Nothing reaches InferOps before publishing.
    expect(widgetWrites(builder.person)).toEqual([]);
    expect(await space.getConsoleWidgetIndex(draft.id)).toBeNull();

    const published = await space.publishConsole(draft.id, draft.revision);
    const report = await space.getConsoleWidgetIndex(draft.id);
    expect(report).toEqual({
      target: { workspaceId: WORKSPACES.operations.id, name: "Operations" }, blocked: null, pendingWithdraws: [],
      widgets: [{ versionId: `${blueprintId}@1`, label: "Free technicians", outcome: { status: "applied" } }],
    });
    // One definition, for the company, as this person in the one workspace where they may: a
    // pointer and words, never an install, binding or record.
    expect([...fake.widgetDefinitions.values()]).toEqual([{
      workspace: "operations", sourceId: blueprintId, sourceVersion: 1, title: "Free technicians",
      purpose: "Free technicians: Shows who is free for a job (Technicians).", visibility: "company",
      publishedBy: builder.username,
    }]);
    const [put] = widgetWrites(builder.person).filter(r => r.method === "PUT");
    expect(put).toMatchObject({ workspaceId: WORKSPACES.operations.id, person: builder.username });

    // Publishing again (a new revision) writes the same definition again: still one.
    const again = await space.publishConsole(published.id, published.revision);
    expect(fake.widgetDefinitions.size).toBe(1);

    // A publication without the widget withdraws it.
    const without = await space.replaceConsole(again.id, again.revision, consoleOf((await screenWith(space, [])).id, []));
    await space.publishConsole(without.id, without.revision);
    expect(fake.widgetDefinitions.size).toBe(0);
    expect(widgetWrites(builder.person).filter(r => r.method === "DELETE")).toHaveLength(1);
    expect(await space.getConsoleWidgetIndex(draft.id)).toMatchObject({ widgets: [], pendingWithdraws: [], blocked: null });
  });

  it("lists nothing, and says why, for a publisher InferOps gives no shared configuration publish permission", async () => {
    const builder = await newUser("indexnogrant", ["operations"]);
    const blueprintId = await publishWidget(builder.api, "Rota");
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const draft = await space.createConsole(consoleOf(screen.id, [entry]));
    // The console itself publishes for its operators; only the company listing is refused.
    const published = await space.publishConsole(draft.id, draft.revision);
    expect(published.published?.content.widgets).toHaveLength(1);
    expect(await space.getConsoleWidgetIndex(draft.id)).toMatchObject({
      target: null, widgets: [], blocked: expect.stringContaining("can't publish shared configuration in any InferOps workspace"),
    });
    expect(widgetWrites(builder.person)).toEqual([]);
    expect([...fake.widgetDefinitions.values()].filter(d => d.publishedBy === builder.username)).toEqual([]);
  });

  it("asks which workspace when several qualify, writes only to the chosen one, and never moves on its own", async () => {
    const builder = await newUser("indexchoose", ["operations", "knowledge"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    fake.grantPublishConfiguration(builder.person, "knowledge");
    const blueprintId = await publishWidget(builder.api, "Dispatch");
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const draft = await space.createConsole(consoleOf(screen.id, [entry]));
    let current = await space.publishConsole(draft.id, draft.revision);
    expect(await space.getConsoleWidgetIndex(draft.id)).toMatchObject({ target: null, blocked: expect.stringContaining("choose the InferOps workspace") });
    expect(widgetWrites(builder.person).filter(r => r.method === "PUT")).toEqual([]);

    expect((await space.listConsoleWidgetIndexWorkspaces()).map(w => w.name).toSorted()).toEqual(["Knowledge", "Operations"]);
    await expect(space.setConsoleWidgetIndexTarget(draft.id, WORKSPACES.mind.id)).rejects.toThrow(/can't publish shared configuration in that/);
    await space.setConsoleWidgetIndexTarget(draft.id, WORKSPACES.knowledge.id);
    current = await space.publishConsole(current.id, current.revision);
    const mine = () => [...fake.widgetDefinitions.values()].filter(d => d.publishedBy === builder.username);
    expect(mine().map(d => d.workspace)).toEqual(["knowledge"]);

    // The chosen workspace stops qualifying: nothing moves to Operations, and the builder is told.
    builder.person.publishesConfiguration.delete("knowledge");
    const edited = await space.replaceConsole(current.id, current.revision, consoleOf(screen.id, [{ ...entry, label: "Dispatch board" }]));
    await space.publishConsole(edited.id, edited.revision);
    expect(await space.getConsoleWidgetIndex(draft.id)).toMatchObject({ blocked: expect.stringContaining("no longer publish shared configuration in Knowledge") });
    expect(mine().map(d => [d.workspace, d.title])).toEqual([["knowledge", "Free technicians"]]);
  });

  it("keeps a version two consoles list until the last one goes, and retries a withdrawal that failed", async () => {
    const builder = await newUser("indexcount", ["operations"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    const blueprintId = await publishWidget(builder.api, "Stock");
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const first = await space.publishConsole(...await created(space, consoleOf(screen.id, [entry], "Floor")));
    const second = await space.publishConsole(...await created(space, consoleOf(screen.id, [entry], "Yard")));
    const key = `operations/${blueprintId}/1`;
    expect(fake.widgetDefinitions.has(key)).toBe(true);

    await space.deleteConsole(first.id, first.revision);
    expect(fake.widgetDefinitions.has(key)).toBe(true);

    // The last console's withdrawal fails: it is kept as owed, and the next delete or publication
    // in the workspace tries it again.
    fake.failNextWidgetWrites = 1;
    const without = await space.replaceConsole(second.id, second.revision, consoleOf((await screenWith(space, [])).id, [], "Yard"));
    const unlisted = await space.publishConsole(without.id, without.revision);
    expect(fake.widgetDefinitions.has(key)).toBe(true);
    expect((await space.getConsoleWidgetIndex(second.id))?.pendingWithdraws).toEqual([
      { versionId: `${blueprintId}@1`, reason: expect.any(String) }]);
    await space.publishConsole(unlisted.id, unlisted.revision);
    expect(fake.widgetDefinitions.has(key)).toBe(false);
    expect((await space.getConsoleWidgetIndex(second.id))?.pendingWithdraws).toEqual([]);
  });

  it("keeps a deleted console's failed withdrawal owed for the workspace, shows it, and retries it on the next publication", async () => {
    const builder = await newUser("indexdeleted", ["operations"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    const blueprintId = await publishWidget(builder.api, "Vans");
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const listing = await space.publishConsole(...await created(space, consoleOf(screen.id, [entry], "Floor")));
    const other = await space.publishConsole(...await created(space, consoleOf((await screenWith(space, [])).id, [], "Desk")));
    const key = `operations/${blueprintId}/1`;
    expect(fake.widgetDefinitions.has(key)).toBe(true);

    // InferOps is down when the only console listing it is deleted: the withdrawal is owed.
    fake.failNextWidgetWrites = 1;
    await space.deleteConsole(listing.id, listing.revision);
    expect(fake.widgetDefinitions.has(key)).toBe(true);
    expect((await space.getConsoleWidgetIndex(other.id))?.pendingWithdraws).toEqual([
      { versionId: `${blueprintId}@1`, reason: expect.stringContaining("Still listed") }]);

    // Any later publication in the workspace tries it again, as that person.
    await space.publishConsole(other.id, other.revision);
    expect(fake.widgetDefinitions.has(key)).toBe(false);
    expect((await space.getConsoleWidgetIndex(other.id))?.pendingWithdraws).toEqual([]);
  });

  it("gives the use role no way to read, choose or write the index", async () => {
    const builder = await newUser("indexowner", ["operations"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    const [operatorName] = nextUsernames("indexoperator");
    const operator = await signUp(connect(harness.url), operatorName!);
    const space = await builder.api.newGadget("app");
    expect(await space.addCollaborator(operatorName!, "use")).toBeTruthy();
    const draft = await space.createConsole(consoleOf((await screenWith(space, [])).id, []));
    using used = await operator.openGadget((await space.getMetadata()).id);
    await expect(used.getConsoleWidgetIndex(draft.id)).rejects.toThrow(/Unauthorized/);
    await expect(used.listConsoleWidgetIndexWorkspaces()).rejects.toThrow(/Unauthorized/);
    await expect(used.setConsoleWidgetIndexTarget(draft.id, WORKSPACES.operations.id)).rejects.toThrow(/Unauthorized/);
  });
});

/** Creates a console from `content`, returning the arguments that publish it. */
async function created(space: RpcStub<Overseer>, content: OperateConsoleContent): Promise<[string, string]> {
  const draft = await space.createConsole(content);
  return [draft.id, draft.revision];
}

/** The matches of a search that ran (FAC-13), failing the test if it asked nothing. */
function searched(answer: WidgetSearchAnswer) {
  if (answer.status !== "searched") throw new Error(`Expected a search, got ${JSON.stringify(answer)}`);
  return answer;
}

describe("finding a published widget by intent (FAC-13)", () => {
  it("finds a company widget for another person of the company, through their own InferOps sign-in", async () => {
    const builder = await newUser("searchbuilder", ["operations", "mind"]);
    fake.grantPublishConfiguration(builder.person, "operations");
    const word = `overduebills${Date.now().toString(36)}`;
    const blueprintId = await publishWidget(builder.api, word);
    const { space, entry, screen } = await consoleSpace(builder, blueprintId);
    const draft = await space.createConsole(consoleOf(screen.id, [entry]));
    await space.publishConsole(draft.id, draft.revision);

    const operator = await newUser("searchoperator", ["operations"]);
    const found = searched(await operator.api.searchWidgets(`show ${word}`));
    expect(found).toMatchObject({ ranking: "keyword", denied: 0, unsearched: 0 });
    // "show" also matches other widgets' purposes ("Shows who is free"), at a lower score: the one
    // matching every word ranks first, once.
    expect(found.definitions[0]).toEqual(
      expect.objectContaining({ sourceId: blueprintId, sourceVersion: 1, title: "Free technicians", score: 1 }));
    expect(found.definitions.filter(d => d.sourceId === blueprintId)).toHaveLength(1);
    expect(found.definitions.slice(1).every(d => d.score < 1)).toBe(true);
    // Asked with the operator's own credentials, never the builder's or a shared one.
    const asked = fake.requests.filter(r => r.path.startsWith("/knowledge/widget-search"));
    expect(asked.length).toBeGreaterThan(0);
    for (const request of asked.filter(r => r.person === operator.username)) {
      expect(fake.accessTokensOf(operator.person)).toContain(request.token);
    }
    // A query that matches nothing finds nothing; a blank one is refused before anything is asked.
    expect(searched(await operator.api.searchWidgets(`zzqx${word}`)).definitions).toEqual([]);
    const before = fake.requests.length;
    await expect(operator.api.searchWidgets("   ")).rejects.toThrow("Say what you want to find");
    expect(fake.requests.length).toBe(before);
  });

  it("counts a workspace where InferOps gives no knowledge:read as asked and adding nothing", async () => {
    const denied = await newUser("searchdenied", ["operations"]);
    fake.setKnowledgeAccess(denied.person, "none");
    expect(await denied.api.searchWidgets("technicians"))
      .toEqual({ status: "searched", hits: [], definitions: [], ranking: "keyword", denied: 1, unsearched: 0 });
  });

  it("says nothing was asked, and why, rather than finding no widgets", async () => {
    // No InferOps account at all.
    const [loneName] = nextUsernames("searchlone");
    const lone = await signUp(connect(harness.url), loneName!);
    expect(await lone.searchWidgets("technicians")).toEqual({ status: "unavailable", reason: "not-connected" });

    // InferOps gives the person no workspace to search (the sign-in records which they hold).
    const homeless = await newUser("searchhomeless", []);
    expect(await homeless.api.searchWidgets("technicians")).toEqual({ status: "unavailable", reason: "no-workspace" });

    // The person's sign-in ended at InferLab: once the account is marked expired, they're told to reconnect.
    const lapsed = await newUser("searchlapsed", ["operations"]);
    fake.revokeSessions(lapsed.person);
    await lapsed.api.searchWidgets("technicians").catch(() => undefined);
    await waitFor("the account to be marked expired", async () =>
      (await listConnectedAccounts(lapsed.api)).some(a => a.vendorId === VENDOR && !a.credentialsValid) || null);
    expect(await lapsed.api.searchWidgets("technicians")).toEqual({ status: "unavailable", reason: "reconnect" });
  });

  it("reports workspaces it couldn't search, and fails only when none could be", async () => {
    const partial = await newUser("searchpartial", ["operations", "mind"]);
    try {
      expect(searched(await partial.api.searchWidgets("technicians"))).toMatchObject({ denied: 0, unsearched: 0 });
      fake.widgetSearchFaults.set("mind", "down");
      expect(searched(await partial.api.searchWidgets("technicians"))).toMatchObject({ denied: 0, unsearched: 1 });
      // A 403 that isn't a missing knowledge:read is a workspace not searched, never "denied".
      fake.widgetSearchFaults.set("mind", "forbidden");
      expect(searched(await partial.api.searchWidgets("technicians"))).toMatchObject({ denied: 0, unsearched: 1 });
      fake.widgetSearchFaults.set("operations", "down");
      await expect(partial.api.searchWidgets("technicians")).rejects.toThrow();
    } finally {
      fake.widgetSearchFaults.clear();
    }
  });
});

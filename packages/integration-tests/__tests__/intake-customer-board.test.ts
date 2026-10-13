// The customer's board, as the reviewed intake describes it, read through the InferOps gatekeeper
// (MVP-03, factory-level/inferos#82). The real consumer code applies the synthetic Acme intake to a
// bootstrapped wrapper. The `customer-operations` screen it generates is saved through the
// Workshop's canvas API, and the ENG board reference is taken from that saved screen and bound with
// the real gatekeeper Worker, by people who connected their own InferLab account through the real
// connect flow -- against the fake InferLab and InferOps (src/inferops-fake.ts) behind the network
// interceptor, as inferops-isolation.test.ts does.
//
// The intake runs as its CLI (`node scripts/consumer/intake.ts apply`, never `--file-issues`).
//
// Proves: a board reference the intake generated reads that board for a member of its workspace,
// and nothing else -- a person without the workspace is refused like a missing project before any
// board request, and a reference the intake did not generate for ENG reads nothing of ENG. The
// intake leaves `inferops.targetRef` and the synthetic fixture on the demo board, and puts the
// customer's screen first.
//
// Limits, stated: the provider is the synthetic fake, not an intake-created InferOps database (the
// local HTTP/Postgres proof is separate); the sign-in is the fake's, not a live InferLab (#66); the
// wrapper is the existing tooling, not a customer fork.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import type { CanvasDefinition, CanvasWidget } from "@gadgets/workshop-shared/canvas";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { wrapper } from "../../../scripts/consumer/intake-wrapper-fixture.ts";
import { startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, WORKSPACES, boardUrl, type FakePerson, type WorkspaceSlug,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const GATEKEEPER_WORKER = "gatekeeper-inferops";
const VENDOR = "inferops";
const BASE_URL = "http://workshop.test/gatekeeper/inferops";
const OPERATIONS = WORKSPACES.operations.id;
const DEMO_BOARD = "inferops://demo.local/project/board/DEMO";
const CUSTOMER_SCREEN = "customer-operations";

/** The message every refused binding gets, whatever was missing (as inferops-isolation asserts). */
const unavailable = (key: string, host: string) => `No InferOps project ${key} is available on ${host}.`;
/**
 * `intake apply <wrapper> <intake>` with the wrapper's own pinned CLI, the way a customer runs it
 * (`pnpm inferos intake apply`), so capability support and `inferos:check` come from the same pin.
 * The pin's `intake.ts` is this checkout's, copied byte for byte (intake-wrapper-fixture.ts). Never
 * `--file-issues`, so nothing is filed. Returns the CLI's JSON line and the report it wrote.
 */
function applyIntake(target: string, intakePath: string) {
  const cli = join(target, "inferos/scripts/consumer/intake.ts");
  expect(readFileSync(cli)).toEqual(readFileSync(resolve(import.meta.dirname, "../../../scripts/consumer/intake.ts")));
  const run = spawnSync(process.execPath, [cli, "apply", target, intakePath], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`intake apply failed (${run.status}): ${run.stderr}`);
  return { cli: JSON.parse(run.stdout), report: JSON.parse(readFileSync(join(target, "intake-report.json"), "utf8")) };
}

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;
const scratch: string[] = [];

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = { ...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN, BASE_URL };
      },
    }],
    // Stored canvases need both installation flags (workshop-canvas.test.ts).
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
});

afterAll(async () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

// ---------------------------------------------------------------------------
// The connected-person flow, as inferops-isolation.test.ts drives it.

async function signInTicket(flowUrl: string, person: FakePerson): Promise<string> {
  const start = await harness.fetchWorker(GATEKEEPER_WORKER, flowUrl, { redirect: "manual" });
  expect(start.status).toBe(302);
  const callback = fake.authorize(start.headers.get("location")!, person);
  const done = await harness.fetchWorker(GATEKEEPER_WORKER, callback);
  const html = await done.text();
  expect(done.status, html).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(html);
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

type User = { username: string; api: RpcStub<AuthenticatedApi>; person: FakePerson; account: ConnectedAccount };

async function newUser(prefix: string, workspaces: WorkspaceSlug[]): Promise<User> {
  const [username] = nextUsernames(prefix);
  const api = await signUp(connect(harness.url), username!);
  const person = fake.addPerson(username!, workspaces);
  const { url, nonce } = await api.connectAccount(VENDOR);
  await api.completeConnectHandoff(await signInTicket(url, person), nonce);
  const account = await waitFor("the connected InferOps account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
  return { username: username!, api, person, account };
}

/** InferOps project-API requests made with any of the person's tokens, outside their connect. */
const requestsBy = (person: FakePerson) =>
  fake.requests.filter(r => r.path !== "/workspaces" && r.token !== null && fake.accessTokensOf(person).includes(r.token));
const boardRequestsBy = (person: FakePerson) =>
  requestsBy(person).filter(r => r.path.startsWith("/project/board"));

// ---------------------------------------------------------------------------
// The intake side: the real consumer code on a bootstrapped wrapper.

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A wrapper bootstrapped with the InferOps board (so the demo screen exists first) and the sample applied. */
function derivedWrapper(mutate?: (intake: any) => void) {
  const root = mkdtempSync(join(tmpdir(), "intake-customer-board-"));
  scratch.push(root);
  const { target, intakePath } = wrapper(root, { capabilities: ["INFEROPS_ENABLED"] });
  if (mutate) {
    const intake = readJson(intakePath);
    mutate(intake);
    writeFileSync(intakePath, JSON.stringify(intake, null, 2));
  }
  const before = {
    screens: readJson(join(target, "inferos.canvas.json")).screens.map((screen: { id: string }) => screen.id),
    targetRef: readJson(join(target, "inferos.config.json")).inferops.targetRef,
    fixture: sha256(join(target, "fixtures/project-board.json")),
  };
  const { cli, report } = applyIntake(target, intakePath);
  return { target, intakePath, before, cli, report };
}

/** The intake-generated customer screen, as `inferos.canvas.json` holds it. */
const customerScreen = (target: string): { id: string; title: string; sections: CanvasDefinition["sections"] } =>
  readJson(join(target, "inferos.canvas.json")).screens.find((screen: { id: string }) => screen.id === CUSTOMER_SCREEN);

/** Save the generated screen in a fresh workspace of `user` and return it as the Workshop stored it. */
async function saveScreen(user: User, screen: ReturnType<typeof customerScreen>) {
  const ws = await user.api.newGadget();
  const created = await ws.createCanvas({ title: screen.title, sections: screen.sections });
  const stored = await ws.getCanvas(created.id);
  if (!stored) throw new Error("The saved canvas did not read back");
  return { ws, stored };
}

/** A board widget of the stored canvas, by the widget id the intake generated. */
function storedBoard(stored: CanvasDefinition, widgetId: string): CanvasWidget {
  const widget = stored.sections.flatMap(section => section.widgets).find(candidate => candidate.id === widgetId);
  if (!widget || widget.kind !== "inferops.project-board") throw new Error(`No stored board widget ${widgetId}`);
  return widget;
}

async function bindRefusal(ws: RpcStub<Overseer>, user: User, url: string): Promise<string> {
  try {
    const connection = await ws.newGatekeeper(user.account.id, url);
    if (!connection) return "newGatekeeper returned null";
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------

describe("the intake's customer screen", () => {
  it("is generated first, references every intake project, and leaves the demo target and fixture alone", () => {
    const { target, intakePath, before, cli, report } = derivedWrapper();
    // Bootstrap with the InferOps board created the demo screen; the intake's goes in front of it.
    expect(before.screens).toEqual(["operations"]);
    const screens = readJson(join(target, "inferos.canvas.json")).screens.map((screen: { id: string }) => screen.id);
    expect(screens).toEqual([CUSTOMER_SCREEN, "operations"]);
    const refs = customerScreen(target).sections.flatMap(section => section.widgets).map(widget => [widget.id, widget.targetRef]);
    expect(refs).toEqual([["board-eng", boardUrl("operations", "ENG")], ["board-ops", boardUrl("operations", "OPS")]]);

    // `inferops.targetRef` names the fixture board, and stays on it; the fixture is untouched.
    expect(before.targetRef).toBe(DEMO_BOARD);
    expect(readJson(join(target, "inferos.config.json")).inferops.targetRef).toBe(DEMO_BOARD);
    expect(sha256(join(target, "fixtures/project-board.json"))).toBe(before.fixture);
    // The CLI ran inferos:check and kept the wrapper; the report says what stays pending.
    expect(cli).toMatchObject({ ok: true, operation: "intake", deployed: false });
    expect(report.check).toEqual({ ok: true, command: "pnpm inferos:check" });
    expect(report.deployed).toBe(false);
    expect(report.pending).toContain(
      "inferops.targetRef and fixtures/project-board.json still name the synthetic fixture board; the customer references are in the starter view and screen template.");
    expect(report.requirements.every((requirement: { filed: unknown }) => requirement.filed === null)).toBe(true);
    expect(report.summary.filedIssues).toBe(0);

    // A customer's reorder survives a rerun: an existing screen is replaced where it is.
    const canvasPath = join(target, "inferos.canvas.json");
    const canvas = readJson(canvasPath);
    canvas.screens.reverse();
    writeFileSync(canvasPath, JSON.stringify(canvas, null, 2));
    const { report: rerun } = applyIntake(target, intakePath);
    expect(readJson(canvasPath).screens.map((screen: { id: string }) => screen.id)).toEqual(["operations", CUSTOMER_SCREEN]);
    expect(rerun.configuration.changes.find((change: { field: string }) => change.field === `inferos.canvas.json:/screens[id=${CUSTOMER_SCREEN}]`)?.action).toBe("unchanged");
  });
});

describe("reading the customer's board from the generated screen", () => {
  it("binds the stored screen's ENG reference and reads ENG for a member of acme.operations", async () => {
    const { target } = derivedWrapper();
    const alice = await newUser("custboarda", ["operations"]);
    const { ws, stored } = await saveScreen(alice, customerScreen(target));
    const widget = storedBoard(stored, "board-eng");
    // The reference comes from the stored, intake-generated screen, not from this test.
    const connection = await ws.newGatekeeper(alice.account.id, widget.targetRef);
    if (!connection) throw new Error("No connection for the generated reference");
    const session = await connection.openSession() as RpcStub<InferOpsProjectSession>;

    const board = await session.readBoard();
    expect(board.project.identifier).toBe("ENG");
    expect(board.columns.flatMap(column => column.issues).map(issue => issue.identifier).toSorted()).toEqual(["ENG-1", "ENG-2"]);
    expect(JSON.stringify(board)).not.toContain("CONFIDENTIAL");

    const observations = (await ws.listActions({ filter: "observation" })).entries;
    expect(observations).toEqual([expect.objectContaining({
      type: "observation", state: "approved", resourceUrl: widget.targetRef,
      description: expect.objectContaining({ title: "Read InferOps board ENG" }),
    })]);
    // Every request was the person's own token in the workspace the reference's slug resolved to.
    const mine = requestsBy(alice.person);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(r => r.workspaceId === OPERATIONS && r.person === alice.username)).toBe(true);
    expect(boardRequestsBy(alice.person).length).toBeGreaterThan(0);
  });

  it("refuses a person without acme.operations like a missing project, before any board request", async () => {
    const { target } = derivedWrapper();
    const outsider = await newUser("custboardb", ["knowledge"]);
    const { ws, stored } = await saveScreen(outsider, customerScreen(target));
    const widget = storedBoard(stored, "board-eng");

    expect(await bindRefusal(ws, outsider, widget.targetRef)).toContain(unavailable("ENG", "acme.operations"));
    // The connect's own membership read happened; no board request, and nothing in operations.
    expect(boardRequestsBy(outsider.person)).toEqual([]);
    expect(requestsBy(outsider.person).filter(r => r.workspaceId === OPERATIONS)).toEqual([]);
  });

  it("follows the generated data: an intake that names another key binds that key, never ENG", async () => {
    // Mutation: the intake's ENG project renamed, so the generated widget and reference change.
    const { target } = derivedWrapper(intake => {
      intake.inferops.projects[0].key = "ENGX";
      for (const operation of intake.operations) if (operation.project === "ENG") operation.project = "ENGX";
    });
    const alice = await newUser("custboardc", ["operations"]);
    const { ws, stored } = await saveScreen(alice, customerScreen(target));
    expect(() => storedBoard(stored, "board-eng")).toThrow("No stored board widget board-eng");
    const widget = storedBoard(stored, "board-engx");
    expect(widget.targetRef).toBe(boardUrl("operations", "ENGX"));

    expect(await bindRefusal(ws, alice, widget.targetRef)).toContain(unavailable("ENGX", "acme.operations"));
    // Nothing of ENG was read for this person: no board request at all.
    expect(boardRequestsBy(alice.person)).toEqual([]);
  });

  it("writes nothing to InferOps and files nothing", () => {
    expect(fake.commits).toEqual([]);
  });
});

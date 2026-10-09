// The deployment's request path, end to end in workerd: the production router (its checked-in
// assets stanza over a fixture build) is the primary Worker, so every request below -- static
// assets, the SPA fallback, the Workshop's `/api` Cap'n Web WebSocket and the gatekeeper's
// `/gatekeeper/inferops/*` sign-in legs -- enters through it over real HTTP, as a public origin
// does. Behind it run the real Workshop and the real InferOps gatekeeper, against the fake InferLab
// and InferOps (src/inferops-fake.ts) behind the network interceptor.
//
// One path, in order: the app shell, a person connecting InferOps through the router, a board read
// recorded as an observation, an approval applied once, a Worker restart with every Durable Object's
// state kept, and a reconnect after it. Tests share one harness and run in order.
//
// Not covered here, and why (see docs/wiki/local-cloud-parity.md): Cloudflare Access (the harness
// has no Access in front, so `/api` takes the password path), real OAuth providers and redirect
// registration, and a wrapper's own gatekeeper -- that needs a generated wrapper checkout and its
// build, which this repository has no fixture for. It would be bound and routed by the same
// `GATEKEEPER_<NAME>` rule exercised here, and `scripts/consumer/gatekeepers.test.ts` covers its
// discovery and router wiring.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types.js";
import { ROUTER_ASSETS_DIR, startHarness, type Harness } from "../src/harness.js";
import {
  INFERLAB_ORIGIN, INFEROPS_ORIGIN, InferOpsFake, PROJECTS, boardUrl, type FakePerson,
} from "../src/inferops-fake.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, overFreshConnection, settled, signUp,
  waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const INFEROPS_GATEKEEPER_DIR =
  resolve(import.meta.dirname, "../../../custom-gatekeepers/gatekeeper-inferops");
const VENDOR = "inferops";
/** The Workshop's `PUBLIC_BASE_URL` in the harness: the origin every public URL must name. */
const PUBLIC_ORIGIN = "http://workshop.test";
const BASE_URL = `${PUBLIC_ORIGIN}/gatekeeper/inferops`;
const ENG_BOARD = boardUrl("operations", "ENG");
const IN_PROGRESS = PROJECTS.ENG.states[1]!;
const SHELL_MARKER = "data-router-parity-shell";

const fake = new InferOpsFake();
const network = new NetworkInterceptor({ handlers: [fake.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    router: {},
    gatekeepers: [{
      binding: "INFEROPS",
      dir: INFEROPS_GATEKEEPER_DIR,
      patch: config => {
        // Prebuilt by `build:inferops-gatekeeper`, as in inferops-isolation.test.ts.
        if (process.env.WORKSHOP_INTEGRATION_PREBUILT === "1") delete config.build;
        config.vars = {
          ...config.vars, INFERLAB_AUTH_ORIGIN: INFERLAB_ORIGIN, INFEROPS_BASE_URL: INFEROPS_ORIGIN,
          BASE_URL,
        };
      },
    }],
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

/** A plain HTTP request to the router's listening socket. */
const get = (path: string, init?: RequestInit) => fetch(new URL(path, harness.url), init);

/**
 * A public URL (on `PUBLIC_ORIGIN`) sent to the router's socket instead: the path and query are what
 * the router and the gatekeeper route on, so only the origin changes.
 */
const throughRouter = (publicUrl: string, init?: RequestInit) => {
  const url = new URL(publicUrl);
  expect(url.origin).toBe(PUBLIC_ORIGIN);
  return get(url.pathname + url.search, init);
};

/** Whether a response is the fixture app shell (the router's ASSETS, or its SPA fallback). */
async function isShell(response: Response): Promise<boolean> {
  return response.status === 200 && (await response.text()).includes(SHELL_MARKER);
}

/**
 * The InferLab sign-in legs, all through the router: the connect URL's redirect to `/authorize`
 * (whose `redirect_uri` must name the public origin), the person signing in, and the callback that
 * renders the handoff page. Returns the page's single-use ticket.
 */
async function signInThroughRouter(flowUrl: string, person: FakePerson): Promise<string> {
  expect(new URL(flowUrl).pathname.startsWith("/gatekeeper/inferops/")).toBe(true);
  const start = await throughRouter(flowUrl, { redirect: "manual" });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.origin).toBe(INFERLAB_ORIGIN);
  // The OAuth redirect origin is the deployment's public origin, on the gatekeeper's routed path.
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/oauth`);

  const done = await throughRouter(fake.authorize(authorize.toString(), person));
  const html = await done.text();
  expect(done.status, html).toBe(200);
  // The handoff page is a Workshop-origin document, so it carries the Workshop's opener policy.
  expect(done.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(html).not.toContain(SHELL_MARKER);
  const literal = /var ticket = (".*?");\n/.exec(html);
  if (!literal) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

const inferOpsAccount = async (api: RpcStub<AuthenticatedApi>, id: number) =>
  (await listConnectedAccounts(api)).find(a => a.vendorId === VENDOR && a.id === id) ?? null;

const pending = async (ws: RpcStub<Overseer>) =>
  (await ws.listActions({ filter: "pending" })).entries;
const observations = async (ws: RpcStub<Overseer>) =>
  (await ws.listActions({ filter: "observation" })).entries;

// State the ordered tests below hand on to each other.
let username: string;
let person: FakePerson;
let api: RpcStub<AuthenticatedApi>;
let account: ConnectedAccount;
let gadgetId: string;
let connectionId: number;
let heldActionId: number;

describe("the router serves the frontend", () => {
  it("serves the app shell, its assets and the SPA fallback, and keeps worker-first paths off the assets", async () => {
    const root = await get("/");
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await isShell(root)).toBe(true);

    const asset = await get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("ROUTER_PARITY_ASSET");

    // Client routes, including the page every connect flow hands off to, fall back to the shell.
    for (const path of ["/w/42/canvas", "/connect/handoff", "/apiary"]) {
      expect(await isShell(await get(path)), path).toBe(true);
    }

    // `/api` is worker-first and reaches the Workshop, which refuses a plain GET.
    const plainApi = await get("/api");
    expect(plainApi.status).toBe(400);
    expect(await plainApi.text()).toContain("only accepts POST or WebSocket");

    // A bound gatekeeper's path reaches the gatekeeper (its own 404), not the shell; a path with no
    // binding behind it falls through to the assets like any client route.
    const gatekeeper = await get("/gatekeeper/inferops/no-such-leg");
    expect(gatekeeper.status).toBe(404);
    expect(await gatekeeper.text()).toBe("Not Found");
    expect(await isShell(await get("/gatekeeper/unbound/oauth"))).toBe(true);
  });
});

describe("Workshop documents isolate their browsing context group", () => {
  const COOP = "cross-origin-opener-policy";

  it("serves the fixture build the frontend's own _headers file", () => {
    // The fixture stands in for the real build, so its copy must be the file Vite ships.
    const shipped = resolve(import.meta.dirname, "../../workshop-frontend/public/_headers");
    expect(readFileSync(resolve(ROUTER_ASSETS_DIR, "_headers"), "utf8"))
      .toBe(readFileSync(shipped, "utf8"));
  });

  it("sends Cross-Origin-Opener-Policy: same-origin on the shell, its SPA fallback, deep links and assets", async () => {
    // Gadget frames may open popups that escape the sandbox; under same-origin those popups get no
    // opener into the Workshop (see packages/workshop-frontend/public/_headers).
    for (const path of ["/", "/index.html", "/w/42/canvas", "/w/42/operate", "/w/42/operate?board=ENG#x",
        "/gatekeepers/context", "/connect/handoff", "/no/such/page", "/assets/app.js"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get(COOP), path).toBe("same-origin");
    }
    // The rules file is configuration, not an asset: its path falls back to the shell.
    expect(await isShell(await get("/_headers"))).toBe(true);
  });

  it("sends it in place of a 404: on a missing asset's fallback and on the router's own 404 pages", async () => {
    // Under single-page-application handling no asset path is a 404: a missing one gets the shell.
    const missing = await get("/assets/missing.js");
    expect(await isShell(missing)).toBe(true);
    expect(missing.headers.get(COOP)).toBe("same-origin");
    // Extension routes are off in the harness, so the router answers them itself.
    for (const path of ["/extensions", "/extensions/hello-world"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get(COOP), path).toBe("same-origin");
    }
  });

  it("sends it on the HTML a gatekeeper serves through the router, and not on RPC", async () => {
    // An OAuth callback with no flow behind it renders the kit's invalid-link page. The handoff page
    // a completed sign-in renders is checked in signInThroughRouter below.
    const invalid = await get("/gatekeeper/inferops/oauth");
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("text/html");
    expect(invalid.headers.get(COOP)).toBe("same-origin");
    expect((await get("/api")).headers.get(COOP)).toBeNull();
  });
});

describe("one person's path through the router", () => {
  it("connects InferOps over /api and the gatekeeper's routed sign-in legs", async () => {
    [username] = nextUsernames("parity") as [string];
    person = fake.addPerson(username, ["operations"]);
    // `connect(harness.url)` opens the Cap'n Web WebSocket on the router's socket.
    api = await signUp(connect(harness.url), username);

    const { url, nonce } = await api.connectAccount(VENDOR);
    await api.completeConnectHandoff(await signInThroughRouter(url, person), nonce);
    account = await waitFor("the connected InferOps account", async () =>
      (await listConnectedAccounts(api)).find(a =>
        a.vendorId === VENDOR && a.description.uniqueName === person.email) ?? null);
    expect(account.credentialsValid).toBe(true);
  });

  it("reads the board through a binding and records the read as an observation", async () => {
    const ws = await api.newGadget();
    const connection = await ws.newGatekeeper(account.id, ENG_BOARD);
    if (!connection) throw new Error("No connection for the ENG board");
    connectionId = await connection.getId();
    gadgetId = (await ws.getMetadata()).id;
    const session = await connection.openSession() as RpcStub<InferOpsProjectSession>;

    const board = await session.readBoard();
    expect(board.project.identifier).toBe("ENG");
    expect(await observations(ws)).toEqual([expect.objectContaining({
      type: "observation", state: "approved", resourceUrl: ENG_BOARD,
    })]);
  });

  it("queues a transition, applies it once on approval, and refuses a second approval", async () => {
    using ws = await api.openGadget(gadgetId);
    using connection = await ws.getGatekeeperById(connectionId);
    using session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
    const issue = await (await session.openIssue(fake.issue("ENG-2").id)).read();
    const writesBefore = fake.writeRequests().length;

    await (await session.openIssue(issue.id)).transition(IN_PROGRESS.id, issue.revision);
    const [action] = await pending(ws);
    expect(action?.description.title).toBe(`Move ENG-2 to ${IN_PROGRESS.name}`);
    expect(fake.writeRequests().length).toBe(writesBefore);

    await ws.approveAction(action!.id);
    const writes = fake.writeRequests().slice(writesBefore);
    expect(writes).toHaveLength(1);
    expect(fake.commits.filter(c => c.idempotencyKey === writes[0]!.idempotencyKey)).toHaveLength(1);
    expect(fake.issue("ENG-2").stateId).toBe(IN_PROGRESS.id);
    await expect(ws.approveAction(action!.id)).rejects.toThrow(/not pending/);
    expect(fake.writeRequests().length).toBe(writesBefore + 1);

    // Held across the restart below: proposed now, approved only after it.
    const eng1 = await (await session.openIssue(fake.issue("ENG-1").id)).read();
    await (await session.openIssue(eng1.id)).update({ title: "Approved after a restart" }, eng1.revision);
    const [held] = await pending(ws);
    heldActionId = held!.id;
  });

  it("keeps every Durable Object's state across a restart of all three Workers", async () => {
    using before: RpcStub<PublicApi> = connect(harness.url);
    await before.ping();
    // Only an unread marker var changes on each Worker, so the restart is certain and nothing else
    // about the deployment moves.
    await harness.server.update(options => ({ ...options,
      workers: options.workers.map(worker => {
        if (!("config" in worker)) throw new Error("Expected inline harness config");
        return { ...worker, config: { ...worker.config,
          vars: { ...worker.config.vars, ROUTER_PARITY_RESTART: "1" } } };
      }),
    }));
    // A connection from before the restart no longer answers.
    await expect(before.ping()).rejects.toThrow();
    harness.url = (await harness.server.listen()).url;
    await settled(harness.url);
    expect(await isShell(await get("/"))).toBe(true);

    const writesBefore = fake.writeRequests().length;
    await overFreshConnection(() => harness.url, async () => {
      using fresh = await logIn(connect(harness.url), username);
      // The Workshop's user Durable Object kept the account; the gatekeeper's kept its credentials.
      expect(await inferOpsAccount(fresh, account.id)).toMatchObject({ credentialsValid: true });
      using ws = await fresh.openGadget(gadgetId);
      // The workspace's action log kept the observation and the held proposal.
      expect((await observations(ws)).map(o => o.resourceUrl)).toContain(ENG_BOARD);
      expect((await pending(ws)).map(a => a.id)).toEqual([heldActionId]);
      using connection = await ws.getGatekeeperById(connectionId);
      using session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
      expect((await session.readBoard()).project.identifier).toBe("ENG");
    });
    expect(fake.writeRequests().length).toBe(writesBefore);

    // Applying is not repeatable, so a socket dropped after the request went out is settled by
    // the issue's state rather than by approving again blindly.
    const approve = async () => {
      using fresh = await logIn(connect(harness.url), username);
      using ws = await fresh.openGadget(gadgetId);
      await ws.approveAction(heldActionId);
    };
    await approve().catch(async (error: unknown) => {
      if (!String(error).includes("WebSocket connection failed")) throw error;
      await settled(harness.url);
      if (fake.issue("ENG-1").title !== "Approved after a restart") {
        await overFreshConnection(() => harness.url, approve);
      }
    });
    expect(fake.issue("ENG-1").title).toBe("Approved after a restart");
    expect(fake.writeRequests().slice(writesBefore)).toHaveLength(1);
  });

  it("reconnects the account through the router after the restart, and the binding keeps working", async () => {
    const logoutsBefore = fake.logouts.length;
    await overFreshConnection(() => harness.url, async () => {
      using fresh = await logIn(connect(harness.url), username);
      const { url, nonce } = await fresh.reconnectAccount(account.id);
      const ticket = await signInThroughRouter(url, person);
      // Redeemed over the popup's own session, as the handoff page does.
      using popup = await logIn(connect(harness.url), username);
      await popup.completeConnectHandoff(ticket, nonce);
      await waitFor("the reconnected account", async () =>
        (await inferOpsAccount(fresh, account.id))?.credentialsValid || null);
      using ws = await fresh.openGadget(gadgetId);
      using connection = await ws.getGatekeeperById(connectionId);
      using session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
      expect((await session.readBoard()).project.identifier).toBe("ENG");
    });
    // The replaced InferLab session was signed out when the new one went live.
    expect(fake.logouts.length).toBeGreaterThan(logoutsBefore);
  });
});

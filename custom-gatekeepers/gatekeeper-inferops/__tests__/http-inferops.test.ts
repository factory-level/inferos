// The HTTP data source against a fake `fetch` that behaves like the InferOps API: the same paths,
// the same error envelope, and the same gaps (an issue read or transition is not project-scoped,
// and the board lists every workspace project).

import { describe, expect, it } from "vitest";
import {
  connectionFromEnv, endpointFromEnv, openHttpInferOpsClient, type InferOpsConnection,
} from "../src/http-inferops";
import { inferOpsErrorCode } from "../src/inferops-client";

const TOKEN = "iex_test-secret-token";
const CONNECTION: InferOpsConnection = {
  baseUrl: "https://ops.example/api", host: "ops.example", token: TOKEN,
  workspaceId: "90000000-0000-4000-8000-000000000001",
};

const DEMO = { id: "10000000-0000-4000-8000-000000000001", identifier: "DEMO", name: "Demo" };
const ENG = { id: "10000000-0000-4000-8000-000000000002", identifier: "ENG", name: "Engineering" };
const READY = "20000000-0000-4000-8000-000000000001";
const WORKING = "20000000-0000-4000-8000-000000000002";
const DRAFTING = "20000000-0000-4000-8000-000000000008";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const ENG_41 = "30000000-0000-4000-8000-000000000021";
const UNKNOWN = "30000000-0000-4000-8000-0000000000ff";

type Card = Record<string, unknown> & { id: string; stateId: string; revision: string };

function card(id: string, identifier: string, stateId: string, revision: string): Card {
  return {
    id, identifier, title: `Title of ${identifier}`, priority: "high", stateId, targetDate: null,
    workflow: "software", revision, assigneeId: null, blockedReason: null,
    // Data the gatekeeper must not hand on.
    lease: { holderId: "70000000-0000-4000-8000-000000000001", generation: "4" },
    run: { id: "80000000-0000-4000-8000-000000000001", status: "running" },
  };
}

function state(id: string, name: string, workflow = "software") {
  return { id, name, group: "started", position: 1, workflow };
}

type Call = { method: string; path: string; headers: Headers; body: unknown };

/** A fake InferOps. `override` answers a request first; returning undefined falls through. */
function fakeInferOps(override?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const issues = new Map<string, { card: Card; projectId: string }>([
    [DEMO_1, { card: card(DEMO_1, "DEMO-1", READY, "1041"), projectId: DEMO.id }],
    [ENG_41, { card: card(ENG_41, "ENG-41", READY, "977"), projectId: ENG.id }],
  ]);
  const usedKeys = new Set<string>();
  let applied = 0;
  let seq = 2000;

  const json = (status: number, body: unknown) => Response.json(body, { status });
  const error = (status: number, code: string) =>
    json(status, { success: false, error: { code, message: `server detail for ${code}` } });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api/, "") + url.search,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const overridden = override?.(call);
    if (overridden) return overridden;

    if (call.path === "/project/projects") return json(200, { projects: [DEMO, ENG] });
    if (call.path === `/project/board?projectId=${DEMO.id}`) {
      return json(200, {
        projectId: DEMO.id,
        projects: [DEMO, ENG],
        columns: [
          { state: state(READY, "Ready"), issues: [issues.get(DEMO_1)!.card] },
          { state: state(WORKING, "Working"), issues: [] },
        ],
      });
    }
    const match = /^\/project\/issues\/([^/]+)(\/transition)?$/.exec(call.path);
    const found = match && issues.get(match[1]!);
    if (!match || !found) return error(404, "NOT_FOUND");
    if (!match[2]) {
      return json(200, {
        issue: { ...found.card, projectId: found.projectId, description: "private text", comments: [] },
      });
    }
    const { toStateId, expectedRevision } = call.body as Record<string, string>;
    const key = call.headers.get("x-idempotency-key")!;
    if (usedKeys.has(key)) return json(200, { issue: found.card, deliveries: [] });
    if (toStateId === DRAFTING) return error(409, "WORKFLOW_MISMATCH");
    if (expectedRevision !== found.card.revision) return error(409, "STALE_REVISION");
    usedKeys.add(key);
    applied += 1;
    found.card = { ...found.card, stateId: toStateId!, revision: String(seq += 37) };
    return json(200, { issue: found.card, deliveries: [] });
  }) as typeof fetch;

  return { client: openHttpInferOpsClient(CONNECTION, fetcher), calls, applied: () => applied };
}

async function failure(call: Promise<unknown>): Promise<{ code: string | null; message: string }> {
  try {
    await call;
    return { code: null, message: "" };
  } catch (error) {
    return { code: inferOpsErrorCode(error), message: String(error) };
  }
}

describe("reads", () => {
  it("maps a board to the bound project only, dropping the project list, lease and run", async () => {
    const { client, calls } = fakeInferOps();

    const snapshot = await client.readProject("DEMO");

    expect(snapshot).toEqual({
      project: DEMO,
      states: [state(READY, "Ready"), state(WORKING, "Working")],
      issues: [{
        id: DEMO_1, identifier: "DEMO-1", title: "Title of DEMO-1", priority: "high",
        stateId: READY, targetDate: null, workflow: "software", revision: "1041",
        assigneeId: null, blockedReason: null,
      }],
    });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "GET /project/projects", `GET /project/board?projectId=${DEMO.id}`,
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get("x-workspace-id")).toBe(CONNECTION.workspaceId);
      expect(call.headers.has("x-idempotency-key")).toBe(false);
    }
  });

  it("lists projects by key and name, and answers an unknown project with NOT_FOUND", async () => {
    const { client } = fakeInferOps();

    expect(await client.listProjects()).toEqual([
      { identifier: "DEMO", name: "Demo" }, { identifier: "ENG", name: "Engineering" },
    ]);
    expect(await client.hasProject("ENG")).toBe(true);
    expect(await client.hasProject("NOPE")).toBe(false);
    expect((await failure(client.readProject("NOPE"))).code).toBe("NOT_FOUND");
  });

  it("returns only the card fields of an issue", async () => {
    const { client } = fakeInferOps();

    const issue = await client.readIssue("DEMO", DEMO_1);

    expect(Object.keys(issue).toSorted()).toEqual([
      "assigneeId", "blockedReason", "id", "identifier", "priority", "revision", "stateId",
      "targetDate", "title", "workflow",
    ]);
  });
});

describe("project scope", () => {
  it("refuses an issue of another project exactly as an unknown one", async () => {
    const { client } = fakeInferOps();

    const otherProject = await failure(client.readIssue("DEMO", ENG_41));
    const unknown = await failure(client.readIssue("DEMO", UNKNOWN));
    const notAnId = await failure(client.readIssue("DEMO", "../projects"));

    expect(otherProject).toEqual({
      code: "NOT_FOUND", message: "InferOpsError: NOT_FOUND: No such issue in this project.",
    });
    expect(unknown).toEqual(otherProject);
    expect(notAnId).toEqual(otherProject);
  });

  it("never sends a transition for an issue of another project", async () => {
    const { client, calls, applied } = fakeInferOps();

    const refused = await failure(client.transition("DEMO", ENG_41, WORKING, "977", "key-1"));

    expect(refused.message).toBe("InferOpsError: NOT_FOUND: No such issue in this project.");
    expect(calls.some(c => c.method === "POST")).toBe(false);
    expect(applied()).toBe(0);
  });
});

describe("transitions", () => {
  it("sends the expected revision and idempotency key, and returns the reported revision", async () => {
    const { client, calls } = fakeInferOps();

    const moved = await client.transition("DEMO", DEMO_1, WORKING, "1041", "instance:7");

    expect(moved).toMatchObject({ id: DEMO_1, stateId: WORKING, revision: "2037" });
    const post = calls.find(c => c.method === "POST")!;
    expect(post.path).toBe(`/project/issues/${DEMO_1}/transition`);
    expect(post.body).toEqual({ toStateId: WORKING, expectedRevision: "1041" });
    expect(post.headers.get("x-idempotency-key")).toBe("instance:7");
  });

  it("applies a move once when the same idempotency key is sent twice", async () => {
    const { client, applied } = fakeInferOps();

    const first = await client.transition("DEMO", DEMO_1, WORKING, "1041", "instance:7");
    const replay = await client.transition("DEMO", DEMO_1, WORKING, "1041", "instance:7");

    expect(replay).toEqual(first);
    expect(applied()).toBe(1);
  });

  it("reports a stale revision without passing on the server's text", async () => {
    const { client } = fakeInferOps();

    const stale = await failure(client.transition("DEMO", DEMO_1, WORKING, "1000", "instance:8"));

    expect(stale.code).toBe("STALE_REVISION");
    expect(stale.message).not.toContain("server detail");
  });

  it("reports a workflow mismatch", async () => {
    const { client } = fakeInferOps();

    expect((await failure(client.transition("DEMO", DEMO_1, DRAFTING, "1041", "instance:9"))).code)
      .toBe("WORKFLOW_MISMATCH");
  });

  it("reports other conflicts as CONFLICT and a vanished issue or state as NOT_FOUND", async () => {
    const answer = (status: number, code: string) => (call: Call) => call.method === "POST"
      ? Response.json({ error: { code, message: "x" } }, { status }) : undefined;

    const leased = fakeInferOps(answer(409, "LEASE_HELD"));
    expect((await failure(leased.client.transition("DEMO", DEMO_1, WORKING, "1041", "k"))).code)
      .toBe("CONFLICT");
    const gone = fakeInferOps(answer(404, "NOT_FOUND"));
    expect((await failure(gone.client.transition("DEMO", DEMO_1, WORKING, "1041", "k"))).code)
      .toBe("NOT_FOUND");
  });

  it("refuses a malformed request before sending anything", async () => {
    const { client, calls } = fakeInferOps();

    expect((await failure(client.transition("DEMO", DEMO_1, WORKING, "1041", ""))).code)
      .toBe("INVALID_REQUEST");
    expect((await failure(client.transition("DEMO", DEMO_1, WORKING, "next", "k"))).code)
      .toBe("INVALID_REQUEST");
    expect((await failure(client.transition("DEMO", DEMO_1, "not-a-state", "1041", "k"))).code)
      .toBe("INVALID_STATE");
    expect(calls).toEqual([]);
  });
});

describe("credential and provider failures", () => {
  it("reports a rejected or revoked credential as UNAUTHORIZED, without the token", async () => {
    const { client } = fakeInferOps(() =>
      Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, { status: 401 }));

    const refused = await failure(client.readProject("DEMO"));

    expect(refused.code).toBe("UNAUTHORIZED");
    expect(refused.message).not.toContain(TOKEN);
    expect((await failure(client.transition("DEMO", DEMO_1, WORKING, "1041", "k"))).code)
      .toBe("UNAUTHORIZED");
  });

  it("reports a missing permission as FORBIDDEN", async () => {
    const { client } = fakeInferOps(() =>
      Response.json({ error: { code: "FORBIDDEN", message: "No access" } }, { status: 403 }));

    expect((await failure(client.listProjects())).code).toBe("FORBIDDEN");
  });

  it.each([
    ["a 5xx", () => new Response("upstream exploded", { status: 502 })],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a body of the wrong shape", () => Response.json({ projects: [{ id: 7 }] })],
  ])("reports %s as UNAVAILABLE", async (_name, respond) => {
    const { client } = fakeInferOps(respond);

    expect((await failure(client.readProject("DEMO"))).code).toBe("UNAVAILABLE");
  });

  it("reports a network failure as UNAVAILABLE", async () => {
    const client = openHttpInferOpsClient(CONNECTION, (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch);

    expect((await failure(client.listProjects())).code).toBe("UNAVAILABLE");
  });

  it("rejects a board whose cards are malformed or belong to another project", async () => {
    const board = (body: unknown) => (call: Call) =>
      call.path.startsWith("/project/board") ? Response.json(body) : undefined;
    const numericRevision = fakeInferOps(board({
      projectId: DEMO.id, projects: [],
      columns: [{ state: state(READY, "Ready"), issues: [{ ...card(DEMO_1, "DEMO-1", READY, "1"), revision: 1 }] }],
    }));
    const otherProject = fakeInferOps(board({ projectId: ENG.id, projects: [], columns: [] }));

    expect((await failure(numericRevision.client.readProject("DEMO"))).code).toBe("UNAVAILABLE");
    expect((await failure(otherProject.client.readProject("DEMO"))).code).toBe("UNAVAILABLE");
  });
});

describe("connection configuration", () => {
  it("is absent until a token is set, and names a missing variable without its value", () => {
    expect(connectionFromEnv({})).toBeNull();
    // A base URL alone is the API connected people call with their own session, not a stopgap.
    expect(connectionFromEnv({ INFEROPS_BASE_URL: "http://localhost:8080" })).toBeNull();
    expect(() => connectionFromEnv({ INFEROPS_API_TOKEN: TOKEN }))
      .toThrow("INFEROPS_API_TOKEN is set but INFEROPS_BASE_URL is not.");
    expect(() => connectionFromEnv({ INFEROPS_BASE_URL: "http://localhost:8080", INFEROPS_API_TOKEN: TOKEN }))
      .toThrow("INFEROPS_API_TOKEN is set but INFEROPS_WORKSPACE_ID is not.");
    expect(() => connectionFromEnv({
      INFEROPS_BASE_URL: "ftp://ops.example", INFEROPS_API_TOKEN: TOKEN, INFEROPS_WORKSPACE_ID: "w",
    })).toThrow("must be an http(s) URL");
  });

  it("names the API endpoint from the base URL alone", () => {
    expect(endpointFromEnv({})).toBeNull();
    expect(endpointFromEnv({ INFEROPS_BASE_URL: "https://ops.example/api/" }))
      .toEqual({ baseUrl: "https://ops.example/api", host: "ops.example" });
    expect(() => endpointFromEnv({ INFEROPS_BASE_URL: "nope" })).toThrow("INFEROPS_BASE_URL is not a URL.");
  });

  it("derives the host a resource URL must name from the base URL", () => {
    expect(connectionFromEnv({
      INFEROPS_BASE_URL: "http://LOCALHOST:8080/", INFEROPS_API_TOKEN: TOKEN,
      INFEROPS_WORKSPACE_ID: CONNECTION.workspaceId,
    })).toEqual({
      baseUrl: "http://localhost:8080", host: "localhost:8080", token: TOKEN,
      workspaceId: CONNECTION.workspaceId,
    });
  });
});

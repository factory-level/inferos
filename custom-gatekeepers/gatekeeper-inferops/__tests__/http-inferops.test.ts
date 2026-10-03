// The HTTP data source against a fake `fetch` that behaves like the InferOps API: the same paths,
// the same error envelope, and the same gaps (an issue read or transition is not project-scoped,
// and the board lists every workspace project).

import { describe, expect, it } from "vitest";
import {
  connectionFromEnv, endpointFromEnv, listWorkspaceSlugs, openHttpInferOpsClient,
  type InferOpsConnection,
} from "../src/http-inferops";
import { inferOpsErrorCode } from "../src/inferops-client";

const TOKEN = "iex_test-secret-token";
const CONNECTION: InferOpsConnection = {
  baseUrl: "https://ops.example/api", host: "ops.example", token: TOKEN,
  workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "operations",
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

/**
 * A fake InferOps. `override` answers a request first; returning undefined falls through. Like
 * InferOps, a write replays a known idempotency key per operation without comparing bodies.
 */
function fakeInferOps(override?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const issues = new Map<string, { card: Card; projectId: string }>([
    [DEMO_1, { card: card(DEMO_1, "DEMO-1", READY, "1041"), projectId: DEMO.id }],
    [ENG_41, { card: card(ENG_41, "ENG-41", READY, "977"), projectId: ENG.id }],
  ]);
  const usedKeys = new Set<string>();
  const results = new Map<string, Card>();
  let applied = 0;
  let seq = 2000;
  let numbered = 1;
  /** When set, the next create is committed but its response is lost. */
  const network = { loseNextCreate: false };

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
    const key = call.headers.get("x-idempotency-key");
    if (call.method === "POST" && call.path === "/project/issues") {
      const replayed = key && results.get(`create:${key}`);
      if (replayed) return json(201, { issue: replayed });
      const body = call.body as Record<string, string>;
      if (body.projectId !== DEMO.id) return error(404, "NOT_FOUND");
      if (body.stateId === DRAFTING && body.workflow !== "content") return error(409, "WORKFLOW_MISMATCH");
      const id = `30000000-0000-4000-8000-${String(900 + numbered).padStart(12, "0")}`;
      const created: Card = {
        ...card(id, `DEMO-${100 + numbered++}`, body.stateId!, String(seq += 37)),
        title: body.title!, priority: body.priority ?? "none", workflow: body.workflow ?? "software",
      };
      issues.set(id, { card: created, projectId: DEMO.id });
      results.set(`create:${key}`, created);
      applied += 1;
      if (network.loseNextCreate) {
        network.loseNextCreate = false;
        throw new TypeError("connection reset after the write committed");
      }
      return json(201, { issue: created });
    }
    const match = /^\/project\/issues\/([^/]+)(\/transition)?$/.exec(call.path);
    const found = match && issues.get(match[1]!);
    if (!match || !found) return error(404, "NOT_FOUND");
    if (call.method === "PATCH") {
      const replayed = key && results.get(`update:${key}`);
      if (replayed) return json(200, { issue: replayed });
      const { expectedRevision, title, priority } = call.body as Record<string, string>;
      if (expectedRevision !== found.card.revision) return error(409, "STALE_REVISION");
      found.card = {
        ...found.card, ...(title ? { title } : {}), ...(priority ? { priority } : {}),
        revision: String(seq += 37),
      };
      results.set(`update:${key}`, found.card);
      applied += 1;
      return json(200, { issue: found.card, deliveries: [] });
    }
    if (!match[2]) {
      return json(200, {
        issue: { ...found.card, projectId: found.projectId, description: "private text", comments: [] },
      });
    }
    const { toStateId, expectedRevision } = call.body as Record<string, string>;
    if (usedKeys.has(key!)) return json(200, { issue: found.card, deliveries: [] });
    if (toStateId === DRAFTING) return error(409, "WORKFLOW_MISMATCH");
    if (expectedRevision !== found.card.revision) return error(409, "STALE_REVISION");
    usedKeys.add(key!);
    applied += 1;
    found.card = { ...found.card, stateId: toStateId!, revision: String(seq += 37) };
    return json(200, { issue: found.card, deliveries: [] });
  }) as typeof fetch;

  return {
    client: openHttpInferOpsClient(CONNECTION, fetcher), calls, applied: () => applied, network,
    issues,
  };
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

describe("creates", () => {
  it("posts the bound project's id and only the named fields, with the idempotency key", async () => {
    const { client, calls } = fakeInferOps();

    const created = await client.createIssue(
      "DEMO", { title: "Runbook", priority: "high", stateId: READY }, "instance:3");

    expect(created).toMatchObject({ identifier: "DEMO-101", title: "Runbook", stateId: READY });
    expect(Object.keys(created)).not.toContain("lease");
    const post = calls.find(c => c.method === "POST")!;
    expect(post.path).toBe("/project/issues");
    expect(post.body).toEqual({ projectId: DEMO.id, title: "Runbook", priority: "high", stateId: READY });
    expect(post.headers.get("x-idempotency-key")).toBe("instance:3");
    expect(post.headers.get("x-workspace-id")).toBe(CONNECTION.workspaceId);
    expect(post.headers.get("content-type")).toBe("application/json");
  });

  it("names a content workflow and a description when given", async () => {
    const { client, calls } = fakeInferOps();

    await client.createIssue(
      "DEMO", { title: "Post", description: "Body", stateId: DRAFTING, workflow: "content" }, "k");

    expect(calls.find(c => c.method === "POST")!.body).toEqual({
      projectId: DEMO.id, title: "Post", description: "Body", stateId: DRAFTING, workflow: "content",
    });
  });

  it("retries a create whose response was lost under the same key, creating one issue", async () => {
    const { client, calls, applied, network } = fakeInferOps();
    network.loseNextCreate = true;

    const lost = await failure(client.createIssue("DEMO", { title: "Once", stateId: READY }, "instance:4"));
    const retried = await client.createIssue("DEMO", { title: "Once", stateId: READY }, "instance:4");

    expect(lost.code).toBe("UNAVAILABLE");
    expect(retried).toMatchObject({ identifier: "DEMO-101", title: "Once" });
    expect(applied()).toBe(1);
    expect(calls.filter(c => c.method === "POST").map(c => c.headers.get("x-idempotency-key")))
      .toEqual(["instance:4", "instance:4"]);
  });

  it("refuses an unknown project before sending anything", async () => {
    const { client, calls } = fakeInferOps();

    expect((await failure(client.createIssue("NOPE", { title: "x", stateId: READY }, "k"))).code)
      .toBe("NOT_FOUND");
    expect(calls.some(c => c.method === "POST")).toBe(false);
    expect((await failure(client.createIssue("DEMO", { title: "x", stateId: "nope" }, "k"))).code)
      .toBe("INVALID_STATE");
    expect((await failure(client.createIssue("DEMO", { title: "x", stateId: READY }, ""))).code)
      .toBe("INVALID_REQUEST");
  });

  it.each([
    [400, "VALIDATION_ERROR", "INVALID_REQUEST"],
    [404, "NOT_FOUND", "NOT_FOUND"],
    [409, "WORKFLOW_MISMATCH", "WORKFLOW_MISMATCH"],
    [409, "CONFLICT", "CONFLICT"],
    [503, "INTERNAL", "UNAVAILABLE"],
  ])("maps a %i %s to %s", async (status, code, expected) => {
    const { client } = fakeInferOps(call => call.method === "POST"
      ? Response.json({ error: { code, message: "server detail" } }, { status }) : undefined);

    const refused = await failure(client.createIssue("DEMO", { title: "x", stateId: READY }, "k"));

    expect(refused.code).toBe(expected);
    expect(refused.message).not.toContain("server detail");
  });

  it("reports a workflow-policy refusal as FORBIDDEN, naming the policy", async () => {
    const { client } = fakeInferOps(call => call.method === "POST"
      ? Response.json({
        error: { code: "FORBIDDEN", message: "denied", details: { decision: { allowed: false }, decisions: [] } },
      }, { status: 403 })
      : undefined);

    const refused = await failure(client.createIssue("DEMO", { title: "x", stateId: READY }, "k"));

    expect(refused.code).toBe("FORBIDDEN");
    expect(refused.message).toContain("workflow policy");
  });
});

describe("updates", () => {
  it("patches the changed fields with the expected revision and idempotency key", async () => {
    const { client, calls } = fakeInferOps();

    const updated = await client.updateIssue(
      "DEMO", DEMO_1, { title: "New", description: null }, "1041", "instance:5");

    expect(updated).toMatchObject({ id: DEMO_1, title: "New", revision: "2037" });
    const patch = calls.find(c => c.method === "PATCH")!;
    expect(patch.path).toBe(`/project/issues/${DEMO_1}`);
    expect(patch.body).toEqual({ title: "New", description: null, expectedRevision: "1041" });
    expect(patch.headers.get("x-idempotency-key")).toBe("instance:5");
  });

  it("applies an update once when the same key is sent twice", async () => {
    const { client, applied } = fakeInferOps();

    const first = await client.updateIssue("DEMO", DEMO_1, { priority: "low" }, "1041", "instance:6");
    const replay = await client.updateIssue("DEMO", DEMO_1, { priority: "low" }, "1041", "instance:6");

    expect(replay).toEqual(first);
    expect(applied()).toBe(1);
  });

  it("never patches an issue of another project", async () => {
    const { client, calls, applied } = fakeInferOps();

    const refused = await failure(client.updateIssue("DEMO", ENG_41, { title: "x" }, "977", "k"));

    expect(refused.message).toBe("InferOpsError: NOT_FOUND: No such issue in this project.");
    expect(calls.some(c => c.method === "PATCH")).toBe(false);
    expect(applied()).toBe(0);
  });

  it("reports a stale revision, and refuses a malformed update before sending it", async () => {
    const { client, calls } = fakeInferOps();

    expect((await failure(client.updateIssue("DEMO", DEMO_1, { title: "x" }, "1000", "k"))).code)
      .toBe("STALE_REVISION");
    const before = calls.length;
    expect((await failure(client.updateIssue("DEMO", DEMO_1, {}, "1041", "k"))).code)
      .toBe("INVALID_REQUEST");
    expect((await failure(client.updateIssue("DEMO", DEMO_1, { title: "x" }, "", "k"))).code)
      .toBe("INVALID_REQUEST");
    expect((await failure(client.updateIssue("DEMO", DEMO_1, { title: "x" }, "1041", ""))).code)
      .toBe("INVALID_REQUEST");
    expect(calls.length).toBe(before);
  });

  it("reports a revoked credential as UNAUTHORIZED and a refusal as FORBIDDEN", async () => {
    const revoked = fakeInferOps(() =>
      Response.json({ error: { code: "UNAUTHORIZED", message: "revoked" } }, { status: 401 }));
    expect((await failure(revoked.client.updateIssue("DEMO", DEMO_1, { title: "x" }, "1041", "k"))).code)
      .toBe("UNAUTHORIZED");
    const refused = fakeInferOps(call => call.method === "PATCH"
      ? Response.json({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }) : undefined);
    const forbidden = await failure(refused.client.updateIssue("DEMO", DEMO_1, { title: "x" }, "1041", "k"));
    expect(forbidden.code).toBe("FORBIDDEN");
    expect(forbidden.message).not.toContain("workflow policy");
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
      INFEROPS_BASE_URL: "http://localhost:8080", INFEROPS_API_TOKEN: TOKEN, INFEROPS_WORKSPACE_ID: "w",
    })).toThrow("INFEROPS_API_TOKEN is set but INFEROPS_WORKSPACE_SLUG is not.");
    expect(() => connectionFromEnv({
      INFEROPS_BASE_URL: "http://localhost:8080", INFEROPS_API_TOKEN: TOKEN, INFEROPS_WORKSPACE_ID: "w",
      INFEROPS_WORKSPACE_SLUG: "Operations",
    })).toThrow("INFEROPS_WORKSPACE_SLUG is not a workspace slug.");
    expect(() => connectionFromEnv({
      INFEROPS_BASE_URL: "ftp://ops.example", INFEROPS_API_TOKEN: TOKEN, INFEROPS_WORKSPACE_ID: "w",
      INFEROPS_WORKSPACE_SLUG: "operations",
    })).toThrow("must be an http(s) URL");
  });

  it("names the API endpoint from the base URL alone", () => {
    expect(endpointFromEnv({})).toBeNull();
    expect(endpointFromEnv({ INFEROPS_BASE_URL: "https://ops.example/api/" }))
      .toEqual({ baseUrl: "https://ops.example/api", host: "ops.example" });
    expect(() => endpointFromEnv({ INFEROPS_BASE_URL: "nope" })).toThrow("INFEROPS_BASE_URL is not a URL.");
  });

  it("normalizes the base URL and keeps the workspace slug a resource URL must name", () => {
    expect(connectionFromEnv({
      INFEROPS_BASE_URL: "http://LOCALHOST:8080/", INFEROPS_API_TOKEN: TOKEN,
      INFEROPS_WORKSPACE_ID: CONNECTION.workspaceId, INFEROPS_WORKSPACE_SLUG: "operations",
    })).toEqual({
      baseUrl: "http://localhost:8080", host: "localhost:8080", token: TOKEN,
      workspaceId: CONNECTION.workspaceId, workspaceSlug: "operations",
    });
  });
});

describe("workspace slugs", () => {
  const OPS = "90000000-0000-4000-8000-0000000000AA";
  const respond = (body: unknown, status = 200) => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return Response.json(body, { status });
    }) as typeof fetch;
    return { calls, fetcher };
  };

  it("lists id and slug from GET /workspaces with the bearer token and no workspace header", async () => {
    const { calls, fetcher } = respond([
      { id: OPS, tenant_id: "t", product: "inferops", name: "Operations", slug: "operations" },
    ]);
    expect(await listWorkspaceSlugs("https://ops.example/api", TOKEN, fetcher))
      .toEqual([{ workspaceId: OPS.toLowerCase(), slug: "operations" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ops.example/api/workspaces");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers.has("x-workspace-id")).toBe(false);
  });

  it("fails on a malformed slug or a refused token instead of returning partial data", async () => {
    const bad = respond([{ id: OPS, slug: "Not A Slug" }]);
    expect((await failure(listWorkspaceSlugs("https://ops.example", TOKEN, bad.fetcher))).code)
      .toBe("UNAVAILABLE");
    const refused = respond({ error: { code: "UNAUTHORIZED", message: "no" } }, 401);
    expect((await failure(listWorkspaceSlugs("https://ops.example", TOKEN, refused.fetcher))).code)
      .toBe("UNAUTHORIZED");
  });
});

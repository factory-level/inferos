// The HTTP data source against a fake `fetch` that behaves like the InferOps API: the same paths,
// the same error envelope, and the same gaps (an issue read or transition is not project-scoped,
// and the board lists every workspace project).

import { describe, expect, it } from "vitest";
import {
  WIKI_FORBIDDEN, connectionFromEnv, endpointFromEnv, listWorkspaceSlugs, openHttpInferOpsClient,
  type InferOpsConnection,
} from "../src/http-inferops";
import { inferOpsErrorCode, isPolicyRefusal, writeStage } from "../src/inferops-client";

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

describe("write stages", () => {
  /** How far a failed write got, as the gatekeeper reads it. */
  async function stageOf(call: Promise<unknown>) {
    try {
      await call;
      return null;
    } catch (error) {
      return { code: inferOpsErrorCode(error), stage: writeStage(error), policy: isPolicyRefusal(error) };
    }
  }
  const answer = (status: number, body: unknown) => (call: Call) =>
    call.method !== "GET" ? Response.json(body, { status }) : undefined;

  it("marks InferOps' refusal of the write itself as refused, with a policy denial named", async () => {
    for (const [status, code] of [[400, "BAD"], [401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"],
                                  [409, "STALE_REVISION"]] as const) {
      const { client } = fakeInferOps(answer(status, { error: { code, message: "x" } }));
      expect(await stageOf(client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))
        .toMatchObject({ stage: "refused", policy: false });
    }
    const { client } = fakeInferOps(answer(403, {
      error: { code: "FORBIDDEN", message: "denied", details: { decision: { allowed: false } } },
    }));
    expect(await stageOf(client.createIssue("DEMO", { title: "x", stateId: READY }, "k")))
      .toEqual({ code: "FORBIDDEN", stage: "refused", policy: true });
  });

  it("proves nothing for a refusal status without InferOps' error envelope, except a 401", async () => {
    for (const status of [400, 403, 404, 409]) {
      for (const body of [{ message: "gateway says no" }, { error: "flat string" }, { error: { code: 7 } }, "<html>"]) {
        const { client } = fakeInferOps(answer(status, body));
        expect((await stageOf(client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))?.stage).toBeUndefined();
      }
      const empty = fakeInferOps(call => call.method !== "GET" ? new Response("", { status }) : undefined);
      expect((await stageOf(empty.client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))?.stage).toBeUndefined();
    }
    // The auth layer's 401 turns the request away whatever its body.
    const turnedAway = fakeInferOps(call => call.method !== "GET" ? new Response("no", { status: 401 }) : undefined);
    expect(await stageOf(turnedAway.client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))
      .toMatchObject({ code: "UNAUTHORIZED", stage: "refused" });
  });

  it("proves nothing for a 5xx, another 4xx, a lost response or an unusable success", async () => {
    for (const status of [429, 500, 502]) {
      const { client } = fakeInferOps(answer(status, { error: { code: "X", message: "x" } }));
      expect((await stageOf(client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))?.stage).toBeUndefined();
    }
    const malformed = fakeInferOps(answer(200, { issue: { id: "not an issue" } }));
    expect(await stageOf(malformed.client.transition("DEMO", DEMO_1, WORKING, "1041", "k")))
      .toMatchObject({ code: "UNAVAILABLE", stage: undefined });
    const lost = fakeInferOps(call => {
      if (call.method === "PATCH") throw new TypeError("connection reset");
      return undefined;
    });
    expect(await stageOf(lost.client.updateIssue("DEMO", DEMO_1, { title: "t" }, "1041", "k")))
      .toMatchObject({ code: "UNAVAILABLE", stage: undefined });
  });

  it("marks a failed check or scope read before the write as unsent, whatever the read answered", async () => {
    const { client, calls } = fakeInferOps();
    expect(await stageOf(client.transition("DEMO", DEMO_1, WORKING, "next", "k")))
      .toMatchObject({ code: "INVALID_REQUEST", stage: "unsent" });
    expect(await stageOf(client.transition("DEMO", ENG_41, WORKING, "977", "k")))
      .toMatchObject({ code: "NOT_FOUND", stage: "unsent" });
    expect(calls.filter(c => c.method !== "GET")).toEqual([]);

    // The scope read itself failing (here a 500) still sent no write.
    const down = fakeInferOps(call => call.method === "GET" ? Response.json({}, { status: 500 }) : undefined);
    expect(await stageOf(down.client.updateIssue("DEMO", DEMO_1, { title: "t" }, "1041", "k")))
      .toMatchObject({ code: "UNAVAILABLE", stage: "unsent" });
    expect(down.calls.filter(c => c.method !== "GET")).toEqual([]);
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

describe("coding runs", () => {
  const REPO = "40000000-0000-4000-8000-000000000001";
  const RUN_DEMO = "50000000-0000-4000-8000-000000000001";
  const RUN_ENG = "50000000-0000-4000-8000-000000000002";

  function wireRun(id: string, issueId: string, extra: Record<string, unknown> = {}) {
    return {
      id, issueId, repoId: REPO, action: "code", status: "queued", externalRunId: null,
      baseRef: null, requestedBy: "70000000-0000-4000-8000-000000000001", leaseGeneration: "3",
      result: null, error: null, queuedAt: "2026-10-03T00:00:00.000Z", startedAt: null,
      finishedAt: null, ...extra,
    };
  }

  /** The base fake plus runs, repos, dispatch and cancel, answering as InferOps does. */
  function codingFake(answer?: (call: Call) => Response | undefined) {
    return fakeInferOps(call => {
      const answered = answer?.(call);
      if (answered) return answered;
      if (call.path === "/project/repos") {
        return Response.json({ repos: [
          { id: REPO, slug: "web-app", gitUrl: "git@forge:acme/web-app.git", defaultBaseRef: "main", enabled: true },
        ] });
      }
      if (call.path.startsWith("/project/runs?")) {
        return Response.json({ runs: [wireRun(RUN_ENG, ENG_41), wireRun(RUN_DEMO, DEMO_1)] });
      }
      if (call.path === `/project/runs/${RUN_DEMO}`) return Response.json({ run: wireRun(RUN_DEMO, DEMO_1) });
      if (call.path === `/project/runs/${RUN_ENG}`) return Response.json({ run: wireRun(RUN_ENG, ENG_41) });
      if (call.method === "POST" && call.path === `/project/issues/${DEMO_1}/dispatch`) {
        return Response.json({ run: wireRun(RUN_DEMO, DEMO_1) }, { status: 201 });
      }
      if (call.method === "POST" && call.path === `/project/runs/${RUN_DEMO}/cancel`) {
        return Response.json({ run: wireRun(RUN_DEMO, DEMO_1, { status: "cancelled" }) });
      }
      return undefined;
    });
  }

  const paths = (calls: Call[]) => calls.map(c => `${c.method} ${c.path}`);

  it("lists repositories without their clone URLs", async () => {
    const { client } = codingFake();

    expect(await client.listRepos()).toEqual([
      { id: REPO, slug: "web-app", defaultBaseRef: "main", enabled: true },
    ]);
  });

  it("lists only the bound project's runs, with each issue's key, dropping requester and lease", async () => {
    const { client, calls } = codingFake();

    const runs = await client.listRuns("DEMO");

    expect(runs).toEqual([{
      id: RUN_DEMO, issueId: DEMO_1, issueIdentifier: "DEMO-1", repoId: REPO, status: "queued",
      baseRef: null, externalRunId: null, result: null, error: null,
      queuedAt: "2026-10-03T00:00:00.000Z", startedAt: null, finishedAt: null,
    }]);
    expect(paths(calls).at(-1)).toBe("GET /project/runs?limit=200");
  });

  it("refuses a run of another project exactly as an unknown one", async () => {
    const { client } = codingFake();

    const otherProject = await failure(client.readRun("DEMO", RUN_ENG));
    const unknown = await failure(client.readRun("DEMO", "50000000-0000-4000-8000-0000000000ff"));
    const notAnId = await failure(client.readRun("DEMO", "../issues"));

    expect(otherProject.message).toContain("NOT_FOUND: No such run in this project.");
    expect(unknown.message).toBe(otherProject.message);
    expect(notAnId.message).toBe(otherProject.message);
    expect((await client.readRun("DEMO", RUN_DEMO)).issueIdentifier).toBe("DEMO-1");
  });

  it("keeps a well-formed patch and test summary, and leaves out a patch it cannot read", async () => {
    const patch = { path: "/w/r/result.patch", sha256: "ab".repeat(32), files: 1, insertions: 2, deletions: 0 };
    const finished = (result: unknown) => codingFake(call => call.path === `/project/runs/${RUN_DEMO}`
      ? Response.json({ run: wireRun(RUN_DEMO, DEMO_1, { status: "succeeded", result }) }) : undefined);

    expect((await finished({ summary: "ok", testSummary: "3 passed", patch }).client.readRun("DEMO", RUN_DEMO)).result)
      .toEqual({ summary: "ok", testSummary: "3 passed", patch });
    expect((await finished({ summary: "ok", patch: { path: 1 } }).client.readRun("DEMO", RUN_DEMO)).result)
      .toEqual({ summary: "ok" });
    expect((await failure(finished({ testSummary: "x" }).client.readRun("DEMO", RUN_DEMO))).code)
      .toBe("UNAVAILABLE");
  });

  it("keeps well-formed test evidence and a known reason code, and leaves out what it cannot read", async () => {
    const command = {
      index: 1, argv: ["pnpm", "test"], exitCode: 1, timedOut: false, durationMs: 8123, truncated: false,
      artifacts: { stdout: "/w/r/.a/test-1.stdout", stderr: "/w/r/.a/test-1.stderr", record: "/w/r/.a/test-1.json" },
    };
    const timedOut = { ...command, index: 2, exitCode: null, timedOut: true };
    const tests = { directory: "/w/r/.a", passed: 0, failed: 2, commands: [command, timedOut] };
    const finished = (result: unknown) => codingFake(call => call.path === `/project/runs/${RUN_DEMO}`
      ? Response.json({ run: wireRun(RUN_DEMO, DEMO_1, { status: "failed", result }) }) : undefined);
    const read = async (result: unknown) => (await finished(result).client.readRun("DEMO", RUN_DEMO)).result;

    expect(await read({ summary: "s", tests, reasonCode: "TESTS_FAILED", extra: 1 }))
      .toEqual({ summary: "s", tests, reasonCode: "TESTS_FAILED" });
    expect(await read({ summary: "s", reasonCode: "AUTH_BLOCKED" })).toEqual({ summary: "s", reasonCode: "AUTH_BLOCKED" });
    expect(await read({ summary: "s", reasonCode: "QUOTA_BLOCKED" })).toEqual({ summary: "s", reasonCode: "QUOTA_BLOCKED" });
    // An unknown reason, and test evidence with any malformed command, are left out whole.
    expect(await read({ summary: "s", reasonCode: "SOMETHING_NEW" })).toEqual({ summary: "s" });
    expect(await read({ summary: "s", tests: { ...tests, commands: [command, { ...command, argv: [] }] } })).toEqual({ summary: "s" });
    expect(await read({ summary: "s", tests: { ...tests, commands: [{ ...command, artifacts: null }] } })).toEqual({ summary: "s" });
    expect(await read({ summary: "s", tests: { ...tests, passed: -1 } })).toEqual({ summary: "s" });
    expect(await read({ summary: "s", tests: { ...tests, commands: Array.from({ length: 101 }, () => command) } })).toEqual({ summary: "s" });
  });

  it("dispatches with only the named fields and the idempotency key, after the scope check", async () => {
    const { client, calls } = codingFake();

    const run = await client.dispatchIssue("DEMO", DEMO_1, { repoId: REPO, baseRef: "main", expectedRevision: "1041" }, "inst:7");

    expect(run.id).toBe(RUN_DEMO);
    const post = calls.at(-1)!;
    expect(`${post.method} ${post.path}`).toBe(`POST /project/issues/${DEMO_1}/dispatch`);
    expect(post.body).toEqual({ action: "code", repoId: REPO, baseRef: "main", expectedRevision: "1041" });
    expect(post.headers.get("x-idempotency-key")).toBe("inst:7");
  });

  it("never dispatches an issue of another project", async () => {
    const { client, calls } = codingFake();

    expect((await failure(client.dispatchIssue("DEMO", ENG_41, { repoId: REPO, expectedRevision: "977" }, "k"))).code)
      .toBe("NOT_FOUND");
    expect(calls.some(c => c.method === "POST")).toBe(false);
  });

  it.each([
    [403, "FORBIDDEN", "FORBIDDEN"],
    [409, "RUN_ACTIVE", "RUN_ACTIVE"],
    [409, "STALE_REVISION", "STALE_REVISION"],
    [409, "LEASE_QUARANTINED", "CONFLICT"],
    [409, "WORKFLOW_MISMATCH", "WORKFLOW_MISMATCH"],
    [400, "VALIDATION", "INVALID_REQUEST"],
  ])("maps a dispatch answered %i %s to %s", async (status, wire, code) => {
    const { client } = codingFake(call => call.path.endsWith("/dispatch")
      ? Response.json({ error: { code: wire, message: "server detail" } }, { status }) : undefined);

    const refused = await failure(client.dispatchIssue("DEMO", DEMO_1, { repoId: REPO, expectedRevision: "1041" }, "k"));

    expect(refused.code).toBe(code);
    expect(refused.message).not.toContain("server detail");
  });

  it("cancels a run of the project only", async () => {
    const { client, calls } = codingFake();

    expect((await client.cancelRun("DEMO", RUN_DEMO, "inst:9")).status).toBe("cancelled");
    expect(calls.at(-1)!.headers.get("x-idempotency-key")).toBe("inst:9");
    const before = calls.length;
    expect((await failure(client.cancelRun("DEMO", RUN_ENG, "inst:10"))).code).toBe("NOT_FOUND");
    expect(calls.slice(before).some(c => c.method === "POST")).toBe(false);
  });
});

describe("the InferMind Wiki over HTTP", () => {
  const DOC = "60000000-0000-4000-8000-000000000001";
  const OTHER_DOC = "60000000-0000-4000-8000-000000000002";
  const SECTION = "61000000-0000-4000-8000-000000000001";
  const MISSING = "61000000-0000-4000-8000-0000000000ff";
  const ROOT = "60000000-0000-4000-8000-000000000010";
  const UNFILED = "60000000-0000-4000-8000-000000000011";
  /** InferOps' `GET /knowledge/wiki/structure` answer, bare, with extra fields it may add. */
  const STRUCTURE = {
    root: { documentId: ROOT, slug: "company", title: "Acme", parentId: null },
    pillars: [{
      key: "engineering", title: "Engineering", position: 0, retiredAt: null,
      master: { documentId: DOC.toUpperCase(), slug: "handbook", title: "Handbook", parentId: ROOT },
      members: [{ documentId: OTHER_DOC, slug: "ops/runbook", title: "Runbook", parentId: DOC, source: "intake", position: 3 }],
    }, { key: "sales", title: "Sales", position: 1, master: null, members: [] }],
    unfiled: [{ documentId: UNFILED, slug: "notes", title: "Notes", parentId: null }],
  };

  type WikiCall = { method: string; path: string; headers: Headers; body: unknown };

  /**
   * InferOps' knowledge routes as they answer: bare JSON (no envelope), `null` for a missing page
   * or section, and a 403 whose message says which gate refused.
   */
  function fakeWiki(override?: (call: WikiCall) => Response | undefined) {
    const calls: WikiCall[] = [];
    const section = { id: SECTION, documentId: DOC, tag: "purpose", body: "Old body.", version: 4 };
    const page = { body: "The page body.", version: 7, lastKey: null as string | null };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: WikiCall = {
        method: init?.method ?? "GET", path: url.pathname.replace(/^\/api/, "") + url.search,
        headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const overridden = override?.(call);
      if (overridden) return overridden;
      if (call.path === "/knowledge/documents") {
        return Response.json([{
          id: DOC.toUpperCase(), workspaceId: CONNECTION.workspaceId, slug: "handbook", title: "Handbook",
          summary: "private summary", pathway: "engineering", parentId: null, siblingOrder: 2,
        }]);
      }
      if (call.path === `/knowledge/documents/${DOC}`) {
        return Response.json({
          id: DOC, workspaceId: CONNECTION.workspaceId, slug: "handbook", title: "Handbook",
          summary: null, pathway: null, parentId: null, siblingOrder: 2, body: page.body,
          version: page.version, masterRole: "pillar",
        });
      }
      if (call.path === "/knowledge/wiki/structure") return Response.json(STRUCTURE);
      if (call.path === `/knowledge/wiki/pages/${DOC}` && call.method === "PATCH") {
        // InferOps' strict compare-and-swap: only this key's own write, one version on, replays.
        const { body, expectedVersion } = call.body as { body: string; expectedVersion: number };
        const key = call.headers.get("x-idempotency-key");
        if (page.version !== expectedVersion) {
          if (!(page.lastKey === key && page.version === expectedVersion + 1)) {
            return Response.json({ success: false, error: { code: "STALE_VERSION", message: "The page changed" } },
              { status: 409 });
          }
        } else {
          page.body = body;
          page.version += 1;
          page.lastKey = key;
        }
        return Response.json({ document: {
          id: DOC, workspaceId: CONNECTION.workspaceId, slug: "handbook", title: "Handbook", summary: null,
          pathway: null, parentId: null, siblingOrder: 2, version: page.version, masterRole: "pillar",
        } });
      }
      if (call.path.startsWith("/knowledge/wiki/pages/")) {
        return Response.json({ success: false, error: { code: "NOT_FOUND", message: "Page not found" } }, { status: 404 });
      }
      if (call.path.startsWith("/knowledge/documents/")) return Response.json(null);
      if (call.path === `/knowledge/sections?documentId=${DOC}`) return Response.json([section]);
      if (call.path === `/knowledge/sections/${SECTION}` && call.method === "GET") return Response.json(section);
      if (call.path === `/knowledge/sections/${SECTION}` && call.method === "PATCH") {
        section.body = (call.body as { body: string }).body;
        section.version += 1;
        return Response.json(section);
      }
      if (call.path.startsWith("/knowledge/sections/")) return new Response(null, { status: 200 });
      return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 });
    }) as typeof fetch;
    return { calls, fetcher, client: openHttpInferOpsClient(CONNECTION, fetcher) };
  }

  it("lists pages from the bare array, keeping only the tree fields", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.listDocuments()).toEqual([
      { id: DOC, slug: "handbook", title: "Handbook", parentId: null, siblingOrder: 2 },
    ]);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers.get("x-workspace-id")).toBe(CONNECTION.workspaceId);
  });

  it("reads a page with its body, version and Master role, and answers a missing one NOT_FOUND", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.readDocument(DOC)).toEqual({
      id: DOC, slug: "handbook", title: "Handbook", body: "The page body.", version: 7, masterRole: "pillar",
    });
    const missing = await client.readDocument(OTHER_DOC).catch(e => e);
    expect(inferOpsErrorCode(missing)).toBe("NOT_FOUND");
    const before = calls.length;
    expect(inferOpsErrorCode(await client.readDocument("../x").catch(e => e))).toBe("NOT_FOUND");
    expect(calls.length).toBe(before);
  });

  it("lists sections only after the page itself is found, and refuses another page's section", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.listSections(DOC)).toEqual([
      { id: SECTION, documentId: DOC, tag: "purpose", body: "Old body.", version: 4 },
    ]);
    expect(calls.map(c => c.path)).toEqual([`/knowledge/documents/${DOC}`, `/knowledge/sections?documentId=${DOC}`]);
    expect(inferOpsErrorCode(await client.listSections(OTHER_DOC).catch(e => e))).toBe("NOT_FOUND");
    expect(calls.some(c => c.path.includes(OTHER_DOC) && c.path.startsWith("/knowledge/sections"))).toBe(false);

    const { client: mixed } = fakeWiki(call => call.path.startsWith("/knowledge/sections?")
      ? Response.json([{ id: SECTION, documentId: OTHER_DOC, tag: "x", body: "", version: 1 }]) : undefined);
    expect(inferOpsErrorCode(await mixed.listSections(DOC).catch(e => e))).toBe("UNAVAILABLE");
  });

  it("answers a missing section NOT_FOUND, whether InferOps sends null or nothing", async () => {
    const { client } = fakeWiki();
    expect(inferOpsErrorCode(await client.readSection(MISSING).catch(e => e))).toBe("NOT_FOUND");
    const { client: nulls } = fakeWiki(call => call.path === `/knowledge/sections/${MISSING}` ? Response.json(null) : undefined);
    expect(inferOpsErrorCode(await nulls.readSection(MISSING).catch(e => e))).toBe("NOT_FOUND");
  });

  it("patches only the body, with the idempotency key, after finding the section", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.updateSection(SECTION, "New body.", "inst:7"))
      .toMatchObject({ id: SECTION, body: "New body.", version: 5 });
    const patch = calls.find(c => c.method === "PATCH")!;
    expect(patch.body).toEqual({ body: "New body." });
    expect(patch.headers.get("x-idempotency-key")).toBe("inst:7");
    expect(calls.map(c => c.method)).toEqual(["GET", "PATCH"]);

    const before = calls.length;
    expect(inferOpsErrorCode(await client.updateSection(MISSING, "x", "inst:8").catch(e => e))).toBe("NOT_FOUND");
    expect(calls.slice(before).map(c => c.method)).toEqual(["GET"]);
    expect(inferOpsErrorCode(await client.updateSection(SECTION, "x", "").catch(e => e))).toBe("INVALID_REQUEST");
  });

  it("maps a 403 to FORBIDDEN with one Wiki message, never InferOps' own text", async () => {
    for (const message of ["Wrong product for this route", "Missing permission: knowledge:write"]) {
      const { client } = fakeWiki(() =>
        Response.json({ success: false, error: { code: "FORBIDDEN", message } }, { status: 403 }));
      const error = await client.listDocuments().catch(e => e) as Error;
      expect(inferOpsErrorCode(error)).toBe("FORBIDDEN");
      expect(error.message).toBe(`FORBIDDEN: ${WIKI_FORBIDDEN}`);
    }
  });

  it("reads a page InferOps reports without a Master role as no Master, and refuses a malformed one", async () => {
    const detail = (extra: Record<string, unknown>) => fakeWiki(call => call.path === `/knowledge/documents/${DOC}`
      ? Response.json({ id: DOC, slug: "handbook", title: "Handbook", parentId: null, siblingOrder: 0, ...extra })
      : undefined).client;
    expect((await detail({ body: "", version: 1 }).readDocument(DOC)).masterRole).toBeNull();
    for (const extra of [
      { body: "", version: 1, masterRole: "admin" }, { version: 1 }, { body: "", version: "1" }, { body: null, version: 1 },
    ]) {
      expect(inferOpsErrorCode(await detail(extra).readDocument(DOC).catch(e => e)), JSON.stringify(extra))
        .toBe("UNAVAILABLE");
    }
  });

  it("reads the structure field by field, lowercasing ids and keeping only the named fields", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.readStructure()).toEqual({
      root: { id: ROOT, slug: "company", title: "Acme", parentId: null },
      pillars: [{
        key: "engineering", title: "Engineering", position: 0,
        master: { id: DOC, slug: "handbook", title: "Handbook", parentId: ROOT },
        members: [{ id: OTHER_DOC, slug: "ops/runbook", title: "Runbook", parentId: DOC, source: "intake" }],
      }, { key: "sales", title: "Sales", position: 1, master: null, members: [] }],
      unfiled: [{ id: UNFILED, slug: "notes", title: "Notes", parentId: null }],
    });
    expect(calls.at(-1)!.path).toBe("/knowledge/wiki/structure");
    expect(calls.at(-1)!.headers.get("x-workspace-id")).toBe(CONNECTION.workspaceId);
  });

  it.each([
    ["an enveloped body", () => ({ structure: STRUCTURE })],
    ["a root that is not a page", () => ({ ...STRUCTURE, root: "company" })],
    ["a page id that is not a UUID", () => ({ ...STRUCTURE, unfiled: [{ documentId: "notes", slug: "n", title: "N", parentId: null }] })],
    ["an unknown member source", () => ({ ...STRUCTURE, pillars: [{ ...STRUCTURE.pillars[0]!,
      members: [{ ...STRUCTURE.pillars[0]!.members[0]!, source: "robot" }] }] })],
    ["a pillar key that is not a slug", () => ({ ...STRUCTURE, pillars: [{ ...STRUCTURE.pillars[1]!, key: "Sales Team" }] })],
    ["a fractional position", () => ({ ...STRUCTURE, pillars: [{ ...STRUCTURE.pillars[1]!, position: 1.5 }] })],
    ["a missing unfiled list", () => ({ root: null, pillars: [] })],
  ])("refuses a structure with %s as UNAVAILABLE", async (_, malformed) => {
    const { client } = fakeWiki(call => call.path === "/knowledge/wiki/structure" ? Response.json(malformed()) : undefined);
    expect(inferOpsErrorCode(await client.readStructure().catch(e => e))).toBe("UNAVAILABLE");
  });

  it("edits a page body with its expected version and key, and maps InferOps' stale answer", async () => {
    const { client, calls } = fakeWiki();
    expect(await client.updateDocument(DOC, { body: "New page body." }, 7, "inst:3")).toEqual({ id: DOC, version: 8 });
    const patch = calls.at(-1)!;
    expect(patch).toMatchObject({ method: "PATCH", path: `/knowledge/wiki/pages/${DOC}`,
                                  body: { body: "New page body.", expectedVersion: 7 } });
    expect(patch.headers.get("x-idempotency-key")).toBe("inst:3");
    expect(patch.headers.get("content-type")).toBe("application/json");
    // One request: InferOps compares the version, so nothing is read first.
    expect(calls).toHaveLength(1);

    // The same key one version on is InferOps' replay; another key is stale.
    expect(await client.updateDocument(DOC, { body: "New page body." }, 7, "inst:3")).toEqual({ id: DOC, version: 8 });
    const stale = await client.updateDocument(DOC, { body: "New page body." }, 7, "inst:4").catch(e => e) as Error;
    expect(inferOpsErrorCode(stale)).toBe("STALE_REVISION");
    expect(stale.message).toBe("STALE_REVISION: The page changed in InferOps. Read it again.");

    expect(inferOpsErrorCode(await client.updateDocument(OTHER_DOC, { body: "x" }, 1, "k").catch(e => e))).toBe("NOT_FOUND");
    const before = calls.length;
    for (const [id, version, key] of [["../x", 1, "k"], [DOC, 0, "k"], [DOC, 1.5, "k"], [DOC, 1, ""]] as const) {
      expect(await client.updateDocument(id, { body: "x" }, version, key).catch(e => inferOpsErrorCode(e)))
        .toBe(id === DOC ? "INVALID_REQUEST" : "NOT_FOUND");
    }
    expect(calls.length).toBe(before);
  });

  it("maps a refused page edit to the one Wiki message, and a mismatched answer to UNAVAILABLE", async () => {
    const { client } = fakeWiki(call => call.method === "PATCH"
      ? Response.json({ error: { code: "FORBIDDEN", message: "Missing permission: knowledge:write" } }, { status: 403 })
      : undefined);
    expect(String(await client.updateDocument(DOC, { body: "x" }, 7, "k").catch(e => e))).toContain(WIKI_FORBIDDEN);
    const { client: other } = fakeWiki(call => call.method === "PATCH"
      ? Response.json({ document: { id: OTHER_DOC, version: 8 } }) : undefined);
    expect(inferOpsErrorCode(await other.updateDocument(DOC, { body: "x" }, 7, "k").catch(e => e))).toBe("UNAVAILABLE");
  });

  it("treats a response that does not match the contract as UNAVAILABLE", async () => {
    const { client } = fakeWiki(call => call.path === `/knowledge/sections/${SECTION}`
      ? Response.json({ id: SECTION, documentId: DOC, tag: "t", body: "b", version: "4" }) : undefined);
    expect(inferOpsErrorCode(await client.readSection(SECTION).catch(e => e))).toBe("UNAVAILABLE");
    const { client: wrapped } = fakeWiki(call => call.path === "/knowledge/documents"
      ? Response.json({ documents: [] }) : undefined);
    expect(inferOpsErrorCode(await wrapped.listDocuments().catch(e => e))).toBe("UNAVAILABLE");
  });
});

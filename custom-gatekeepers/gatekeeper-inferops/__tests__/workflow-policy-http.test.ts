// Workflow policy over the HTTP data source, against a fake `fetch` that answers like InferOps'
// `project.list` (`GET /project/projects`) and `workflow.get` (`GET /project/projects/:id/workflow`)
// and InferOps' error envelope. Covers what the mock cannot: exactly two GETs per read and no other
// request, the key resolved in the bound workspace first, the one refusal for 403 and 404 on either
// read, 401 and outages, strict and foreign answers, and logs that carry no value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openHttpInferOpsClient, type InferOpsConnection } from "../src/http-inferops";
import { inferOpsErrorCode } from "../src/inferops-client";
import { WORKFLOW_POLICY_UNREADABLE_MESSAGE, projectWorkflowHead } from "../src/workflow-policy";
import DEMO_WORKFLOW from "../src/fixtures/demo-workflow.json";

const CONNECTION: InferOpsConnection = {
  baseUrl: "https://ops.example/api", host: "ops.example", token: "iex_test-secret-token",
  workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "operations",
};
const PROJECT = { id: "10000000-0000-4000-8000-000000000001", identifier: "DEMO", name: "Demo" };
const OTHER = { id: "10000000-0000-4000-8000-000000000002", identifier: "ENG", name: "Engineering" };

const CANARIES = [
  "canary-top-rule-reason-3f9a", "canary-fragment-rule-reason-5d1e", "canary-binding-rule-reason-8b2c",
  "canary-transition-rule-reason-6c4d", "canary-agent-responsibility-2e7b",
  "c0a9e700-0000-4000-8000-0000000a9e71", "c0b1b500-0000-4000-8000-0000000b1b51", "canary",
];

const answer = () => structuredClone(DEMO_WORKFLOW.projects.DEMO) as { head: Record<string, any> };

type Call = {
  method: string; path: string; search: string; body: unknown; headers: Headers;
  redirect?: RequestInit["redirect"];
};

/** A fake InferOps: the project list, then `workflow(call)` for the workflow read; every request recorded. */
function fake(options: {
  projects?: () => Response; workflow?: (call: Call) => Response;
} = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET", path: url.pathname.replace(/^\/api/, ""), search: url.search,
      body: init?.body, headers: new Headers(init?.headers), redirect: init?.redirect,
    };
    calls.push(call);
    if (call.path === "/project/projects") return options.projects?.() ?? Response.json({ projects: [OTHER, PROJECT] });
    if (call.path === `/project/projects/${PROJECT.id}/workflow` || call.path === `/project/projects/${OTHER.id}/workflow`) {
      return options.workflow?.(call) ?? Response.json(answer());
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 });
  }) as typeof fetch;
  return { calls, client: openHttpInferOpsClient(CONNECTION, fetcher) };
}

const refused = (status: number, code: string) =>
  Response.json({ success: false, error: { code, message: `server detail for ${code}` } }, { status });

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** Everything this gatekeeper logged during a test, as one string. */
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(arg => arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function traceFree(text: string): void {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
  for (const key of ['"reason"', '"agents"', '"publishedBy"', '"responsibility"']) expect(text).not.toContain(key);
}

describe("a workflow policy over HTTP", () => {
  it("is exactly two GETs: the project list, then that project's content workflow, as the person in the bound workspace", async () => {
    const { calls, client } = fake();
    await client.readWorkflowPolicy("DEMO");
    expect(calls.map(c => [c.method, c.path, c.search, c.body])).toEqual([
      ["GET", "/project/projects", "", undefined],
      ["GET", `/project/projects/${PROJECT.id}/workflow`, "?workflow=content", undefined],
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${CONNECTION.token}`);
      expect(call.headers.get("x-workspace-id")).toBe(CONNECTION.workspaceId);
      expect(call.headers.has("x-idempotency-key")).toBe(false);
      // A redirect would carry the credential to wherever it points: it is never followed.
      expect(call.redirect).toBe("manual");
    }
  });

  it("caches nothing: every read is two fresh GETs, and a republished policy shows its new revision", async () => {
    let revision = "3";
    const { calls, client } = fake({
      workflow: () => {
        const next = answer();
        next.head.revision = revision;
        return Response.json(next);
      },
    });
    expect((await client.readWorkflowPolicy("DEMO")).revision).toBe("3");
    revision = "4";
    expect((await client.readWorkflowPolicy("DEMO")).revision).toBe("4");
    expect(calls).toHaveLength(4);
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });

  it("parses InferOps' answer, and the projection leaves no trace of what it drops", async () => {
    const { client } = fake();
    const projected = projectWorkflowHead(await client.readWorkflowPolicy("DEMO"));
    expect(projected.projectId).toBe(PROJECT.id);
    expect(projected.policy!.rules!.map(rule => rule.id)).toEqual(["owners-all", "no-agent-publish"]);
    traceFree(JSON.stringify(projected));
    traceFree(logged.join("\n"));
  });

  it("resolves the key in the bound workspace's own list: a key it does not list is NOT_FOUND, with no workflow read", async () => {
    const { calls, client } = fake({ projects: () => Response.json({ projects: [OTHER] }) });
    expect(await failure(client.readWorkflowPolicy("DEMO")))
      .toBe("InferOpsError: NOT_FOUND: No such workflow policy is available to you.");
    expect(calls.map(c => c.path)).toEqual(["/project/projects"]);
    // A workspace with no projects at all is the same answer.
    const empty = fake({ projects: () => Response.json({ projects: [] }) });
    expect(await failure(empty.client.readWorkflowPolicy("DEMO")))
      .toBe("InferOpsError: NOT_FOUND: No such workflow policy is available to you.");
  });

  it("answers 403 and 404 on either read with the one NOT_FOUND, whatever InferOps said", async () => {
    const outcomes = new Set<string>();
    for (const status of [403, 404] as const) {
      const code = status === 403 ? "FORBIDDEN" : "NOT_FOUND";
      const onList = fake({ projects: () => refused(status, code) });
      outcomes.add(await failure(onList.client.readWorkflowPolicy("DEMO")));
      expect(onList.calls).toHaveLength(1);
      const onWorkflow = fake({ workflow: () => refused(status, code) });
      outcomes.add(await failure(onWorkflow.client.readWorkflowPolicy("DEMO")));
      expect(onWorkflow.calls).toHaveLength(2);
    }
    // An explicit project:read deny is InferOps' 403 with its decision; the same one answer.
    const denied = fake({
      workflow: () => Response.json({
        success: false,
        error: { code: "FORBIDDEN", message: "Missing permission: project:read", details: { decision: { reasonCodes: ["DENIED"] } } },
      }, { status: 403 }),
    });
    outcomes.add(await failure(denied.client.readWorkflowPolicy("DEMO")));
    expect([...outcomes]).toEqual(["InferOpsError: NOT_FOUND: No such workflow policy is available to you."]);
    for (const outcome of outcomes) expect(outcome).not.toContain("server detail");
  });

  it("leaves a 401 to the account to adjudicate, and an outage UNAVAILABLE", async () => {
    expect(inferOpsErrorCode(await fake({ projects: () => refused(401, "UNAUTHORIZED") }).client
      .readWorkflowPolicy("DEMO").catch(e => e))).toBe("UNAUTHORIZED");
    expect(inferOpsErrorCode(await fake({ workflow: () => refused(401, "UNAUTHORIZED") }).client
      .readWorkflowPolicy("DEMO").catch(e => e))).toBe("UNAUTHORIZED");
    expect(inferOpsErrorCode(await fake({ workflow: () => new Response("down", { status: 502 }) }).client
      .readWorkflowPolicy("DEMO").catch(e => e))).toBe("UNAVAILABLE");
    expect(inferOpsErrorCode(await fake({ workflow: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }) }).client
      .readWorkflowPolicy("DEMO").catch(e => e))).toBe("UNAVAILABLE");
  });

  it("refuses a non-JSON, truncated, malformed, ambiguous or foreign answer as UNAVAILABLE, naming no value", async () => {
    const broken = answer();
    broken.head.policy.rules[0].subjects[0] = { role: "owner", note: "canary-in-a-bad-subject" };
    const ambiguous = answer();
    ambiguous.head.configured = false;
    const bodies: Array<[string, () => Response]> = [
      ["not JSON", () => new Response("<html>canary-html</html>", { headers: { "content-type": "text/html" } })],
      ["truncated", () => new Response(JSON.stringify(answer()).slice(0, 200), { headers: { "content-type": "application/json" } })],
      ["empty", () => new Response("", { status: 200 })],
      ["malformed", () => Response.json(broken)],
      ["ambiguous", () => Response.json(ambiguous)],
      ["foreign project", () => {
        const foreign = answer();
        foreign.head.projectId = OTHER.id;
        return Response.json(foreign);
      }],
      ["a future provider field", () => {
        const future = answer();
        future.head.policy.lanes[0].color = "canary-future-field";
        return Response.json(future);
      }],
    ];
    for (const [name, workflow] of bodies) {
      logged = [];
      const { client } = fake({ workflow });
      const error = await failure(client.readWorkflowPolicy("DEMO"));
      expect(error, name).toMatch(/^InferOpsError: UNAVAILABLE: /);
      expect(error, name).not.toContain("canary");
      traceFree(error);
      const logs = logged.join("\n");
      traceFree(logs);
      expect(logs, name).not.toContain("canary");
      expect(logs, name).not.toContain(CONNECTION.token);
    }
    // A shape mismatch is logged as such, by operation only.
    logged = [];
    await failure(fake({ workflow: () => Response.json(broken) }).client.readWorkflowPolicy("DEMO"));
    expect(logged.join("\n")).toContain("workflow.get");
    expect(logged.join("\n")).toContain("http.response.malformed");
    expect(await failure(fake({ workflow: () => Response.json(broken) }).client.readWorkflowPolicy("DEMO")))
      .toBe(`InferOpsError: UNAVAILABLE: ${WORKFLOW_POLICY_UNREADABLE_MESSAGE}`);
  });

  it("never sends the key anywhere but the project list, and never puts the token in an error", async () => {
    const { calls, client } = fake();
    await client.readWorkflowPolicy("DEMO");
    expect(calls.some(call => call.path.includes("DEMO") || call.search.includes("DEMO"))).toBe(false);
    const error = await failure(fake({ workflow: () => refused(500, "INTERNAL") }).client.readWorkflowPolicy("DEMO"));
    expect(error).not.toContain(CONNECTION.token);
  });
});

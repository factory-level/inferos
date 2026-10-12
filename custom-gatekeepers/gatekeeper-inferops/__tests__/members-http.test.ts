// Workspace members over the HTTP data source, against a fake `fetch` that answers like InferOps'
// `member.list` (`GET /workspace/members`): the strict workspace-only list, email included, and
// InferOps' error envelope. Covers what the mock cannot: the exact request, the one refusal for
// 403 and 404, the bound-workspace fence, strict answers and redirects.

import { describe, expect, it } from "vitest";
import { openHttpInferOpsClient, type InferOpsConnection } from "../src/http-inferops";
import { inferOpsErrorCode } from "../src/inferops-client";
import { projectMembers } from "../src/members";

const CONNECTION: InferOpsConnection = {
  baseUrl: "https://ops.example/api", host: "ops.example", token: "iex_test-secret-token",
  workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "operations",
};
const WORKSPACE = CONNECTION.workspaceId;

function member(overrides: Record<string, unknown> = {}) {
  return {
    principalId: "00000000-0000-4000-8000-000000000101", type: "user", name: "Olivia Owner",
    email: "owner@acme.test", role: "owner", deniedPermissions: [], ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}, members: unknown[] = [member()]) {
  return {
    workspace: { workspaceId: WORKSPACE, workspaceName: "Field Ops", product: "inferops" },
    members, ...overrides,
  };
}

type Call = { method: string; path: string; search: string; body: unknown; headers: Headers; redirect?: RequestInit["redirect"] };

/** A fake InferOps answering `answer(call)`, recording every request. */
function fake(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET", path: url.pathname.replace(/^\/api/, ""), search: url.search,
      body: init?.body, headers: new Headers(init?.headers), redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, client: openHttpInferOpsClient(CONNECTION, fetcher) };
}

const ok = (body: unknown) => Response.json(body);
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

describe("workspace members over HTTP", () => {
  it("is exactly GET /workspace/members with the person's token and the bound workspace", async () => {
    const { calls, client } = fake(() => ok(answer()));
    await client.listWorkspaceMembers(WORKSPACE);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect([call!.method, call!.path, call!.search, call!.body]).toEqual(["GET", "/workspace/members", "", undefined]);
    expect(call!.headers.get("authorization")).toBe(`Bearer ${CONNECTION.token}`);
    expect(call!.headers.get("x-workspace-id")).toBe(WORKSPACE);
    // A redirect would carry the credential to wherever it points: it is never followed.
    expect(call!.redirect).toBe("manual");
  });

  it("parses the strict answer, and the projection drops every email", async () => {
    const service = member({
      principalId: "00000000-0000-4000-8000-000000000022", type: "service_account", name: "sre-agent",
      email: null, role: "operations", deniedPermissions: ["billing:*"],
    });
    const { client } = fake(() => ok(answer({}, [member(), service])));
    const read = await client.listWorkspaceMembers(WORKSPACE);
    expect(read.members.map(m => m.email)).toEqual(["owner@acme.test", null]);
    const shown = projectMembers(read);
    expect(shown).toEqual({
      workspace: { workspaceId: WORKSPACE, workspaceName: "Field Ops", product: "inferops" },
      members: [
        { principalId: "00000000-0000-4000-8000-000000000101", type: "user", name: "Olivia Owner", role: "owner", deniedPermissions: [] },
        { principalId: "00000000-0000-4000-8000-000000000022", type: "service_account", name: "sre-agent", role: "operations", deniedPermissions: ["billing:*"] },
      ],
    });
    expect(JSON.stringify(shown)).not.toContain("acme.test");
    expect(JSON.stringify(shown)).not.toContain("email");
  });

  it("answers 403 and 404 with one identical NOT_FOUND, never the server's detail", async () => {
    const messages: string[] = [];
    for (const [status, code] of [[403, "FORBIDDEN"], [404, "NOT_FOUND"]] as const) {
      const { client } = fake(() => refused(status, code));
      const error = await client.listWorkspaceMembers(WORKSPACE).catch(e => e);
      expect(inferOpsErrorCode(error)).toBe("NOT_FOUND");
      messages.push(String(error));
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toContain("server detail");
  });

  it("keeps a dead sign-in and an outage distinct from a refusal", async () => {
    expect(inferOpsErrorCode(await fake(() => refused(401, "UNAUTHENTICATED")).client
      .listWorkspaceMembers(WORKSPACE).catch(e => e))).toBe("UNAUTHORIZED");
    expect(inferOpsErrorCode(await fake(() => refused(500, "INTERNAL")).client
      .listWorkspaceMembers(WORKSPACE).catch(e => e))).toBe("UNAVAILABLE");
  });

  it("refuses an answer about another workspace, an extra field or a missing one as UNAVAILABLE", async () => {
    const bad: unknown[] = [
      answer({ workspace: { workspaceId: "90000000-0000-4000-8000-000000000002", workspaceName: "Other", product: "inferops" } }),
      answer({ total: 1 }),
      answer({}, [member({ grantId: "00000000-0000-4000-8000-000000000111" })]),
      answer({}, [{ ...member(), email: undefined }]),
      answer({}, [member({ type: "robot" })]),
      answer({}, [member({ principalId: "not-a-uuid" })]),
      answer({ workspace: { workspaceId: WORKSPACE, workspaceName: "Field Ops", product: "inferops", tenantId: "t" } }),
      { members: [member()] },
      [],
    ];
    for (const body of bad) {
      const { client } = fake(() => ok(body));
      const error = await client.listWorkspaceMembers(WORKSPACE).catch(e => e);
      expect(inferOpsErrorCode(error), JSON.stringify(body)).toBe("UNAVAILABLE");
      // The error never repeats what the answer contained.
      expect(String(error)).not.toContain("owner@acme.test");
      expect(String(error)).not.toContain("Olivia");
    }
  });

  it("does not follow a redirect, and sends the request only once", async () => {
    const { calls, client } = fake(() =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }));
    expect(await failure(client.listWorkspaceMembers(WORKSPACE))).toMatch(/UNAVAILABLE|NOT_FOUND|UNAUTHORIZED/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/workspace/members");
  });

  it("never puts the token in an error", async () => {
    const { client } = fake(() => refused(500, "INTERNAL"));
    expect(await failure(client.listWorkspaceMembers(WORKSPACE))).not.toContain(CONNECTION.token);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/inferops";

afterEach(() => vi.unstubAllGlobals());

describe("public readiness route", () => {
  it.each([
    { upstreamStatus: "ok", upstreamHttp: 200, expectedStatus: 200, expectedBody: "ok" },
    { upstreamStatus: "degraded", upstreamHttp: 200, expectedStatus: 200, expectedBody: "degraded" },
    { upstreamStatus: "down", upstreamHttp: 503, expectedStatus: 503, expectedBody: "down" },
  ])("maps $upstreamStatus readiness while returning only component names and statuses", async ({ upstreamStatus, upstreamHttp, expectedStatus, expectedBody }) => {
    const seen: { url: string; headers: Headers; redirect?: RequestInit["redirect"] }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
      return Response.json({ status: upstreamStatus, checks: [{ name: "database", status: upstreamStatus === "ok" ? "ok" : "down", error: "private provider details" }], secret: "private" }, { status: upstreamHttp });
    });
    const env = { INFEROPS_BASE_URL: "https://ops.example/v1", INFEROPS_EDGE_SECRET: "edge-secret" } as unknown as Cloudflare.Env;
    const response = await worker.fetch(new Request("https://stage.example/gatekeeper/inferops/health/ready"), env, {} as ExecutionContext);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ status: expectedBody, checks: [{ name: "database", status: upstreamStatus === "ok" ? "ok" : "down" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://ops.example/v1/health/ready");
    expect(seen[0]?.headers.get("x-inferos-edge")).toBe("edge-secret");
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("treats an unreadable readiness body as unavailable", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    const env = { INFEROPS_BASE_URL: "https://ops.example" } as unknown as Cloudflare.Env;
    const response = await worker.fetch(new Request("https://stage.example/gatekeeper/inferops/health/ready"), env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "down", checks: [] });
  });

  it("fails closed when InferOps is not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await worker.fetch(new Request("https://stage.example/gatekeeper/inferops/health/ready"), {} as Cloudflare.Env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "down", checks: [{ name: "inferops-config", status: "down" }] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

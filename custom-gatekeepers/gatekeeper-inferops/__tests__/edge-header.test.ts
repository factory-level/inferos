// The shared-secret edge header: sent to the configured InferLab origins when the deployment holds
// INFEROPS_EDGE_SECRET, never otherwise and never anywhere else, through every request path.

import { afterEach, describe, expect, it, vi } from "vitest";
import { INFEROPS_EDGE_HEADER, inferLabFetch } from "../src/edge-header";
import { fetchBoardSnapshot, listWorkspaceSlugs, openHttpInferOpsClient } from "../src/http-inferops";
import { logoutInferLabSession, refreshInferLabSession } from "../src/inferops-credentials";

const SECRET = "edge_secret-0123456789abcdefABCDEF0123";
const AUTH = "https://auth.dev.inferlab.example";
const API = "https://api.dev.inferlab.example";
// Vite's static `import.meta.glob`, which this package's worker types do not declare.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

const ENV = { INFEROPS_EDGE_SECRET: SECRET, INFERLAB_AUTH_ORIGIN: AUTH, INFEROPS_BASE_URL: `${API}/v1` };

type Seen = { url: string; headers: Headers; redirect: RequestInit["redirect"] };

/** Stubs the global `fetch` (which `inferLabFetch` reads per call), recording each request. */
function recordFetch(reply: (url: string) => Response = () => Response.json({})) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    return reply(url);
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inferLabFetch", () => {
  it("adds the header for the auth origin and the API origin, and never follows a redirect", async () => {
    const seen = recordFetch();
    const send = inferLabFetch(ENV);
    await send(`${AUTH}/auth/token`, { method: "POST", headers: { accept: "application/json" } });
    await send(`${API}/v1/project/projects`, { headers: new Headers({ authorization: "Bearer t" }) });
    expect(seen.map(s => s.headers.get(INFEROPS_EDGE_HEADER))).toEqual([SECRET, SECRET]);
    expect(seen.map(s => s.redirect)).toEqual(["manual", "manual"]);
    // The caller's own headers survive.
    expect(seen[0]!.headers.get("accept")).toBe("application/json");
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer t");
  });

  it("sends nothing extra when the secret is unset or blank", async () => {
    const seen = recordFetch();
    for (const secret of [undefined, "", "   "]) {
      await inferLabFetch({ ...ENV, INFEROPS_EDGE_SECRET: secret })(`${AUTH}/auth/token`, { method: "POST" });
    }
    expect(seen.every(s => !s.headers.has(INFEROPS_EDGE_HEADER))).toBe(true);
    expect(seen.every(s => s.redirect === undefined)).toBe(true);
  });

  it("never sends it to a foreign origin, however close it looks", async () => {
    const seen = recordFetch();
    const send = inferLabFetch(ENV);
    for (const url of [
      "https://evil.example/auth/token",
      "https://auth.dev.inferlab.example.evil.example/auth/token",
      "http://auth.dev.inferlab.example/auth/token",
      "https://auth.dev.inferlab.example:8443/auth/token",
      "https://dev.inferlab.example/",
    ]) {
      await send(url, { redirect: "follow" });
    }
    expect(seen).toHaveLength(5);
    expect(seen.every(s => !s.headers.has(INFEROPS_EDGE_HEADER))).toBe(true);
    // A foreign request is passed through untouched.
    expect(seen.every(s => s.redirect === "follow")).toBe(true);
  });

  it("sends it to no origin at all when neither InferLab origin is configured", async () => {
    const seen = recordFetch();
    await inferLabFetch({ INFEROPS_EDGE_SECRET: SECRET })(`${AUTH}/auth/token`);
    expect(seen[0]!.headers.has(INFEROPS_EDGE_HEADER)).toBe(false);
  });
});

describe("every InferLab request path carries it", () => {
  const grant = { accessToken: "a", accessExpiresAt: 0, refreshToken: "r" };

  it("session refresh and logout", async () => {
    const seen = recordFetch(() => Response.json({ token: "a2", refreshToken: "r2" }));
    await refreshInferLabSession(AUTH, grant, inferLabFetch(ENV));
    await logoutInferLabSession(AUTH, "r", inferLabFetch(ENV));
    expect(seen.map(s => new URL(s.url).pathname)).toEqual(["/auth/refresh", "/auth/logout"]);
    expect(seen.every(s => s.headers.get(INFEROPS_EDGE_HEADER) === SECRET)).toBe(true);
  });

  it("the workspace list, the board snapshot and the API client", async () => {
    const seen = recordFetch(url =>
      url.endsWith("/workspaces") ? Response.json([]) :
      url.endsWith("/project/projects") ? Response.json({ projects: [] }) :
      Response.json({}, { status: 404 }));
    const fetcher = inferLabFetch(ENV);
    await listWorkspaceSlugs(`${API}/v1`, "t", fetcher);
    await fetchBoardSnapshot(`${API}/v1`, "t", "inferops://acme.ops/project/board/ENG", fetcher);
    const client = openHttpInferOpsClient({
      baseUrl: `${API}/v1`, host: new URL(API).host, token: "t",
      workspaceId: "90000000-0000-4000-8000-000000000001", workspaceSlug: "ops",
    }, fetcher);
    await client.listProjects();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every(s => s.headers.get(INFEROPS_EDGE_HEADER) === SECRET)).toBe(true);
  });
});

// Every outgoing request in the worker is built in one place. A new `fetch(` anywhere else would
// reach InferLab without the header (and the edge would refuse it), so it fails here first.
describe("source guard", () => {
  const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

  it("only edge-header.ts calls the global fetch", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith("/edge-header.ts"))
      // A call, `globalThis.fetch`, or `fetch` as a default; not a `fetch()` handler declaration.
      .filter(([, text]) => /(?<![.\w]|async )fetch\s*\(|globalThis\.fetch|=\s*fetch\b/m.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

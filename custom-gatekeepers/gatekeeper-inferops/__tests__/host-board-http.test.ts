// The kernel-only host-board read over HTTP (`fetchBoardSnapshot`), against a fake `fetch` that
// answers like InferOps' `project.board_snapshot`: the principal-lane request, the strict envelope
// with every published bound at its limit and one over, bodies abandoned at their byte cap while
// streaming (before anything is buffered whole or parsed), and every refusal reduced to a bounded
// reason with nothing InferOps said, the reference or the token reaching a result or a log. The
// facet (props, switch, fences, kernel-only reach) is covered in account.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_BOARD_LIMITS as L } from "@gadgets/gatekeeper-kit/host-board";
import { fetchBoardSnapshot, type BoardSnapshotAnswer } from "../src/http-inferops";
import { inferOpsErrorCode } from "../src/inferops-client";
import { hostBoardRef, hostBoardsEnabled } from "../src/host-board";

const BASE = "https://ops.example/api";
const TOKEN = "secret-access-token";
const REF = "inferops://acme.operations/project/board/ENG";
const WORKSPACE = "90000000-0000-4000-8000-000000000001";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const SERVER_TEXT = "server detail that must not leak";

type Call = { url: URL; init: RequestInit; headers: Headers };

function fake(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init, headers: new Headers(init.headers) };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, read: () => fetchBoardSnapshot(BASE, TOKEN, REF, fetcher) };
}

function issue(n: number, overrides: Record<string, unknown> = {}) {
  return { identifier: `ENG-${n}`, title: `Issue ${n}`, priority: "medium", targetDate: null, blocked: false, ...overrides };
}

function column(issues: unknown[], overrides: Record<string, unknown> = {}) {
  return { label: "Ready", group: "unstarted", issues, ...overrides };
}

function envelope(overrides: { scope?: unknown; snapshot?: Record<string, unknown>; project?: unknown; columns?: unknown[] } = {}) {
  return {
    scope: overrides.scope ?? { workspaceId: WORKSPACE, projectId: PROJECT },
    snapshot: {
      project: overrides.project ?? { identifier: "ENG", name: "Engineering" },
      columns: overrides.columns ?? [column([issue(1, { targetDate: "2026-10-31", blocked: true, priority: "urgent" })])],
      ...overrides.snapshot,
    },
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refusal = (status: number, code: string) =>
  json({ error: { code, message: SERVER_TEXT, details: { ref: REF } } }, status);

/** A body of exactly `bytes` UTF-8 bytes: valid JSON padded with trailing whitespace. */
function padded(value: unknown, bytes: number): string {
  const text = JSON.stringify(value);
  const length = new TextEncoder().encode(text).byteLength;
  if (length > bytes) throw new Error(`fixture is already ${length} bytes`);
  return text + " ".repeat(bytes - length);
}

/** An endless body, one KiB per pull, recording how much was pulled and whether it was cancelled. */
function endless(status: number) {
  const seen = { pulls: 0, cancelled: false };
  const chunk = new TextEncoder().encode(" ".repeat(1024));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulls++;
      controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { seen, response: new Response(body, { status, headers: { "content-type": "application/json" } }) };
}

/** Everything the logger wrote during a test. */
let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(JSON.stringify(args)); });
  }
});
afterEach(() => vi.restoreAllMocks());

const SENTINEL = "PRIVATE_CUSTOMER_SENTINEL";

/** The sentinel reached neither the result nor any log line. */
function expectNoSentinel(answer: unknown) {
  expect(JSON.stringify(answer)).not.toContain(SENTINEL);
  expect(logged.join("\n")).not.toContain(SENTINEL);
}

function expectNothingRaw(answer: BoardSnapshotAnswer) {
  const shown = JSON.stringify(answer) + logged.join("\n");
  for (const secret of [SERVER_TEXT, TOKEN, REF, "acme.operations", BASE]) expect(shown).not.toContain(secret);
}

describe("the host-board switch and target", () => {
  it("is on only when set to true while InferOps is on", () => {
    expect(hostBoardsEnabled({})).toBe(false);
    expect(hostBoardsEnabled({ INFEROPS_HOST_BOARDS: "false" })).toBe(false);
    expect(hostBoardsEnabled({ INFEROPS_HOST_BOARDS: "yes" })).toBe(false);
    expect(hostBoardsEnabled({ INFEROPS_HOST_BOARDS: "true" })).toBe(true);
    expect(hostBoardsEnabled({ INFEROPS_HOST_BOARDS: "true", INFEROPS_ENABLED: "true" })).toBe(true);
    expect(hostBoardsEnabled({ INFEROPS_HOST_BOARDS: "true", INFEROPS_ENABLED: "false" })).toBe(false);
  });

  it("builds the canonical reference from a host and an uppercase key of at most ten", () => {
    expect(hostBoardRef("acme.operations", "ENG")).toBe(REF);
    expect(hostBoardRef("acme.operations", "A123456789")).toBe("inferops://acme.operations/project/board/A123456789");
    for (const key of ["", "eng", "Eng", "1ENG", "A1234567890", "EN-G", "ENG/1", "ENG?x=1"]) {
      expect(hostBoardRef("acme.operations", key), key).toBeNull();
    }
    for (const host of ["acme", "acme.ops.x", "Acme.ops", "acme.ops:1", "acme.ops/x", ""]) {
      expect(hostBoardRef(host, "ENG"), host).toBeNull();
    }
  });
});

describe("the board snapshot request", () => {
  it("is one principal-lane GET of the reference: the bearer, no workspace header, no redirect", async () => {
    const { calls, read } = fake(() => json(envelope()));
    const answer = await read();
    expect(answer).toEqual({
      kind: "ok",
      scope: { workspaceId: WORKSPACE, projectId: PROJECT },
      snapshot: {
        project: { identifier: "ENG", name: "Engineering" },
        columns: [{ label: "Ready", group: "unstarted", issues: [
          { identifier: "ENG-1", title: "Issue 1", priority: "urgent", targetDate: "2026-10-31", blocked: true },
        ] }],
      },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.init.method).toBe("GET");
    expect(call!.url.origin + call!.url.pathname).toBe(`${BASE}/project/board-snapshot`);
    expect([...call!.url.searchParams.keys()]).toEqual(["ref"]);
    expect(call!.url.searchParams.get("ref")).toBe(REF);
    expect(call!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call!.headers.has("x-workspace-id")).toBe(false);
    expect(call!.init.redirect).toBe("manual");
  });
});

describe("the strict envelope", () => {
  const text = (n: number) => "x".repeat(n);
  const issues = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1));

  // Each bound: a board exactly at it is accepted whole, and one over it is refused whole.
  const bounds: Array<[string, (over: boolean) => ReturnType<typeof envelope>]> = [
    ["columns", over => envelope({ columns: Array.from({ length: L.columns + (over ? 1 : 0) }, () => column([])) })],
    ["issues per column", over => envelope({ columns: [column(issues(L.issuesPerColumn + (over ? 1 : 0)))] })],
    ["issues", over => envelope({ columns: [column(issues(200)), column(issues(200)), column(issues(100 + (over ? 1 : 0)))] })],
    ["project identifier", over => envelope({ project: { identifier: text(L.projectIdentifier + (over ? 1 : 0)), name: "E" } })],
    ["project name", over => envelope({ project: { identifier: "ENG", name: text(L.projectName + (over ? 1 : 0)) } })],
    ["column label", over => envelope({ columns: [column([], { label: text(L.columnLabel + (over ? 1 : 0)) })] })],
    ["issue identifier", over => envelope({ columns: [column([issue(1, { identifier: text(L.issueIdentifier + (over ? 1 : 0)) })])] })],
    ["issue title", over => envelope({ columns: [column([issue(1, { title: text(L.issueTitle + (over ? 1 : 0)) })])] })],
  ];
  for (const [name, board] of bounds) {
    it(`accepts ${name} at the bound and refuses one over it`, async () => {
      expect((await fake(() => json(board(false))).read()).kind).toBe("ok");
      const over = await fake(() => json(board(true))).read();
      expect(over).toEqual({ kind: "refused", reason: "provider" });
      expectNothingRaw(over);
    });
  }

  it("measures strings in UTF-16 code units, as InferOps does", async () => {
    // 250 astral characters are 500 code units: at the title bound, though 1000 UTF-8 bytes.
    const astral = "\u{1F4CC}".repeat(250);
    expect((await fake(() => json(envelope({ columns: [column([issue(1, { title: astral })])] }))).read()).kind).toBe("ok");
    expect((await fake(() => json(envelope({ columns: [column([issue(1, { title: astral + "x" })])] }))).read()).kind)
      .toBe("refused");
  });

  it("refuses a field more or less, a wrong type, enum, date or id anywhere", async () => {
    const malformed: unknown[] = [
      { ...envelope(), extra: 1 },
      { scope: envelope().scope },
      envelope({ scope: { workspaceId: WORKSPACE } }),
      envelope({ scope: { workspaceId: WORKSPACE, projectId: PROJECT, tenantId: WORKSPACE } }),
      envelope({ scope: { workspaceId: "not-a-uuid", projectId: PROJECT } }),
      envelope({ snapshot: { projects: [] } }),
      envelope({ project: { identifier: "ENG", name: "E", id: PROJECT } }),
      envelope({ project: { identifier: "ENG" } }),
      envelope({ columns: [column([], { id: "x" })] }),
      envelope({ columns: [column([], { group: "doing" })] }),
      envelope({ columns: [{ label: "Ready", group: "started" }] }),
      envelope({ columns: [column([issue(1, { assigneeId: null })])] }),
      envelope({ columns: [column([issue(1, { blockedReason: "secret" })])] }),
      envelope({ columns: [column([issue(1, { priority: "p1" })])] }),
      envelope({ columns: [column([issue(1, { targetDate: "2026-10-31T00:00:00Z" })])] }),
      envelope({ columns: [column([issue(1, { blocked: "no" })])] }),
      envelope({ columns: [column([issue(1, { title: 7 })])] }),
      envelope({ columns: "none" as unknown as unknown[] }),
      [], null, "ok",
    ];
    for (const body of malformed) {
      const answer = await fake(() => json(body)).read();
      expect(answer, JSON.stringify(body).slice(0, 120)).toEqual({ kind: "refused", reason: "provider" });
    }
    expect(logged.join("\n")).not.toContain("secret");
  });

  it("refuses a body that is not JSON, and an error envelope sent with 200", async () => {
    expect(await fake(() => new Response("<html>")).read()).toEqual({ kind: "refused", reason: "provider" });
    const errorShaped = await fake(() => refusal(200, "NOT_FOUND")).read();
    expect(errorShaped).toEqual({ kind: "refused", reason: "provider" });
    expectNothingRaw(errorShaped);
  });
});

describe("capped reads", () => {
  it("accepts a success body of exactly 256 KiB and refuses one byte more", async () => {
    expect((await fake(() => new Response(padded(envelope(), L.bytes))).read()).kind).toBe("ok");
    expect(await fake(() => new Response(padded(envelope(), L.bytes + 1))).read())
      .toEqual({ kind: "refused", reason: "provider" });
  });

  it("abandons an endless success body at 256 KiB, before it is buffered whole or parsed", async () => {
    const { seen, response } = endless(200);
    const parse = vi.spyOn(JSON, "parse");
    expect(await fake(() => response).read()).toEqual({ kind: "refused", reason: "provider" });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulls).toBeLessThanOrEqual(L.bytes / 1024 + 2);
    expect(parse).not.toHaveBeenCalled();
  });

  it("reads an error envelope of exactly 4 KiB and refuses one byte more", async () => {
    const notFound = { error: { code: "NOT_FOUND", message: SERVER_TEXT } };
    expect(await fake(() => new Response(padded(notFound, L.errorBytes), { status: 404 })).read())
      .toEqual({ kind: "refused", reason: "not-found" });
    expect(await fake(() => new Response(padded(notFound, L.errorBytes + 1), { status: 404 })).read())
      .toEqual({ kind: "refused", reason: "provider" });
  });

  it("abandons an endless error body at 4 KiB, before it is buffered whole or parsed", async () => {
    for (const status of [404, 422, 500]) {
      const { seen, response } = endless(status);
      const parse = vi.spyOn(JSON, "parse");
      expect(await fake(() => response).read()).toEqual({ kind: "refused", reason: "provider" });
      expect(seen.cancelled).toBe(true);
      expect(seen.pulls).toBeLessThanOrEqual(L.errorBytes / 1024 + 2);
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
    }
  });

  it("refuses an advertised oversize body without reading it", async () => {
    const { seen, response } = endless(200);
    const advertised = new Response(response.body, { headers: { "content-length": String(L.bytes + 1) } });
    expect(await fake(() => advertised).read()).toEqual({ kind: "refused", reason: "provider" });
    expect(seen.cancelled).toBe(true);
  });
});

describe("refusals", () => {
  const cases: Array<[string, () => Response, BoardSnapshotAnswer]> = [
    ["404 NOT_FOUND", () => refusal(404, "NOT_FOUND"), { kind: "refused", reason: "not-found" }],
    ["404 without InferOps' envelope", () => new Response("Not Found", { status: 404 }), { kind: "refused", reason: "provider" }],
    ["422 SNAPSHOT_TOO_LARGE", () => refusal(422, "SNAPSHOT_TOO_LARGE"), { kind: "refused", reason: "too-large" }],
    ["422 with another code", () => refusal(422, "VALIDATION"), { kind: "refused", reason: "provider" }],
    ["403 FORBIDDEN", () => refusal(403, "FORBIDDEN"), { kind: "refused", reason: "forbidden" }],
    ["400 VALIDATION", () => refusal(400, "VALIDATION"), { kind: "refused", reason: "invalid-target" }],
    ["500", () => refusal(500, "INTERNAL"), { kind: "refused", reason: "provider" }],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }), { kind: "refused", reason: "provider" }],
    ["204", () => new Response(null, { status: 204 }), { kind: "refused", reason: "provider" }],
  ];
  for (const [name, answer, expected] of cases) {
    it(`reduces ${name} to a bounded reason, with nothing raw`, async () => {
      const result = await fake(answer).read();
      expect(result).toEqual(expected);
      expectNothingRaw(result);
    });
  }

  it("logs a provider-chosen error code as a fixed classification, never verbatim", async () => {
    const result = await fake(() => json({
      error: { code: SENTINEL, message: `${SENTINEL} message`, details: { [SENTINEL]: SENTINEL } },
    }, 404)).read();
    expect(result).toEqual({ kind: "refused", reason: "provider" });
    expectNoSentinel(result);
    expect(logged.join("\n")).toContain('"code":"other"');
    // Known codes keep their name; message and details never appear, whatever the status.
    for (const status of [400, 403, 404, 422, 500]) {
      const known = await fake(() => json({ error: { code: "VALIDATION", message: SENTINEL, details: { why: SENTINEL } } }, status)).read();
      expectNoSentinel(known);
    }
  });

  it("logs a malformed answer as a fixed classification, without the field, value or an error", async () => {
    const malformed: unknown[] = [
      { ...envelope(), [SENTINEL]: 1 },
      envelope({ columns: [column([issue(1, { priority: SENTINEL })])] }),
      envelope({ columns: [column([issue(1, { title: SENTINEL.repeat(40) })])] }),
      envelope({ columns: [column([], { group: SENTINEL })] }),
      envelope({ scope: { workspaceId: SENTINEL, projectId: PROJECT } }),
      envelope({ project: { identifier: SENTINEL.repeat(3), name: "E" } }),
    ];
    for (const body of malformed) {
      const result = await fake(() => json(body)).read();
      expect(result).toEqual({ kind: "refused", reason: "provider" });
      expectNoSentinel(result);
    }
    const lines = logged.join("\n");
    expect(lines).toContain('"code":"malformed"');
    expect(lines).not.toMatch(/stack|Malformed|is not valid|over its bound/);
  });

  it("throws UNAUTHORIZED for a 401, so the account can adjudicate the token", async () => {
    let caught: unknown;
    try {
      await fake(() => json({ error: { code: SENTINEL, message: SENTINEL } }, 401)).read();
    } catch (error) {
      caught = error;
    }
    expect(inferOpsErrorCode(caught)).toBe("UNAUTHORIZED");
    expect(String(caught)).not.toContain(SERVER_TEXT);
    expect(logged.join("\n")).not.toContain(TOKEN);
    expectNoSentinel(String(caught));
  });

  it("reports a network failure as the provider, without its cause", async () => {
    const result = await fake(() => { throw new TypeError(`fetch failed for ${BASE}/project/board-snapshot?ref=${REF}`); }).read();
    expect(result).toEqual({ kind: "refused", reason: "provider" });
    expectNothingRaw(result);
  });
});

// Release-graph node 10's browser flow, run by `scripts/ci/stage-smoke.ts` inside the
// artilleryio/artillery container (its bundled Playwright and Chromium; this checkout mounted
// read-only at its own path so `capnweb` resolves from it). Not meant to be run directly.
//
//   node scripts/ci/stage-smoke-flow.ts <evidence dir>
//
// Environment: FACTORY_STAGE_URL, GROKBOT_PERSONA_USER (operator persona), GROKBOT_VIEWER_USER
// (viewer persona), FACTORY_STAGE_BOARD (default the grokbot GROK board), and for a remote stage
// CF_ACCESS_CLIENT_ID/SECRET, sent as Access service-token headers. No value is written anywhere:
// the evidence names the personas by role.
//
// Oracles, each recorded in `<dir>/smoke.json` (the orchestrator gates on them):
//   operator.signIn        InferOS login -> "Continue with InferOps" -> the InferOps persona page
//                          -> back with an InferOS session and the InferOps account connected
//   operator.boardRenders  every card the gatekeeper reads is visible on a canvas bound to the board
//   operator.simulated     the proposed move shows on the board, and InferOps is unchanged before approval
//   operator.applied       after approval InferOps (its own API, as the operator) has the new state
//                          and a higher revision
//   operator.restored      the issue is moved back the same way (simulate -> approve), so a smoke
//                          leaves the stage's board as it found it
//   viewer.refused         the viewer's proposal is refused (at proposal, or when its approval is
//                          applied), and InferOps' issue state and revision are unchanged
// The move is proposed through the gatekeeper's issue session (the API the board widget calls),
// and approved by clicking Approve in the workspace's Activity panel.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_BOARD = "inferops://grokbot.operations/project/board/GROK";

/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright and the Workshop RPC are loaded at runtime, untyped here. */
type Any = any;

/** One oracle's outcome. */
interface Oracle { name: string; ok: boolean; detail: string }

/** A board as the gatekeeper reads it (the fields the smoke uses). */
interface Board {
  project: { identifier: string };
  columns: { state: { id: string; name: string; group: string; workflow: string }; issues: { id: string; identifier: string; revision: string; stateId: string }[] }[];
}

/** The InferOps issue fields the oracles compare. */
interface IssueState { stateId: string; revision: string }

const env = process.env;
const stage = new URL(env.FACTORY_STAGE_URL ?? "");
const boardUrl = env.FACTORY_STAGE_BOARD ?? DEFAULT_BOARD;
const out = resolve(process.argv[2] ?? ".");
mkdirSync(out, { recursive: true });
const oracles: Oracle[] = [];
const notes: Record<string, unknown> = {};
const record = (name: string, ok: boolean, detail: string) => {
  oracles.push({ name, ok, detail });
  console.log(`[stage-smoke] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  return ok;
};

/** Access service-token headers for a stage behind Cloudflare Access; nothing for loopback. */
function accessHeaders(): Record<string, string> {
  return env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
    ? { "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET }
    : {};
}

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as Any;
const capnweb = await import(pathToFileURL(createRequire(join(ROOT, "packages", "workshop-backend", "package.json")).resolve("capnweb")).href) as Any;

/** An RPC session on the stage's Workshop `/api`, the one the browser uses. */
function connectWorkshop(): { api: Any; close(): void } {
  const wsUrl = new URL("/api", stage);
  wsUrl.protocol = stage.protocol === "https:" ? "wss:" : "ws:";
  // Node's WebSocket (undici) takes headers, which is how the Access token reaches a remote stage.
  const socket = new (WebSocket as Any)(wsUrl.toString(), { headers: accessHeaders() });
  const api = capnweb.newWebSocketRpcSession(socket);
  const timer = setTimeout(() => socket.close(), 120_000);
  return { api, close() { clearTimeout(timer); api[Symbol.dispose](); socket.close(); } };
}

/** The user's connected InferOps account, read by driving `subscribeConnectedAccounts` to `ready()`. */
async function inferopsAccount(user: Any): Promise<{ id: number; displayName?: string } | null> {
  const accounts: { id: number; vendorId: string; displayName?: string }[] = [];
  const ready = Promise.withResolvers<void>();
  class Subscriber extends capnweb.RpcTarget {
    add(id: number, description: { displayName?: string }, _v: unknown, _r: unknown, _c: unknown, vendorId: string) {
      accounts.push({ id, vendorId, displayName: description.displayName });
    }
    remove(id: number) { const at = accounts.findIndex(a => a.id === id); if (at >= 0) accounts.splice(at, 1); }
    ready() { ready.resolve(); }
  }
  const subscriber = new capnweb.RpcStub(new Subscriber());
  const subscription = await user.subscribeConnectedAccounts(subscriber);
  await ready.promise;
  subscription[Symbol.dispose]();
  subscriber[Symbol.dispose]();
  return accounts.find(account => account.vendorId === "inferops") ?? null;
}

/** Sign in through the stage's own login page as `persona`; returns the page, session and InferOps origin. */
async function signIn(browser: Any, role: string, persona: string): Promise<{ context: Any; page: Any; token: string; inferops: string }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: accessHeaders() });
  const page = await context.newPage();
  await page.goto(new URL("/", stage).toString());
  await page.getByRole("button", { name: /Continue with InferOps/ }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(out, `${role}-01-inferos-login.png`) });
  const popupPromise = context.waitForEvent("page", { timeout: 30_000 });
  await page.getByRole("button", { name: /Continue with InferOps/ }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/authorize/, { timeout: 30_000 });
  const inferops = new URL(popup.url()).origin;
  const choice = popup.getByRole("button", { name: new RegExp(`\\b${persona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) });
  await choice.waitFor({ timeout: 30_000 });
  await popup.screenshot({ path: join(out, `${role}-02-inferops-persona-page.png`) });
  await choice.click();
  await page.waitForFunction(() => Boolean(localStorage.getItem("authToken")), null, { timeout: 60_000 });
  await page.waitForLoadState();
  const token = await page.evaluate(() => localStorage.getItem("authToken")) as string;
  await page.screenshot({ path: join(out, `${role}-03-signed-in.png`) });
  return { context, page, token, inferops };
}

/**
 * Connect (or, when an account exists, reconnect) the person's InferOps account the way the
 * Workshop's connect buttons do: the flow from `connectAccount`/`reconnectAccount`, opened as a
 * disowned popup carrying its nonce (`openDisownedPopup` in connectHandoff.ts), through the InferOps
 * persona page when it asks, to the Workshop's /connect/handoff page, which redeems it.
 */
async function connectInferOps(context: Any, page: Any, user: Any, role: string, persona: string): Promise<{ id: number; displayName?: string } | null> {
  const existing = await inferopsAccount(user);
  const flow = existing ? await user.reconnectAccount(existing.id) : await user.connectAccount("inferops");
  const popupPromise = context.waitForEvent("page", { timeout: 30_000 });
  await page.evaluate(({ url, nonce }: { url: string; nonce: string }) => {
    const popup = (globalThis as Any).window.open("", `stage-smoke-connect-${crypto.randomUUID()}`, "popup,width=520,height=680");
    if (!popup) throw new Error("popup blocked");
    popup.opener = null;
    popup.sessionStorage.setItem("gadgets.handoff", JSON.stringify({ kind: "connect", nonce }));
    popup.location.replace(url);
  }, { url: flow.url, nonce: flow.nonce });
  const popup = await popupPromise;
  const choice = popup.getByRole("button", { name: new RegExp(`\\b${persona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) });
  const deadline = Date.now() + 60_000;
  let clicked = false;
  while (!popup.isClosed() && Date.now() < deadline) {
    if (/\/connect\/handoff/.test(popup.url())) break;
    if (!clicked && await choice.isVisible().catch(() => false)) {
      await popup.screenshot({ path: join(out, `${role}-03b-connect-persona.png`) }).catch(() => undefined);
      await choice.click().catch(() => undefined);
      clicked = true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  notes[`${role}Connect`] = { flow: existing ? "reconnect" : "connect", personaPageShown: clicked };
  return until(() => inferopsAccount(user), account => account !== null, 30_000);
}

/** InferOps' own API as a persona (stub-mode persona login, bearer transport). */
async function inferopsApi(origin: string, persona: string): Promise<{ issue(id: string): Promise<IssueState> } | string> {
  const config = await (await fetch(`${origin}/auth/public-config`)).json() as { mode?: string };
  if (config.mode !== "stub") return `InferOps auth mode is ${config.mode}; its API is read here only through stub persona login`;
  const login = await fetch(`${origin}/auth/inferlab-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: persona, product: "inferops", transport: "bearer" }),
  });
  if (!login.ok) return `persona login answered ${login.status}`;
  const session = await login.json() as { token: string; user: { workspaces: { workspaceId: string; product: string }[] } };
  const workspaces = session.user.workspaces.filter(w => w.product === "inferops").map(w => w.workspaceId);
  return {
    async issue(id) {
      for (const workspaceId of workspaces) {
        const response = await fetch(`${origin}/project/issues/${id}`, { headers: { authorization: `Bearer ${session.token}`, "x-workspace-id": workspaceId, accept: "application/json" } });
        if (response.ok) {
          const { issue } = await response.json() as { issue: IssueState };
          return { stateId: issue.stateId, revision: issue.revision };
        }
      }
      throw new Error(`InferOps answered no workspace of the persona for issue ${id}`);
    },
  };
}

/** The first issue with a next, not-cancelled state in its own workflow. */
function proposableMove(board: Board): { issueId: string; identifier: string; from: string; to: string; toName: string; fromName: string } | null {
  for (const [index, column] of board.columns.entries()) {
    const next = board.columns.slice(index + 1).find(c => c.state.workflow === column.state.workflow && c.state.group !== "cancelled" && c.state.group !== "completed");
    const issue = column.issues[0];
    if (next && issue) return { issueId: issue.id, identifier: issue.identifier, from: column.state.id, fromName: column.state.name, to: next.state.id, toName: next.state.name };
  }
  return null;
}

const columnOf = (board: Board, issueId: string) => board.columns.find(c => c.issues.some(i => i.id === issueId))?.state.id;
const revisionOf = (board: Board, issueId: string) => board.columns.flatMap(c => c.issues).find(i => i.id === issueId)?.revision;

/** The workspace titled `title`, created when absent (kept by a chat, like `pnpm local seed`). */
async function ensureWorkspace(user: Any, title: string): Promise<Any> {
  const existing = (await user.listGadgets()).find((w: { title: string }) => w.title === title);
  if (existing) return user.openGadget(existing.id);
  const overseer = user.newGadget();
  await overseer.setTitle(title);
  await overseer.newChat("Workspace prepared by the factory stage smoke.", null);
  return overseer;
}

/** A workspace bound to the board: its connection, an open session and a canvas showing it. */
async function bindBoard(user: Any, accountId: number, title: string): Promise<{ overseer: Any; workspaceId: string; connectionId: number; session: Any; screenId: string }> {
  const overseer = await ensureWorkspace(user, title);
  const workspaceId = (await overseer.getMetadata()).id as string;
  const connection = await overseer.getGatekeeperByResourceUrl(boardUrl) ?? await overseer.newGatekeeper(accountId, boardUrl);
  if (!connection) throw new Error(`the InferOps account cannot open ${boardUrl}`);
  const connectionId = await connection.getId() as number;
  // A request an earlier, interrupted smoke left waiting would make this run's move a CONFLICT.
  for (let stale = await pendingFor(overseer, connectionId); stale; stale = await pendingFor(overseer, connectionId)) {
    await overseer.rejectAction(stale.id);
  }
  const session = await connection.openSession();
  const screenTitle = "Stage smoke board";
  const screens = await overseer.listCanvases() as { id: string; title: string }[];
  const screen = screens.find(s => s.title === screenTitle) ?? await overseer.createCanvas({
    title: screenTitle,
    sections: [{ id: "main", title: screenTitle, columns: 2, widgets: [{ id: "board", kind: "inferops.project-board", version: 1, targetRef: boardUrl, size: "full", params: { workflow: "software", showCompleted: true } }] }],
  });
  return { overseer, workspaceId, connectionId, session, screenId: screen.id };
}

/** The pending action this connection just queued. */
async function pendingFor(overseer: Any, connectionId: number): Promise<{ id: number } | undefined> {
  const page = await overseer.listActions({ filter: "pending" }) as { entries: { id: number; gatekeeperId?: number; type: string }[] };
  return page.entries.find(entry => entry.type === "action" && entry.gatekeeperId === connectionId);
}

/** An action's state, found in the workspace's history. */
async function actionState(overseer: Any, id: number): Promise<{ state?: string; lastAttempt?: { message?: string; code?: string } }> {
  let beforeId: number | undefined;
  for (let page = 0; page < 10; page++) {
    const { entries, nextBeforeId } = await overseer.listActions({ beforeId, filter: "action" }) as { entries: { id: number; state?: string; lastAttempt?: { message?: string; code?: string } }[]; nextBeforeId?: number };
    const found = entries.find(entry => entry.id === id);
    if (found) return { state: found.state, lastAttempt: found.lastAttempt && { message: found.lastAttempt.message, code: found.lastAttempt.code } };
    if (nextBeforeId === undefined) break;
    beforeId = nextBeforeId;
  }
  return {};
}

/** Approve the one waiting request in the workspace's Activity panel, as a person would. */
async function approveInBrowser(page: Any, workspaceId: string, shot: string): Promise<void> {
  await page.goto(new URL(`/workspace/${workspaceId}`, stage).toString());
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  try {
    // The top bar's Activity button ("Activity — 1 request needs review") opens the review panel.
    await page.getByRole("button", { name: /^Activity — \d+ requests? needs? review/ }).click({ timeout: 30_000 });
    await approve.waitFor({ timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: join(out, shot.replace(/\.png$/, "-failed.png")) });
    throw error;
  }
  await page.waitForTimeout(500); // the review popover fades in
  await page.screenshot({ path: join(out, shot) });
  await approve.click();
}

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000): Promise<T> => {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    value = await read();
  }
  return value;
};

async function operatorFlow(browser: Any): Promise<void> {
  const persona = env.GROKBOT_PERSONA_USER!;
  const { context, page, token, inferops } = await signIn(browser, "operator", persona);
  notes.inferopsOrigin = inferops;
  const { api, close } = connectWorkshop();
  try {
    const config = await api.getServerConfig() as { canvasFeatures?: { composableViews?: boolean; durableViews?: boolean } };
    if (!config.canvasFeatures?.durableViews) {
      record("operator.boardRenders", false, "the stage has no saved canvases (composable + durable views off: no inferos.canvas.json)");
      return;
    }
    const user = await api.authenticate(token);
    // A first sign-in lands on the onboarding wizard; the smoke is not testing it.
    if (!await user.isOnboardingCompleted()) await user.completeOnboarding();
    const account = await connectInferOps(context, page, user, "operator", persona);
    if (!record("operator.signIn", Boolean(token && account), account ? `InferOS session, InferOps account connected (${account.displayName ?? "account"})` : "signed in, but no InferOps account is connected")) return;
    const bound = await bindBoard(user, account!.id, "Stage smoke (operator)");
    const board = await bound.session.readBoard() as Board;
    const identifiers = board.columns.flatMap(c => c.issues.map(i => i.identifier));
    await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
    let missing = identifiers;
    for (let attempt = 0; attempt < 30 && missing.length; attempt++) {
      const text = await page.locator("body").innerText();
      missing = identifiers.filter(id => !text.includes(id));
      if (missing.length) await page.waitForTimeout(1_000);
    }
    await page.screenshot({ path: join(out, "operator-04-board.png") });
    notes.board = { project: board.project.identifier, columns: board.columns.length, issues: identifiers.length };
    if (!record("operator.boardRenders", identifiers.length > 0 && missing.length === 0,
      missing.length ? `missing on the canvas: ${missing.join(", ")}` : `${identifiers.length} cards of ${board.project.identifier} rendered on the canvas (${identifiers.join(", ")})`)) return;

    const api2 = await inferopsApi(inferops, persona);
    if (typeof api2 === "string") { record("operator.applied", false, api2); return; }
    const move = proposableMove(board);
    if (!move) { record("operator.simulated", false, "no issue on the board has a next state to move to"); return; }
    notes.move = { issue: move.identifier, from: move.fromName, to: move.toName };

    for (const [step, from, to, toName] of [["apply", move.from, move.to, move.toName], ["restore", move.to, move.from, move.fromName]] as const) {
      const before = await api2.issue(move.issueId);
      if (before.stateId !== from) { record(step === "apply" ? "operator.simulated" : "operator.restored", false, `${move.identifier} is not in the expected state in InferOps`); return; }
      const issue = await bound.session.openIssue(move.issueId);
      await issue.transition(to, before.revision);
      const simulated = await bound.session.readBoard() as Board;
      const stillBefore = await api2.issue(move.issueId);
      const pending = await pendingFor(bound.overseer, bound.connectionId);
      if (step === "apply") {
        await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
        await page.getByText(/pending approval|Awaiting approval/).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await page.screenshot({ path: join(out, "operator-05-move-proposed.png") });
        if (!record("operator.simulated", columnOf(simulated, move.issueId) === to && stillBefore.stateId === from && stillBefore.revision === before.revision && pending !== undefined,
          `board shows ${move.identifier} in ${toName} (simulated), InferOps still at state ${from === stillBefore.stateId ? "unchanged" : "CHANGED"} revision ${stillBefore.revision}; pending action ${pending?.id ?? "none"}`)) return;
      } else if (!pending) {
        record("operator.restored", false, "the move back queued no action"); return;
      }
      await approveInBrowser(page, bound.workspaceId, `operator-0${step === "apply" ? 6 : 8}-approve-${step}.png`);
      const after = await until(() => api2.issue(move.issueId), value => value.stateId === to);
      const applied = after.stateId === to && BigInt(after.revision) > BigInt(before.revision);
      const fresh = await bound.session.readBoard() as Board;
      if (step === "apply") {
        notes.applied = { revisionBefore: before.revision, revisionAfter: after.revision, boardRevision: revisionOf(fresh, move.issueId) };
        await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
        await page.getByText(move.identifier).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await page.screenshot({ path: join(out, "operator-07-after-approve.png") });
        if (!record("operator.applied", applied, `InferOps API: ${move.identifier} ${after.stateId === to ? `now in ${toName}` : "NOT moved"}, revision ${before.revision} -> ${after.revision}`)) return;
      } else {
        notes.restored = { revisionBefore: before.revision, revisionAfter: after.revision };
        record("operator.restored", applied, `InferOps API: ${move.identifier} ${after.stateId === to ? `back in ${toName}` : "NOT moved back"}, revision ${before.revision} -> ${after.revision}`);
      }
    }
  } finally {
    close();
  }
}

async function viewerFlow(browser: Any): Promise<void> {
  const persona = env.GROKBOT_VIEWER_USER!;
  const { context, page, token, inferops } = await signIn(browser, "viewer", persona);
  const { api, close } = connectWorkshop();
  try {
    const user = await api.authenticate(token);
    // A first sign-in lands on the onboarding wizard; the smoke is not testing it.
    if (!await user.isOnboardingCompleted()) await user.completeOnboarding();
    const account = await connectInferOps(context, page, user, "viewer", persona);
    if (!account) { record("viewer.refused", false, "the viewer has no InferOps account connected, so no refusal was exercised"); return; }
    // The oracle reads InferOps as the operator: the viewer's own read would not show a write it could not see.
    const operatorApi = await inferopsApi(inferops, env.GROKBOT_PERSONA_USER!);
    if (typeof operatorApi === "string") { record("viewer.refused", false, operatorApi); return; }
    const bound = await bindBoard(user, account.id, "Stage smoke (viewer)");
    const board = await bound.session.readBoard() as Board;
    const move = proposableMove(board);
    if (!move) { record("viewer.refused", false, "no issue on the board has a next state to move to"); return; }
    const before = await operatorApi.issue(move.issueId);
    let refusal: string | null = null;
    try {
      const issue = await bound.session.openIssue(move.issueId);
      await issue.transition(move.to, before.revision);
    } catch (error) {
      const message = (error as Error).message;
      // A conflict or stale revision is the smoke's own state, not the viewer being refused.
      if (/CONFLICT|STALE_REVISION/.test(message)) throw error;
      refusal = `proposal refused: ${message}`;
    }
    if (!refusal) {
      const pending = await pendingFor(bound.overseer, bound.connectionId);
      if (pending) {
        await approveInBrowser(page, bound.workspaceId, "viewer-04-approve-attempt.png");
        // A refused apply leaves the request pending with the provider's answer as its last attempt.
        const outcome = await until(() => actionState(bound.overseer, pending.id),
          value => (value.state !== undefined && value.state !== "pending") || value.lastAttempt !== undefined, 30_000);
        if (outcome.state === "pending") await bound.overseer.rejectAction(pending.id);
        const refused = outcome.state === "failed" || (outcome.state !== "approved" && outcome.lastAttempt !== undefined);
        refusal = refused ? `approved in the browser, InferOps refused the apply (${outcome.lastAttempt?.code ?? outcome.state}: ${outcome.lastAttempt?.message ?? "no message"}); request ${outcome.state === "pending" ? "then rejected" : outcome.state}` : null;
      } else {
        refusal = null;
      }
    }
    const after = await operatorApi.issue(move.issueId);
    await page.screenshot({ path: join(out, "viewer-05-after.png") });
    const unchanged = after.stateId === before.stateId && after.revision === before.revision;
    record("viewer.refused", refusal !== null && unchanged,
      `${refusal ?? "NOT refused"}; InferOps ${move.identifier} ${unchanged ? `unchanged (revision ${after.revision})` : `CHANGED (revision ${before.revision} -> ${after.revision})`}`);
  } finally {
    close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [name, flow] of [["operator", operatorFlow], ["viewer", viewerFlow]] as const) {
    try {
      await flow(browser);
    } catch (error) {
      record(`${name}.error`, false, (error as Error).message.split("\n")[0]!);
    }
  }
} finally {
  await browser.close();
}
const expected = ["operator.signIn", "operator.boardRenders", "operator.simulated", "operator.applied", "operator.restored", "viewer.refused"];
for (const name of expected) if (!oracles.some(o => o.name === name)) oracles.push({ name, ok: false, detail: "not reached" });
const ok = oracles.every(o => o.ok);
writeFileSync(join(out, "smoke.json"), JSON.stringify({ ok, stage: stage.origin, board: boardUrl, oracles, notes }, null, 2) + "\n");
process.exitCode = ok ? 0 : 1;

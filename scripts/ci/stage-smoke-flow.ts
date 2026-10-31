// Release-graph node 10's browser flow, run by `scripts/ci/stage-smoke.ts` inside the
// artilleryio/artillery container (its bundled Playwright and Chromium; this checkout mounted
// read-only at its own path so `capnweb` resolves from it). Not meant to be run directly.
//
//   node scripts/ci/stage-smoke-flow.ts <evidence dir>
//
// Environment: FACTORY_STAGE_URL, FACTORY_INFEROPS_URL (the InferOps API the oracles read; else the
// sign-in popup's origin), GROKBOT_PERSONA_USER (owner persona), GROKBOT_OPERATE_USER
// (operations member / knowledge viewer persona), FACTORY_STAGE_BOARD (default the grokbot GROK board), FACTORY_STAGE_WIKI
// (default the grokbot tenant's InferMind Wiki, `grokbot.knowledge`), and for a stage behind Access
// (remote, or emulated locally) CF_ACCESS_CLIENT_ID/SECRET, sent as Access service-token headers on
// the browser's requests to the stage origin only (never to InferOps), and on the Workshop RPC
// socket. The browser's own `/api` WebSocket carries the `CF_Authorization` cookie Access sets on the
// first authorised response. No value is written anywhere: the evidence names the personas by role.
//
// Oracles, each recorded in `<dir>/smoke.json` (the orchestrator gates on them):
//   owner.signIn        InferOS login -> "Continue with InferOps" -> the InferOps persona page
//                          -> back with an InferOS session and the InferOps account connected
//   owner.boardRenders  every card the gatekeeper reads is visible on a canvas bound to the board
//   owner.simulated     the proposed move shows on the board, and InferOps is unchanged before approval
//   owner.applied       after approval InferOps (its own API, as the owner) has the new state
//                          and a higher revision
//   owner.restored      the issue is moved back the same way (simulate -> approve), so a smoke
//                          leaves the stage's board as it found it
//   operate.signIn         the operate persona signs in and connects its own InferOps account
//   operate.knowledgeWriteRefused  a Wiki body write is refused FORBIDDEN at proposal or apply,
//                          and the owner's document content and version are unchanged
//   owner.wikiReads,    the Wiki's first page, read through the person's own Wiki connection, is
//   operate.wikiReads       the page InferOps' knowledge API answers that persona, and its title and
//                          first lines render on a canvas holding the `inferops.wiki` widget (a
//                          read: the operate persona's knowledge viewer role allows it)
// The move is proposed through the gatekeeper's issue session (the API the board widget calls),
// and approved by clicking Approve in the workspace's Activity panel.

import { checkKnowledgeWrite, smokeOraclesPass, smokePersonaProblem, STAGE_SMOKE_ORACLES, type KnowledgeWriteOutcome, type WikiSnapshot } from "./stage-smoke-authorization.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_WIKI, missingWikiText, wikiDisagreement, wikiExpectedText, type WikiPageText } from "./stage-smoke-wiki.ts";

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
const personaProblem = smokePersonaProblem(env);
if (personaProblem) throw new Error(personaProblem);
const stage = new URL(env.FACTORY_STAGE_URL ?? "");
const boardUrl = env.FACTORY_STAGE_BOARD ?? DEFAULT_BOARD;
const wikiUrl = env.FACTORY_STAGE_WIKI ?? DEFAULT_WIKI;
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const access = accessHeaders();
  if (Object.keys(access).length) {
    // Playwright's extraHTTPHeaders, scoped to the stage: InferOps (another origin) never sees the token.
    await context.route((url: URL) => url.origin === stage.origin,
      (route: Any) => route.continue({ headers: { ...route.request().headers(), ...access } }));
  }
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

/**
 * InferOps' own API as a persona (stub-mode persona login, bearer transport), at
 * `FACTORY_INFEROPS_URL` (the stage's InferOps API, resolved by stage-smoke.ts) or else `popupOrigin`,
 * the InferLab the sign-in popup opened. Against a non-stub InferLab there is no persona token, so
 * the oracle using it FAILs with that reason, never passes.
 */
async function inferopsApi(popupOrigin: string, persona: string): Promise<{ issue(id: string): Promise<IssueState>; wikiPage(slug: string): Promise<WikiSnapshot | null> } | string> {
  const origin = env.FACTORY_INFEROPS_URL ? new URL(env.FACTORY_INFEROPS_URL).origin : popupOrigin;
  const config = await (await fetch(`${origin}/auth/public-config`)).json() as { mode?: string };
  if (config.mode !== "stub") return `InferOps (${origin}) auth mode is ${config.mode}; its API is read here only through stub persona login, so this oracle is unproven`;
  const login = await fetch(`${origin}/auth/inferlab-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: persona, product: "inferops", transport: "bearer" }),
  });
  if (!login.ok) return `persona login answered ${login.status}`;
  const session = await login.json() as { token: string; user: { workspaces: { workspaceId: string; product: string }[] } };
  const workspaces = session.user.workspaces.filter(w => w.product === "inferops").map(w => w.workspaceId);
  const knowledge = session.user.workspaces.filter(w => w.product === "infermind").map(w => w.workspaceId);
  const read = async (workspaceId: string, path: string): Promise<unknown> => {
    const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${session.token}`, "x-workspace-id": workspaceId, accept: "application/json" } });
    if (!response.ok) throw new Error(`InferOps answered ${response.status} for ${path.split("?")[0]}`);
    return response.json();
  };
  return {
    // A Wiki page as InferOps' knowledge API answers this persona, from its InferMind workspaces.
    async wikiPage(slug) {
      for (const workspaceId of knowledge) {
        const documents = await read(workspaceId, "/knowledge/documents") as { id: string; slug: string }[];
        const listed = documents.find(d => d.slug === slug);
        if (!listed) continue;
        const document = await read(workspaceId, `/knowledge/documents/${listed.id}`) as { id: string; version: number; slug: string; title: string; body?: string | null };
        const sections = await read(workspaceId, `/knowledge/sections?documentId=${listed.id}`) as { body: string }[];
        return { id: document.id, version: document.version, slug: document.slug, title: document.title, body: document.body ?? "", sections: sections.map(s => s.body) };
      }
      return null;
    },
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
async function actionState(overseer: Any, id: number): Promise<KnowledgeWriteOutcome> {
  let beforeId: number | undefined;
  for (let page = 0; page < 10; page++) {
    const { entries, nextBeforeId } = await overseer.listActions({ beforeId, filter: "action" }) as { entries: { id: number; state?: string; lastAttempt?: { message?: string; code?: string; outcome?: string } }[]; nextBeforeId?: number };
    const found = entries.find(entry => entry.id === id);
    if (found) return { state: found.state, lastAttempt: found.lastAttempt && { code: found.lastAttempt.code, outcome: found.lastAttempt.outcome } };
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

/**
 * `<role>.wikiReads`: the person's own connection to the Wiki (made from their InferOps account when
 * the workspace holds none) lists its pages; the first is read through the gatekeeper and through
 * InferOps' knowledge API as the same persona, which must agree, and a saved canvas holding the
 * `inferops.wiki` widget opened on that page must show its title and first lines.
 */
async function wikiReads(role: "owner" | "operate", page: Any, user: Any, accountId: number, persona: string, inferops: string): Promise<void> {
  const name = `${role}.wikiReads`;
  const api = await inferopsApi(inferops, persona);
  if (typeof api === "string") { record(name, false, api); return; }
  const overseer = await ensureWorkspace(user, `Stage smoke (${role})`);
  const workspaceId = (await overseer.getMetadata()).id as string;
  const connection = await overseer.getGatekeeperByResourceUrl(wikiUrl) ?? await overseer.newGatekeeper(accountId, wikiUrl);
  if (!connection) { record(name, false, `the InferOps account cannot open ${wikiUrl}`); return; }
  const session = await connection.openSession();
  const documents = await session.listDocuments() as { slug: string; parentId: string | null }[];
  const first = documents.find(d => d.parentId === null) ?? documents[0];
  if (!first) { record(name, false, `${wikiUrl} lists no page the ${role} can open (seed one: factory-sandboxes skill)`); return; }
  const read = await session.readDocument(first.slug) as { slug: string; title: string; body: string; sections: { body: string }[] };
  const gatekeeper: WikiPageText = { slug: read.slug, title: read.title, body: read.body, sections: read.sections.map(s => s.body) };
  const inferopsPage = await api.wikiPage(first.slug);
  if (!inferopsPage) { record(name, false, `InferOps' knowledge API answers the ${role} no page ${first.slug}`); return; }
  const disagreement = wikiDisagreement(gatekeeper, inferopsPage);
  if (disagreement) { record(name, false, `the gatekeeper's ${first.slug} is not InferOps' (${disagreement})`); return; }
  const expected = wikiExpectedText(inferopsPage);
  const screenTitle = `Stage smoke wiki (${first.slug})`;
  const screens = await overseer.listCanvases() as { id: string; title: string }[];
  const screen = screens.find(s => s.title === screenTitle) ?? await overseer.createCanvas({
    title: screenTitle,
    sections: [{ id: "main", title: screenTitle, columns: 2, widgets: [{ id: "wiki", kind: "inferops.wiki", version: 1, targetRef: wikiUrl, size: "full", params: { page: first.slug } }] }],
  });
  await page.goto(new URL(`/workspace/${workspaceId}/inferops-canvas?view=${screen.id}`, stage).toString());
  const widget = page.getByRole("article", { name: `InferMind Wiki ${wikiUrl}` });
  let missing = expected;
  for (let attempt = 0; attempt < 30 && missing.length; attempt++) {
    missing = missingWikiText(await widget.innerText({ timeout: 30_000 }).catch(() => ""), expected);
    if (missing.length) await page.waitForTimeout(1_000);
  }
  await page.screenshot({ path: join(out, `${role}-09-wiki.png`) });
  notes[`${role}Wiki`] = { wiki: wikiUrl, page: first.slug, pages: documents.length, sections: inferopsPage.sections.length, phrases: expected.length };
  record(name, missing.length === 0, missing.length
    ? `missing on the canvas: ${missing.map(m => JSON.stringify(m)).join(", ")}`
    : `${first.slug} ("${inferopsPage.title}") read through the ${role}'s Wiki connection matches InferOps' knowledge API, and its ${expected.length} phrases rendered on the canvas`);
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

async function ownerFlow(browser: Any): Promise<void> {
  const persona = env.GROKBOT_PERSONA_USER!;
  const { context, page, token, inferops } = await signIn(browser, "owner", persona);
  notes.inferopsOrigin = inferops;
  notes.inferopsApi = env.FACTORY_INFEROPS_URL ? new URL(env.FACTORY_INFEROPS_URL).origin : inferops;
  const { api, close } = connectWorkshop();
  try {
    const config = await api.getServerConfig() as { canvasFeatures?: { composableViews?: boolean; durableViews?: boolean } };
    if (!config.canvasFeatures?.durableViews) {
      record("owner.boardRenders", false, "the stage has no saved canvases (composable + durable views off: no inferos.canvas.json)");
      return;
    }
    const user = await api.authenticate(token);
    // A first sign-in lands on the onboarding wizard; the smoke is not testing it.
    if (!await user.isOnboardingCompleted()) await user.completeOnboarding();
    const account = await connectInferOps(context, page, user, "owner", persona);
    if (!record("owner.signIn", Boolean(token && account), account ? `InferOS session, InferOps account connected (${account.displayName ?? "account"})` : "signed in, but no InferOps account is connected")) return;
    // The Wiki read is independent of the board flow, so a board failure does not hide it.
    await wikiReads("owner", page, user, account!.id, persona, inferops).catch((error: Error) => record("owner.wikiReads", false, error.message.split("\n")[0]!));
    const bound = await bindBoard(user, account!.id, "Stage smoke (owner)");
    const board = await bound.session.readBoard() as Board;
    const identifiers = board.columns.flatMap(c => c.issues.map(i => i.identifier));
    await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
    let missing = identifiers;
    for (let attempt = 0; attempt < 30 && missing.length; attempt++) {
      const text = await page.locator("body").innerText();
      missing = identifiers.filter(id => !text.includes(id));
      if (missing.length) await page.waitForTimeout(1_000);
    }
    await page.screenshot({ path: join(out, "owner-04-board.png") });
    notes.board = { project: board.project.identifier, columns: board.columns.length, issues: identifiers.length };
    if (!record("owner.boardRenders", identifiers.length > 0 && missing.length === 0,
      missing.length ? `missing on the canvas: ${missing.join(", ")}` : `${identifiers.length} cards of ${board.project.identifier} rendered on the canvas (${identifiers.join(", ")})`)) return;

    const api2 = await inferopsApi(inferops, persona);
    if (typeof api2 === "string") { record("owner.applied", false, api2); return; }
    const move = proposableMove(board);
    if (!move) { record("owner.simulated", false, "no issue on the board has a next state to move to"); return; }
    notes.move = { issue: move.identifier, from: move.fromName, to: move.toName };

    for (const [step, from, to, toName] of [["apply", move.from, move.to, move.toName], ["restore", move.to, move.from, move.fromName]] as const) {
      const before = await api2.issue(move.issueId);
      if (before.stateId !== from) { record(step === "apply" ? "owner.simulated" : "owner.restored", false, `${move.identifier} is not in the expected state in InferOps`); return; }
      const issue = await bound.session.openIssue(move.issueId);
      await issue.transition(to, before.revision);
      const simulated = await bound.session.readBoard() as Board;
      const stillBefore = await api2.issue(move.issueId);
      const pending = await pendingFor(bound.overseer, bound.connectionId);
      if (step === "apply") {
        await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
        await page.getByText(/pending approval|Awaiting approval/).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await page.screenshot({ path: join(out, "owner-05-move-proposed.png") });
        if (!record("owner.simulated", columnOf(simulated, move.issueId) === to && stillBefore.stateId === from && stillBefore.revision === before.revision && pending !== undefined,
          `board shows ${move.identifier} in ${toName} (simulated), InferOps still at state ${from === stillBefore.stateId ? "unchanged" : "CHANGED"} revision ${stillBefore.revision}; pending action ${pending?.id ?? "none"}`)) return;
      } else if (!pending) {
        record("owner.restored", false, "the move back queued no action"); return;
      }
      await approveInBrowser(page, bound.workspaceId, `owner-0${step === "apply" ? 6 : 8}-approve-${step}.png`);
      const after = await until(() => api2.issue(move.issueId), value => value.stateId === to);
      const applied = after.stateId === to && BigInt(after.revision) > BigInt(before.revision);
      const fresh = await bound.session.readBoard() as Board;
      if (step === "apply") {
        notes.applied = { revisionBefore: before.revision, revisionAfter: after.revision, boardRevision: revisionOf(fresh, move.issueId) };
        await page.goto(new URL(`/workspace/${bound.workspaceId}/inferops-canvas?view=${bound.screenId}`, stage).toString());
        await page.getByText(move.identifier).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await page.screenshot({ path: join(out, "owner-07-after-approve.png") });
        if (!record("owner.applied", applied, `InferOps API: ${move.identifier} ${after.stateId === to ? `now in ${toName}` : "NOT moved"}, revision ${before.revision} -> ${after.revision}`)) return;
      } else {
        notes.restored = { revisionBefore: before.revision, revisionAfter: after.revision };
        record("owner.restored", applied, `InferOps API: ${move.identifier} ${after.stateId === to ? `back in ${toName}` : "NOT moved back"}, revision ${before.revision} -> ${after.revision}`);
      }
    }
  } finally {
    close();
  }
}

async function operateFlow(browser: Any): Promise<void> {
  const persona = env.GROKBOT_OPERATE_USER!;
  const { context, page, token, inferops } = await signIn(browser, "operate", persona);
  const { api, close } = connectWorkshop();
  try {
    const user = await api.authenticate(token);
    // A first sign-in lands on the onboarding wizard; the smoke is not testing it.
    if (!await user.isOnboardingCompleted()) await user.completeOnboarding();
    const account = await connectInferOps(context, page, user, "operate", persona);
    if (!record("operate.signIn", Boolean(token && account), account ? "InferOS session, own InferOps account connected" : "no InferOps account connected")) return;
    await wikiReads("operate", page, user, account!.id, persona, inferops).catch((error: Error) => record("operate.wikiReads", false, error.message.split("\n")[0]!));
    // Operate is an operations member, but a knowledge viewer. Exercise a Wiki body write,
    // never a board transition. The owner's independent read detects an unauthorized change.
    const ownerApi = await inferopsApi(inferops, env.GROKBOT_PERSONA_USER!);
    if (typeof ownerApi === "string") { record("operate.knowledgeWriteRefused", false, ownerApi); return; }
    const overseer = await ensureWorkspace(user, "Stage smoke (operate)");
    const workspaceId = (await overseer.getMetadata()).id as string;
    const connection = await overseer.getGatekeeperByResourceUrl(wikiUrl) ?? await overseer.newGatekeeper(account!.id, wikiUrl);
    if (!connection) throw new Error(`the operate account cannot open ${wikiUrl}`);
    const connectionId = await connection.getId() as number;
    for (let stale = await pendingFor(overseer, connectionId); stale; stale = await pendingFor(overseer, connectionId)) {
      await overseer.rejectAction(stale.id);
    }
    const session = await connection.openSession();
    try {
      const documents = await session.listDocuments() as { slug: string; parentId: string | null }[];
      const first = documents.find(d => d.parentId === null) ?? documents[0];
      if (!first) throw new Error("the operate Wiki has no page; knowledge authorization is unproven");
      const document = await session.readDocument(first.slug) as { id: string; version: number; body: string };
      const before = await ownerApi.wikiPage(first.slug);
      if (!before || before.id !== document.id || before.version !== document.version || before.body !== document.body) {
        throw new Error("owner and operate disagree on the knowledge document identity, version or body");
      }
      const proposedBody = `${before.body}\n\nStage smoke authorization probe ${crypto.randomUUID()}`;
      if (proposedBody.length > 200_000) throw new Error("Wiki page too large for a valid body-write probe");
      const result = await checkKnowledgeWrite(before, {
        read: () => ownerApi.wikiPage(first.slug),
        propose: () => session.updateDocumentBody(document.id, proposedBody, before.version),
        pending: async () => (await pendingFor(overseer, connectionId))?.id,
        approve: async (id) => {
          await approveInBrowser(page, workspaceId, "operate-04-approve-knowledge-attempt.png");
          return until(() => actionState(overseer, id),
            value => (value.state !== undefined && value.state !== "pending") || value.lastAttempt !== undefined, 30_000);
        },
        reject: async (id) => { await overseer.rejectAction(id); },
      });
      await page.screenshot({ path: join(out, "operate-05-after-knowledge-attempt.png") });
      record("operate.knowledgeWriteRefused", result.ok, result.detail);
    } finally {
      session[Symbol.dispose]();
      connection[Symbol.dispose]();
    }
  } finally {
    close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [name, flow] of [["owner", ownerFlow], ["operate", operateFlow]] as const) {
    try {
      await flow(browser);
    } catch (error) {
      record(`${name}.error`, false, (error as Error).message.split("\n")[0]!);
    }
  }
} finally {
  await browser.close();
}
for (const name of STAGE_SMOKE_ORACLES) if (!oracles.some(o => o.name === name)) oracles.push({ name, ok: false, detail: "not reached" });
const ok = smokeOraclesPass(oracles);
writeFileSync(join(out, "smoke.json"), JSON.stringify({ ok, stage: stage.origin, board: boardUrl, oracles, notes }, null, 2) + "\n");
process.exitCode = ok ? 0 : 1;

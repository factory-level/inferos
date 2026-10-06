// Prepares a running local Workshop for development in one command, so neither a person nor an
// agent has to click through signup, onboarding and settings first. Every step is idempotent.
//
//   pnpm dev:setup [--url http://localhost:8787] [--user dev] [--password devpassword]
//                  [--mock-model [http://localhost:11434]] [--inferops] [--screen operations]
//                  [--console]
//
// It signs in (creating the account on first run) with the same password hash the browser derives,
// so the printed username and password also work on the login page, and they match the
// VITE_DEV_AUTO_LOGIN defaults. Then, as requested:
//   --mock-model  registers the scripted model served by `pnpm dev:mock-model` and makes it the
//                 preferred model, so chats work with no model credentials;
//   --inferops    opts into the auto-provisioned InferOps gatekeeper (mock data);
//   --screen ID   ensures a demo workspace with an InferOps Canvas screen from catalog template ID;
//   --console     ensures test data for Operate: in the demo workspace, a connection to the mock
//                 demo board, Board and Activity screens over it, and an "Operations lead" console
//                 whose views are Overview (a rollup of both), Board and Activity. Implies --inferops.
// It prints a JSON report including the session token, which a browser can adopt with
// `localStorage.setItem("authToken", token)`.
//
// Deliberately local-only: it refuses any host but localhost, since it creates accounts and sends a
// session to the target.

import { parseArgs } from "node:util";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import type { CanvasContent } from "@gadgets/workshop-shared/canvas";
import {
  connectWorkshop, DEMO_BOARD_URL, DEMO_WORKSPACE_TITLE, ensureWorkspace, INFEROPS_VENDOR_ID,
  listConnectedAccounts, localWorkshopUrl, passwordHash,
} from "./dev-workshop.ts";

const SCRIPTED_MODEL_ID = "scripted-inferops";

const { values: options } = parseArgs({
  options: {
    url: { type: "string", default: `http://${process.env.VITE_BACKEND_HOST ?? "localhost:8787"}` },
    user: { type: "string", default: process.env.VITE_DEV_USERNAME ?? "dev" },
    password: { type: "string", default: process.env.VITE_DEV_PASSWORD ?? "devpassword" },
    "mock-model": { type: "string" },
    inferops: { type: "boolean", default: false },
    screen: { type: "string" },
    console: { type: "boolean", default: false },
  },
  // `--mock-model` with no value means the default local endpoint.
  args: process.argv.slice(2).flatMap((arg, index, all) =>
    arg === "--mock-model" && (all[index + 1] === undefined || all[index + 1].startsWith("--"))
      ? [arg, "http://localhost:11434"] : [arg]),
});

let base: URL;
try {
  base = localWorkshopUrl(options.url);
} catch (error) {
  console.error(`dev:setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function signIn(api: RpcStub<PublicApi>): Promise<{ token: string; created: boolean }> {
  const hash = passwordHash(options.user, options.password);
  const existing = await api.login(options.user, hash);
  if (existing) return { token: existing, created: false };
  const created = await api.createAccount(options.user, options.user, hash);
  if (!created) throw new Error(`Cannot sign in as "${options.user}": the account exists with a different password`);
  return { token: created, created: true };
}

async function ensureMockModel(user: RpcStub<AuthenticatedApi>, apiUrl: string): Promise<string> {
  const models = await user.listModels();
  // Registered as `mock`, so an install into a space that is not test-only refuses it.
  const profile = { type: "agent" as const, id: SCRIPTED_MODEL_ID, name: "Scripted InferOps (mock)" };
  const config = { provider: "ollama" as const, model: SCRIPTED_MODEL_ID, apiToken: "", apiUrl, mock: true };
  if (!models.some(model => model.id === SCRIPTED_MODEL_ID)) await user.addModel(profile, config);
  else await user.updateModel(profile, config);
  await user.setPreferredModel(SCRIPTED_MODEL_ID);
  return SCRIPTED_MODEL_ID;
}

async function ensureInferOps(user: RpcStub<AuthenticatedApi>): Promise<"provisioned" | "already connected"> {
  const addable = await user.listAddableGatekeepers();
  if (!addable.some(vendor => vendor.id === INFEROPS_VENDOR_ID)) return "already connected";
  await user.provisionAmbientAccount(INFEROPS_VENDOR_ID);
  return "provisioned";
}

async function ensureScreen(api: RpcStub<PublicApi>, user: RpcStub<AuthenticatedApi>, templateId: string) {
  const config = await api.getServerConfig();
  if (!config.canvasFeatures?.durableViews) {
    throw new Error("Saved canvases are off: create inferos.canvas.json (pnpm canvas init) and restart the dev server");
  }
  const template = config.canvasFeatures.catalog?.screens.find(screen => screen.id === templateId);
  if (!template) throw new Error(`No screen template "${templateId}"; add one with pnpm canvas add-screen`);

  const { overseer } = await ensureWorkspace(user, DEMO_WORKSPACE_TITLE, "pnpm dev:setup");
  try {
    const workspaceId = (await overseer.getMetadata()).id;
    const screens = await overseer.listCanvases();
    const screen = screens.find(entry => entry.title === template.content.title)
      ?? await overseer.createCanvas(template.content);
    return { workspaceId, screenId: screen.id,
      url: new URL(`/workspace/${workspaceId}/inferops-canvas?view=${screen.id}`, base).toString() };
  } finally {
    overseer[Symbol.dispose]();
  }
}

const CONSOLE_TITLE = "Operations lead";

/** A screen of one section holding one demo board widget. */
function boardScreen(title: string, size: "wide" | "full", showCompleted: boolean): CanvasContent {
  return {
    title,
    sections: [{
      id: "main", title, columns: 2,
      widgets: [{
        id: "board", kind: "inferops.project-board", version: 1, targetRef: DEMO_BOARD_URL, size,
        params: { workflow: "software", showCompleted },
      }],
    }],
  };
}

async function ensureConsole(api: RpcStub<PublicApi>, user: RpcStub<AuthenticatedApi>) {
  const config = await api.getServerConfig();
  if (!config.canvasFeatures?.durableViews) {
    throw new Error("Saved canvases are off: create inferos.canvas.json (pnpm canvas init) and restart the dev server");
  }
  const account = (await listConnectedAccounts(user)).find(candidate => candidate.vendorId === INFEROPS_VENDOR_ID);
  if (!account) throw new Error("The InferOps account is not connected");

  const { overseer } = await ensureWorkspace(user, DEMO_WORKSPACE_TITLE, "pnpm dev:setup");
  try {
    const workspaceId = (await overseer.getMetadata()).id;
    // A board widget reads through the workspace's own connection to the board it names.
    using existingConnection = await overseer.getGatekeeperByResourceUrl(DEMO_BOARD_URL);
    if (!existingConnection) {
      using connection = await overseer.newGatekeeper(account.id, DEMO_BOARD_URL);
      if (!connection) throw new Error(`The InferOps account cannot open ${DEMO_BOARD_URL}`);
    }
    const screens = await overseer.listCanvases();
    const screen = async (content: CanvasContent) =>
      screens.find(entry => entry.title === content.title) ?? await overseer.createCanvas(content);
    const board = await screen(boardScreen("Board", "full", false));
    const activity = await screen(boardScreen("Activity", "wide", true));

    const existing = (await overseer.listConsoles()).find(entry => entry.title === CONSOLE_TITLE);
    const created = existing ?? await overseer.createConsole({
      title: CONSOLE_TITLE, fullChat: "available",
      views: [
        { id: "overview", title: "Overview", type: "rollup", screens: [board.id, activity.id] },
        { id: "board", title: "Board", type: "screen", screen: board.id },
        { id: "activity", title: "Activity", type: "screen", screen: activity.id },
      ],
    });
    // Publish it, so a use-role operator sees it too; a console a builder is editing keeps its draft.
    const saved = created.published ? created : await overseer.publishConsole(created.id, created.revision);
    return { workspaceId, consoleId: saved.id, screens: { board: board.id, activity: activity.id },
      url: new URL("/inferops-canvas", base).toString() };
  } finally {
    overseer[Symbol.dispose]();
  }
}

const { api, close } = connectWorkshop(base);
try {
  const { token, created } = await signIn(api);
  using user = await api.authenticate(token);
  await user.completeOnboarding();
  const report: Record<string, unknown> = { ok: true, url: base.toString(), user: options.user, accountCreated: created };
  if (options["mock-model"] !== undefined) {
    report.model = await ensureMockModel(user, options["mock-model"]);
    report.modelServer = `${options["mock-model"]} (start it with pnpm dev:mock-model)`;
  }
  if (options.inferops || options.console) report.inferops = await ensureInferOps(user);
  if (options.screen !== undefined) report.screen = await ensureScreen(api, user, options.screen);
  if (options.console) report.console = await ensureConsole(api, user);
  // The token is a session for a throwaway local account; printing it lets a browser or agent adopt it.
  report.browserLogin = `localStorage.setItem("authToken", ${JSON.stringify(token)})`;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  close();
}

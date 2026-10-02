// Prepares a running local Workshop for development in one command, so neither a person nor an
// agent has to click through signup, onboarding and settings first. Every step is idempotent.
//
//   pnpm dev:setup [--url http://localhost:8787] [--user dev] [--password devpassword]
//                  [--mock-model [http://localhost:11434]] [--inferops] [--screen operations]
//
// It signs in (creating the account on first run) with the same password hash the browser derives,
// so the printed username and password also work on the login page, and they match the
// VITE_DEV_AUTO_LOGIN defaults. Then, as requested:
//   --mock-model  registers the scripted model served by `pnpm dev:mock-model` and makes it the
//                 preferred model, so chats work with no model credentials;
//   --inferops    opts into the auto-provisioned InferOps gatekeeper (mock data);
//   --screen ID   ensures a demo workspace with an InferOps Canvas screen from catalog template ID.
// It prints a JSON report including the session token, which a browser can adopt with
// `localStorage.setItem("authToken", token)`.
//
// Deliberately local-only: it refuses any host but localhost, since it creates accounts and sends a
// session to the target.

import { argon2Sync } from "node:crypto";
import { parseArgs } from "node:util";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import { SERVICE_SALT } from "@gadgets/workshop-shared/password-salt";

const DEMO_WORKSPACE_TITLE = "InferOps Canvas demo";
const SCRIPTED_MODEL_ID = "scripted-inferops";

const { values: options } = parseArgs({
  options: {
    url: { type: "string", default: `http://${process.env.VITE_BACKEND_HOST ?? "localhost:8787"}` },
    user: { type: "string", default: process.env.VITE_DEV_USERNAME ?? "dev" },
    password: { type: "string", default: process.env.VITE_DEV_PASSWORD ?? "devpassword" },
    "mock-model": { type: "string" },
    inferops: { type: "boolean", default: false },
    screen: { type: "string" },
  },
  // `--mock-model` with no value means the default local endpoint.
  args: process.argv.slice(2).flatMap((arg, index, all) =>
    arg === "--mock-model" && (all[index + 1] === undefined || all[index + 1].startsWith("--"))
      ? [arg, "http://localhost:11434"] : [arg]),
});

const base = new URL(options.url);
if (base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
  console.error("dev:setup only targets a local Workshop (localhost or 127.0.0.1)");
  process.exit(1);
}

/** The browser's password hash (see `PublicApi.login()`), derived with Node's own Argon2id. */
function passwordHash(username: string, password: string): Uint8Array {
  const salt = Buffer.concat([SERVICE_SALT, Buffer.from(username, "utf8")]);
  return new Uint8Array(argon2Sync("argon2id",
    { message: password, nonce: salt, parallelism: 1, passes: 3, memory: 65536, tagLength: 32 }));
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
  if (!models.some(model => model.id === SCRIPTED_MODEL_ID)) {
    await user.addModel({ type: "agent", id: SCRIPTED_MODEL_ID, name: "Scripted InferOps (mock)" },
      { provider: "ollama", model: SCRIPTED_MODEL_ID, apiToken: "", apiUrl });
  }
  await user.setPreferredModel(SCRIPTED_MODEL_ID);
  return SCRIPTED_MODEL_ID;
}

async function ensureInferOps(user: RpcStub<AuthenticatedApi>): Promise<"provisioned" | "already connected"> {
  const addable = await user.listAddableGatekeepers();
  if (!addable.some(vendor => vendor.id === "inferops")) return "already connected";
  await user.provisionAmbientAccount("inferops");
  return "provisioned";
}

async function ensureScreen(api: RpcStub<PublicApi>, user: RpcStub<AuthenticatedApi>, templateId: string) {
  const config = await api.getServerConfig();
  if (!config.canvasFeatures?.durableViews) {
    throw new Error("Saved canvases are off: create inferos.canvas.json (pnpm canvas init) and restart the dev server");
  }
  const template = config.canvasFeatures.catalog?.screens.find(screen => screen.id === templateId);
  if (!template) throw new Error(`No screen template "${templateId}"; add one with pnpm canvas add-screen`);

  const existing = (await user.listGadgets()).find(workspace => workspace.title === DEMO_WORKSPACE_TITLE);
  let overseer: RpcStub<Overseer>;
  if (existing) {
    overseer = user.openGadget(existing.id);
  } else {
    overseer = user.newGadget();
    await overseer.setTitle(DEMO_WORKSPACE_TITLE);
    // A workspace stays provisional (hidden, and eventually reaped) until it has activity; a chat
    // with no agent is the lightest activity that keeps it.
    await overseer.newChat("Workspace prepared by pnpm dev:setup.", null);
  }
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

const wsUrl = new URL("/api", base);
wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const api = newWebSocketRpcSession<PublicApi>(wsUrl.toString());
try {
  const { token, created } = await signIn(api);
  using user = await api.authenticate(token);
  await user.completeOnboarding();
  const report: Record<string, unknown> = { ok: true, url: base.toString(), user: options.user, accountCreated: created };
  if (options["mock-model"] !== undefined) {
    report.model = await ensureMockModel(user, options["mock-model"]);
    report.modelServer = `${options["mock-model"]} (start it with pnpm dev:mock-model)`;
  }
  if (options.inferops) report.inferops = await ensureInferOps(user);
  if (options.screen !== undefined) report.screen = await ensureScreen(api, user, options.screen);
  // The token is a session for a throwaway local account; printing it lets a browser or agent adopt it.
  report.browserLogin = `localStorage.setItem("authToken", ${JSON.stringify(token)})`;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  api[Symbol.dispose]();
}

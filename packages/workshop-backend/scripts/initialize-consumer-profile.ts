import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newWebSocketRpcSession } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { parseConsumerConfig } from "../../../scripts/consumer/config.ts";

const root = resolve(process.argv[2] ?? ".");
const config = parseConsumerConfig(JSON.parse(readFileSync(join(root, "inferos.config.json"), "utf8")));
const token = process.env.INFEROS_ADMIN_SESSION;
if (!token) throw new Error("Set INFEROS_ADMIN_SESSION to a local Workshop administrator session token");

const instructions = config.profile === "inferops-operations"
  ? "Help build and operate applications around InferOps projects, workflow states and issues. " +
    "Treat InferOps as the transactional source of truth. Use granted resource capabilities; " +
    "a resource reference is not authorization. Distinguish proposed changes from applied changes. " +
    "Keep interfaces simple and uncluttered, and report unavailable integrations instead of inventing data."
  : "Help build personal applications with simple, uncluttered interfaces. Use only granted resource " +
    "capabilities and distinguish proposed changes from applied changes.";

// Deliberately local-only: a wrapper command must not send an administrator session to a configured
// external data endpoint. Cloud profile application needs an explicit deployment-origin contract.
const socket = new WebSocket(`ws://localhost:${config.local.port}/api`);
const api = newWebSocketRpcSession<PublicApi>(socket);
const timeout = setTimeout(() => socket.close(), 15_000);
try {
  const authenticated = await api.authenticate(token);
  const admin = await authenticated.getAdminApi();
  if (!admin) throw new Error("This local account is not a deployment administrator");
  const result = await admin.initializeProfile({ siteName: config.styling.siteName,
    instanceInstructions: instructions, defaultTheme: config.styling.theme, displayDensity: config.styling.density });
  console.log(JSON.stringify({ ok: true, operation: "profile", result, profile: config.profile,
    pending: ["InferOps data and view adapters"] }));
} catch {
  // RPC and provider errors can include user-supplied values; never echo the session or remote text.
  console.error("Profile initialization failed. Check the local server, administrator session and supported InferOS revision.");
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  api[Symbol.dispose]();
  socket.close();
}

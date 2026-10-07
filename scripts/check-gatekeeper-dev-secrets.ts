#!/usr/bin/env node

// Runtime proof that run-dev-server.ts never prints a gatekeeper credential, on a minimal isolated
// Wrangler fixture rather than the whole monorepo (which needs far more file watches):
//
//   node scripts/check-gatekeeper-dev-secrets.ts [--port 8799]
//
// It writes a two-worker fixture in a temporary directory, the second worker's config and `.dev.vars`
// produced by the same helpers run-dev-server.ts uses (splitGatekeeperSecrets, installDevVarsSecrets),
// with synthetic sentinel values only, never a real credential, some needing careful quoting, and a
// CLIENT_SECRET the gatekeeper's own `.dev.vars` already sets. It starts `wrangler dev` with both
// configs, as run-dev-server.ts does, and checks that the second worker received every value exactly
// (the local CLIENT_SECRET winning), that Wrangler's startup output lists each secret as hidden, and
// that no sentinel appears in that output.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinEntry } from "./bin-entry.ts";
import { GATEKEEPER_SECRET_VARS, splitGatekeeperSecrets, withoutLocalOverrides } from "./gatekeeper-dev-secrets.ts";
import { installDevVarsSecrets } from "./local-secrets.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8799;

// Synthetic values, including ones that need careful quoting in a dotenv file.
// Each starts with this run's marker, which survives Wrangler truncating long values in its table.
const marker = `S${randomUUID().slice(0, 8)}`;
const secrets: Record<string, string> = {
  INFEROPS_API_TOKEN: `${marker}-SENTINEL-not-a-real-token it's \\ backslashed`,
  MCP_PORTAL_TOKEN: `${marker}-SENTINEL-not-a-real-token # "quoted"\nsecond line`,
  CLIENT_SECRET: `${marker}-SENTINEL-not-a-real-token shared`,
};
// The gatekeeper's own `.dev.vars` already sets CLIENT_SECRET, as a developer's local pair would: it
// must keep its value rather than the generated one.
const localClientSecret = `${marker}-SENTINEL-not-a-real-token local`;
const expected = { ...secrets, CLIENT_SECRET: localClientSecret };

const dir = mkdtempSync(join(tmpdir(), "inferos-dev-secrets-"));
let output = "";
let failure: string | null = null;
try {
  mkdirSync(join(dir, "primary"));
  mkdirSync(join(dir, "gatekeeper"));
  const { vars, secrets: moved } = splitGatekeeperSecrets({ PLAIN: "plain-value", ...secrets });
  const local = `CLIENT_SECRET='${localClientSecret}'\n`;
  writeFileSync(join(dir, "gatekeeper", ".dev.vars"), local);
  writeFileSync(join(dir, "gatekeeper", "wrangler.dev.jsonc"), JSON.stringify({
    name: "fixture-gatekeeper", main: "index.js", compatibility_date: "2026-09-01", vars,
  }, null, 2));
  installDevVarsSecrets(join(dir, "gatekeeper", ".dev.vars"), withoutLocalOverrides(local, moved));
  writeFileSync(join(dir, "gatekeeper", "index.js"), `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async fetch() { return new Response("ok"); }
  // Compares without returning any value.
  matches(expected) { return Object.entries(expected).every(([name, value]) => this.env[name] === value); }
}
`);
  writeFileSync(join(dir, "primary", "wrangler.jsonc"), JSON.stringify({
    name: "fixture-primary", main: "index.js", compatibility_date: "2026-09-01",
    services: [{ binding: "GATEKEEPER", service: "fixture-gatekeeper" }],
  }));
  writeFileSync(join(dir, "primary", "index.js"), `export default { async fetch(request, env) {
  return new Response(String(await env.GATEKEEPER.matches(await request.json())));
} };
`);

  const wrangler = resolveBinEntry(ROOT, "wrangler");
  if (!wrangler) throw new Error("wrangler is not installed in this checkout");
  const child = spawn(process.execPath, [wrangler, "dev", "-c", "primary/wrangler.jsonc",
    "-c", "gatekeeper/wrangler.dev.jsonc", "--port", String(port)], { cwd: dir });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    let received: string | null = null;
    for (let attempt = 0; attempt < 60 && received === null; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const response = await fetch(`http://localhost:${port}/`, { method: "POST", body: JSON.stringify(expected) });
        received = await response.text();
      } catch { /* not listening yet */ }
    }
    if (received !== "true") failure = `the gatekeeper worker did not receive every secret (${received ?? "no response"})`;
  } finally {
    child.kill("SIGINT");
    await new Promise(resolve => child.once("exit", resolve));
  }
  const leaked = output.includes(marker);
  const unhidden = [...GATEKEEPER_SECRET_VARS].filter(name => !output.includes(`env.${name} ("(hidden)")`));
  if (leaked) failure = "a sentinel value appeared in Wrangler's output";
  if (unhidden.length > 0) failure ??= `not listed as hidden: ${unhidden.join(", ")}`;
  if (!output.includes(`env.PLAIN ("plain-value")`)) failure ??= "the plain var was not listed";
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failure) {
  console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`PASS: ${GATEKEEPER_SECRET_VARS.size} gatekeeper secrets reached the worker exactly (the local ` +
  `CLIENT_SECRET kept), were listed as hidden, and no sentinel value appeared in Wrangler's output.`);

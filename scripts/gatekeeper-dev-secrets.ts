import { parseEnv } from "node:util";

// Which generated gatekeeper dev vars are secrets. Wrangler prints a worker's `vars` in full in its
// startup bindings table, but lists values from the `.dev.vars` beside its config as hidden, so
// run-dev-server.ts moves these out of `vars` and into that file (see installDevVarsSecrets).

/** Gatekeeper dev vars that hold credentials and must never be printed. */
export const GATEKEEPER_SECRET_VARS: ReadonlySet<string> = new Set([
  "CLIENT_SECRET", "INFEROPS_API_TOKEN", "MCP_PORTAL_TOKEN",
]);

/** Splits a gatekeeper's dev `vars` into the plain ones and the secrets (as strings). */
export function splitGatekeeperSecrets(vars: Record<string, unknown>)
    : { vars: Record<string, unknown>; secrets: Record<string, string> } {
  const plain: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (GATEKEEPER_SECRET_VARS.has(name) && value !== undefined) secrets[name] = String(value);
    else plain[name] = value;
  }
  return { vars: plain, secrets };
}

/**
 * The generated secrets a gatekeeper's own `.dev.vars` (its text, or null when there is none) does not
 * already set. A key the developer set there keeps their value, as it did when the generated value
 * was a plain var the file overrode, so a local CLIENT_ID/CLIENT_SECRET pair stays matched.
 */
export function withoutLocalOverrides(localDevVars: string | null, secrets: Record<string, string>)
    : Record<string, string> {
  if (localDevVars === null) return secrets;
  const local = parseEnv(localDevVars);
  return Object.fromEntries(Object.entries(secrets).filter(([name]) => !(name in local)));
}

// Configuration for sign-in via authentication gatekeepers (an optional, additive login feature).
//
// Authentication is provided by gatekeepers (e.g. "google", "github", "cloudflare") that advertise
// `providesAuth`. A deployment opts specific gatekeepers into the login UI via the AUTH_GATEKEEPERS
// allowlist (comma-separated vendor ids). When set, each listed, auth-capable gatekeeper gets a
// "Continue with ..." button alongside the normal username/password form (unless password auth is
// disabled). All OFF by default.

import { getAuthVendorBinding } from "./auth-vendors.js";

/**
 * Parse the AUTH_GATEKEEPERS allowlist into a list of gatekeeper vendor ids (lowercased). These are
 * the gatekeepers permitted to drive sign-in; a vendor must also actually advertise `providesAuth`
 * to be offered. Empty when unset.
 */
export function getAuthGatekeeperAllowlist(env: Cloudflare.Env): string[] {
  const raw = (env as { AUTH_GATEKEEPERS?: string }).AUTH_GATEKEEPERS;
  if (!raw) return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Whether the deployment has opted any gatekeeper into sign-in. */
export function hasAuthGatekeepers(env: Cloudflare.Env): boolean {
  return getAuthGatekeeperAllowlist(env).length > 0;
}

/**
 * Whether username/password login + signup is available. Enabled by default. An installation can
 * set DISABLE_PASSWORD_AUTH=true to be OAuth-only — but that only takes effect when at least one
 * auth gatekeeper is allowlisted, otherwise we'd lock everyone out, so password auth stays on.
 */
export function isPasswordAuthEnabled(env: Cloudflare.Env): boolean {
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env);
}

/**
 * Checks that the sign-in allowlist can be honoured: every vendor in AUTH_GATEKEEPERS must be bound
 * (`GATEKEEPER_<NAME>`) and must advertise `providesAuth`. A listed vendor that is not configured
 * for sign-in (for example the InferOps gatekeeper without its InferLab origin) would otherwise
 * just be left off the login page, which with password auth disabled offers no way in at all; the
 * deployment fails with the reason instead. Run once before the API serves.
 */
export async function assertAuthGatekeepersConfigured(env: Cloudflare.Env): Promise<void> {
  for (const vendorId of getAuthGatekeeperAllowlist(env)) {
    const binding = getAuthVendorBinding(env, vendorId);
    if (!binding) {
      throw new Error(`AUTH_GATEKEEPERS lists "${vendorId}", but no gatekeeper is bound as ` +
        `GATEKEEPER_${vendorId.toUpperCase()}.`);
    }
    if (!(await binding.describe()).providesAuth) {
      throw new Error(`AUTH_GATEKEEPERS lists "${vendorId}", but that gatekeeper is not configured ` +
        `to provide sign-in; configure it, or remove it from AUTH_GATEKEEPERS.`);
    }
  }
}

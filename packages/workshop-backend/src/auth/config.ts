// Configuration for sign-in via authentication gatekeepers (an optional, additive login feature).
//
// Authentication is provided by gatekeepers (e.g. "google", "github", "cloudflare") that advertise
// `providesAuth`. A deployment opts specific gatekeepers into the login UI via the AUTH_GATEKEEPERS
// allowlist (comma-separated vendor ids). When set, each listed, auth-capable gatekeeper gets a
// "Continue with ..." button alongside the normal username/password form (unless password auth is
// disabled). All OFF by default.

import { isIssuerOrigin } from "../account-subject.js";

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

/**
 * The issuer a `providesSubject` gatekeeper may sign people in for, or why there is none. Read
 * from AUTH_GATEKEEPER_ISSUERS: comma-separated `<vendor id>=<origin>` pairs, e.g.
 * `inferlab=https://auth.inferops.io`. The kernel refuses a subject whose issuer isn't this one, so a
 * gatekeeper can't mint subjects for another provider's people.
 *
 * The setting is all or nothing: an empty item, a missing `=`, an empty or malformed vendor id,
 * whitespace inside a value, an origin outside the InferLab contract's issuer rule, or a vendor
 * named twice invalidates the whole setting, so no vendor signs anyone in by subject until it is
 * fixed. `error` names the setting and the bad entry by position and vendor id, never its value.
 */
export function getAuthGatekeeperIssuer(env: Cloudflare.Env, vendorId: string)
    : { issuer: string } | { error: string } {
  const parsed = parseAuthGatekeeperIssuers(
      (env as { AUTH_GATEKEEPER_ISSUERS?: string }).AUTH_GATEKEEPER_ISSUERS);
  if ("error" in parsed) return parsed;
  // The same order as the parser: an id that isn't ASCII names no vendor, whatever it folds to.
  if (!VENDOR_ID.test(vendorId)) {
    return { error: "AUTH_GATEKEEPER_ISSUERS can't be looked up for a vendor id that isn't ASCII." };
  }
  const issuer = parsed.issuers.get(vendorId.toLowerCase());
  return issuer !== undefined ? { issuer }
    : { error: `AUTH_GATEKEEPER_ISSUERS has no entry for "${vendorId}", so it can't sign anyone in.` };
}

/**
 * A vendor id as written: ASCII only, checked BEFORE any case folding. `toLowerCase()` maps some
 * non-ASCII letters onto ASCII ones (the Kelvin sign U+212A to `k`, the dotted capital I U+0130 to
 * `i` plus a combining dot), so folding first would let a look-alike name a real vendor.
 */
const VENDOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parses AUTH_GATEKEEPER_ISSUERS strictly (see getAuthGatekeeperIssuer). Unset or blank is an empty
 * map; anything malformed is an error for the whole setting.
 */
export function parseAuthGatekeeperIssuers(raw: string | undefined)
    : { issuers: Map<string, string> } | { error: string } {
  const issuers = new Map<string, string>();
  if (raw === undefined || raw.trim() === "") return { issuers };
  const items = raw.split(",");
  for (const [index, item] of items.entries()) {
    const entry = `AUTH_GATEKEEPER_ISSUERS entry ${index + 1}`;
    const at = item.indexOf("=");
    if (item.trim() === "") return { error: `${entry} is empty.` };
    if (at < 0) return { error: `${entry} has no "=" (expected <vendor id>=<origin>).` };
    const rawVendor = item.slice(0, at).trim();
    const origin = item.slice(at + 1).trim();
    if (!VENDOR_ID.test(rawVendor)) return { error: `${entry} has no valid vendor id.` };
    // ASCII-only by now, so lowercasing can't turn one vendor id into another.
    const vendor = rawVendor.toLowerCase();
    const named = `${entry} ("${vendor}")`;
    if (/\s/.test(origin)) return { error: `${named} has whitespace in its origin.` };
    if (!isIssuerOrigin(origin)) {
      return { error: `${named} isn't an https origin (or an http loopback origin) of at most 255 characters.` };
    }
    if (issuers.has(vendor)) return { error: `${named} names a vendor an earlier entry already names.` };
    issuers.set(vendor, origin);
  }
  return { issuers };
}

/** Whether the deployment has opted any gatekeeper into sign-in. */
export function hasAuthGatekeepers(env: Cloudflare.Env): boolean {
  return getAuthGatekeeperAllowlist(env).length > 0;
}

/**
 * Whether the user `name` is one of the deployment admins the ADMINS binding lists. Names match
 * regardless of the case of ASCII letters, as Cloudflare Access matches its email rules: the
 * list is typed by hand, while a sign-in names its user by the email as the identity provider
 * spells it, or by a password username, which is stored lowercased.
 */
export function isDeploymentAdmin(env: Cloudflare.Env, name: string): boolean {
  let admins: unknown = env.ADMINS;
  if (!admins) return false;

  if (typeof admins === "string") {
    // Admins should be a JSON binding of array type, but `.env` doesn't actually let you
    // specify JSON bindings, so we also support a string that parses as JSON array.
    admins = JSON.parse(admins);
  }

  if (!Array.isArray(admins)) {
    throw new TypeError("ADMINS must be configured as an array of usernames.");
  }

  let lowered = asciiLowerCase(name);
  return admins.some(admin => typeof admin === "string" && asciiLowerCase(admin) === lowered);
}

// Only ASCII letters are folded: toLowerCase() also folds some other characters onto ASCII ones,
// such as the Kelvin sign onto "k", which would let a look-alike name match an admin's.
const asciiLowerCase = (text: string) => text.replace(/[A-Z]/g, letter => letter.toLowerCase());

/**
 * Whether username/password login + signup is available. Enabled by default. An installation can
 * set DISABLE_PASSWORD_AUTH=true to be OAuth-only — but that only takes effect when at least one
 * auth gatekeeper is allowlisted, otherwise we'd lock everyone out, so password auth stays on.
 */
export function isPasswordAuthEnabled(env: Cloudflare.Env): boolean {
  if (env.DISABLE_PASSWORD_AUTH !== "true") return true;
  return !hasAuthGatekeepers(env);
}

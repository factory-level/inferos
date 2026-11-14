// The deployment settings InferLab sign-in reads, each parsed so that anything unexpected turns
// sign-in off with a reason, instead of sending people somewhere else or admitting another company.
// There is no fallback: no default issuer, no demo company, no password path.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BASE_URL = "http://localhost:8787/gatekeeper/inferlab";

/** The settings this file reads. */
export type InferLabEnv = { INFERLAB_AUTH_ORIGIN?: string; INFEROPS_COMPANY?: string; BASE_URL?: string };

/** What sign-in runs with, once every setting is valid. */
export type InferLabConfig = {
  /** The central-auth origin, which is also every subject's issuer. */
  issuer: string;
  /** The one company this deployment admits, lowercased. */
  tenantId: string;
  /** This gatekeeper's base URL, without a trailing slash. */
  baseUrl: string;
};

/** Why sign-in is off, in words an administrator can act on. Names settings, never values. */
export const NOT_CONFIGURED = {
  issuer: "InferLab sign-in is off: INFERLAB_AUTH_ORIGIN is missing or isn't an https origin " +
    "(or an http loopback origin for local development).",
  company: "InferLab sign-in is off: INFEROPS_COMPANY is missing or isn't a tenant id.",
  baseUrl: "InferLab sign-in is off: BASE_URL isn't an http(s) URL.",
} as const;

/** A bare origin: https, or http on a loopback host. Anything else is null. */
export function parseOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return null;
  }
  return url.origin;
}

/** The deployment's sign-in settings, or the first reason sign-in is off. */
export function readConfig(env: InferLabEnv): InferLabConfig | { off: string } {
  const issuer = parseOrigin(env.INFERLAB_AUTH_ORIGIN);
  if (!issuer) return { off: NOT_CONFIGURED.issuer };
  const company = env.INFEROPS_COMPANY?.trim() ?? "";
  if (!TENANT_ID.test(company)) return { off: NOT_CONFIGURED.company };
  const base = (env.BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return { off: NOT_CONFIGURED.baseUrl };
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") return { off: NOT_CONFIGURED.baseUrl };
  return { issuer, tenantId: company.toLowerCase(), baseUrl: base };
}

/** The exact redirect URI InferLab must have registered for the `inferos` client. */
export const redirectUriFor = (config: InferLabConfig): string => `${config.baseUrl}/oauth`;

/** The path prefix of the base URL, `""` at the root. */
export function basePathOf(config: Pick<InferLabConfig, "baseUrl">): string {
  const path = new URL(config.baseUrl).pathname;
  return path === "/" ? "" : path;
}

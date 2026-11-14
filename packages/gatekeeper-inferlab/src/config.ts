// The deployment settings InferLab sign-in reads, each parsed so that anything unexpected turns
// sign-in off with a reason, instead of sending people somewhere else or admitting another company.
// There is no fallback: no default issuer, company or base URL, no demo company, no password path.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The InferLab contract's issuer rule (`inferlab.stable-subject` v1, inferops
 * `lib/ts/contracts/shared/origin.ts`), mirrored exactly; a test compares it with the pinned schema
 * in `scripts/inferlab-contracts`. The kernel applies the same rule to every subject it is handed.
 */
export const ISSUER_PATTERN =
  /^(?:https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)$/;
export const ISSUER_MAX_LENGTH = 255;

/**
 * The path InferOps central-auth registers for this sign-in: inferops `INFEROS_SIGN_IN_CALLBACK_PATH`
 * (`domain/ts/portal/shared/sso.dto.ts`, factory-level/inferops#2678). The Workshop routes a gatekeeper
 * at `/gatekeeper/<name>`, so BASE_URL must end in this package's route for the redirect to be it.
 */
export const GATEKEEPER_PATH = "/gatekeeper/inferlab";
export const SIGN_IN_CALLBACK_PATH = `${GATEKEEPER_PATH}/oauth`;

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
  baseUrl: "InferLab sign-in is off: BASE_URL is missing, isn't https (or http on a loopback host), " +
    `or doesn't end in ${GATEKEEPER_PATH}.`,
} as const;

/** A bare origin under the contract's issuer rule. Anything else is null. */
export function parseOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > ISSUER_MAX_LENGTH || !ISSUER_PATTERN.test(value)) return null;
  try {
    return new URL(value).origin === value ? value : null;
  } catch {
    return null;
  }
}

/** BASE_URL, required: https, or http on a loopback host, ending exactly in the gatekeeper's route. */
function parseBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== GATEKEEPER_PATH) return null;
  return `${url.origin}${url.pathname}`;
}

/** The deployment's sign-in settings, or the first reason sign-in is off. */
export function readConfig(env: InferLabEnv): InferLabConfig | { off: string } {
  const issuer = parseOrigin(env.INFERLAB_AUTH_ORIGIN);
  if (!issuer) return { off: NOT_CONFIGURED.issuer };
  const company = env.INFEROPS_COMPANY?.trim() ?? "";
  if (!TENANT_ID.test(company)) return { off: NOT_CONFIGURED.company };
  const baseUrl = parseBaseUrl(env.BASE_URL);
  if (!baseUrl) return { off: NOT_CONFIGURED.baseUrl };
  return { issuer, tenantId: company.toLowerCase(), baseUrl };
}

/** The exact redirect URI InferLab must have registered for the `inferos` client. */
export const redirectUriFor = (config: InferLabConfig): string => `${config.baseUrl}/oauth`;

/** The path prefix of the base URL, `""` at the root. */
export function basePathOf(config: Pick<InferLabConfig, "baseUrl">): string {
  const path = new URL(config.baseUrl).pathname;
  return path === "/" ? "" : path;
}

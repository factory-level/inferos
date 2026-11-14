// A person's account keyed on their provider's stable subject, not their email (FAC-214; the
// InferLab cross-product contract `inferlab.stable-subject`, inferops ADR 0020). A vendor that
// declares `providesSubject` signs people in by subject: the account is named by the subject alone,
// so a changed email keeps the account and two subjects that share an email stay two accounts.
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";

/** OpenID Connect's rule for `sub`, which the contract adopts: 1 to 255 printable ASCII characters. */
const SUBJECT = /^[\x21-\x7e]{1,255}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether `issuer` is an origin a subject may come from: exactly `URL.origin` form, https, or http on
 * a loopback host for local development.
 */
function isIssuerOrigin(issuer: string): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.origin !== issuer) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/** Whether a vendor-reported subject is well formed; a sign-in with any other one is refused. */
export function isValidSubject(subject: GatekeeperSubject): boolean {
  return isIssuerOrigin(subject.issuer) && SUBJECT.test(subject.subject);
}

/**
 * The account name a subject keys: `subject~<issuer>~<subject>`, each part URI-encoded with `~`
 * encoded too, so the two parts can't run together and no two subjects share a name. It holds no
 * `@`, so no email names it; no `:`, so the `<name>:<secret>` session token still splits; and a `~`,
 * which no password username (`[a-z][a-z0-9_]*`) holds. It equals the contract's `subjectKey`.
 */
export function subjectAccountName(subject: GatekeeperSubject): string {
  return `subject~${encodePart(subject.issuer)}~${encodePart(subject.subject)}`;
}

const encodePart = (part: string) => encodeURIComponent(part).replaceAll("~", "%7E");

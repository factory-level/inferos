// A person's account keyed on their provider's stable subject, not their email (FAC-214; the
// InferLab cross-product contract `inferlab.stable-subject`, inferops ADR 0020). A vendor that
// declares `providesSubject` signs people in by subject: the account is named by the subject alone,
// so a changed email keeps the account and two subjects that share an email stay two accounts.
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";

/**
 * The InferLab contract's `inferlab.stable-subject` v1 rules, mirrored exactly (inferops
 * `lib/ts/contracts/shared/origin.ts` and `identity.ts`; the pinned schema is
 * `scripts/inferlab-contracts/schemas/inferlab.stable-subject.v1.schema.json`, and a test compares
 * these with it). The issuer is an origin in `URL.origin` form, https or loopback http, at most 255
 * characters; the subject is OpenID Connect's `sub`: 1 to 255 printable ASCII characters.
 */
export const ISSUER_PATTERN =
  /^(?:https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?)$/;
/** The longest issuer the contract accepts. */
export const ISSUER_MAX_LENGTH = 255;
/** The contract's subject rule. */
export const SUBJECT_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Whether `issuer` is an origin a subject may come from, under the contract's rule. */
export function isIssuerOrigin(issuer: string): boolean {
  if (issuer.length > ISSUER_MAX_LENGTH || !ISSUER_PATTERN.test(issuer)) return false;
  try {
    return new URL(issuer).origin === issuer;
  } catch {
    return false;
  }
}

/** Whether a vendor-reported subject is well formed; a sign-in with any other one is refused. */
export function isValidSubject(subject: GatekeeperSubject): boolean {
  return isIssuerOrigin(subject.issuer) && SUBJECT_PATTERN.test(subject.subject);
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

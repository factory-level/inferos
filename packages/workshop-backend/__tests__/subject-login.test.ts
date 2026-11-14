// Sign-in by stable subject (FAC-214): a `providesSubject` vendor's sign-in names the account by the
// subject alone. These are the kernel half of FAC-214's auth acceptance suite; the InferLab
// gatekeeper's half is in packages/gatekeeper-inferlab.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LoginConnectCallbackImpl, PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import {
  ISSUER_MAX_LENGTH, ISSUER_PATTERN, isValidSubject, subjectAccountName,
} from "../src/account-subject.js";
import type { FakeSignInAccount } from "./test-worker.js";
import { getAuthGatekeeperIssuer, parseAuthGatekeeperIssuers } from "../src/auth/config.js";
// The InferLab cross-product contract fixtures, pinned from inferops (scripts/inferlab-contracts).
import subjectFixtures from "../../../scripts/inferlab-contracts/fixtures/inferlab.stable-subject.v1.json";
import itemFixtures from "../../../scripts/inferlab-contracts/fixtures/inferlab.attention-item.v1.json";
import issuerSchema from "../../../scripts/inferlab-contracts/schemas/inferlab.stable-subject.v1.schema.json";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Exports = {
  FakeSignInAccount(options: { props: { email?: string; issuer?: string; subject?: string } })
    : Fetcher<FakeSignInAccount>;
  TestSubjectLoginCallback(options: { props: { pendingId: string; vendorId: string; subject?: boolean } })
    : Fetcher<LoginConnectCallbackImpl>;
};

const ISSUER = "http://localhost:23380";
let counter = 0;

/**
 * Runs one sign-in through the real callback, as startGatekeeperLogin() wires it for a
 * `providesSubject` vendor, and answers the session token's account name, or the failure.
 */
async function signIn(props: { email?: string; issuer?: string; subject?: string },
                      vendorId = "inferlab"): Promise<string> {
  const pending = env.TEST_PENDING_LOGIN.getByName(`subject-login-${++counter}`);
  await pending.begin();
  // A callback entrypoint is reachable from a test only through a DO's ctx.exports.
  const host = env.TEST_USER.getByName(`subject-login-host-${counter}`);
  const ticket = await runInDurableObject(host, async (instance: UserDurableObject) => {
    const exports = (instance as unknown as { ctx: { exports: Exports } }).ctx.exports;
    const callback = exports.TestSubjectLoginCallback({
      props: { pendingId: pending.id.toString(), vendorId, subject: true },
    });
    const handoff = await callback.complete(exports.FakeSignInAccount({ props }));
    return handoff.ticket;
  });
  try {
    await pending.confirm(ticket);
    const token = await pending.receive();
    return token === null ? "null" : token.split(":")[0]!;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

const profileOf = (name: string) =>
  runInDurableObject(env.TEST_USER.getByName(name), async (instance: UserDurableObject) =>
    (instance as unknown as { storage: { profile: { get(): { id: string; name: string } } } })
      .storage.profile.get());

/** An https origin exactly `length` characters long. */
const originOfLength = (length: number) => `https://${"a".repeat(length - "https://".length)}`;

describe("sign-in by stable subject", () => {
  it("keys the account on the issuer and subject, never the email", async () => {
    const name = await signIn({ email: "ann@acme.test", issuer: ISSUER, subject: "principal-ann-1" });
    expect(name).toBe(subjectAccountName({ issuer: ISSUER, subject: "principal-ann-1" }));
    expect(name).toBe("subject~http%3A%2F%2Flocalhost%3A23380~principal-ann-1");
    expect(await profileOf(name)).toMatchObject({ id: name, name: "ann" });
  });

  it("keeps the same account when the email changes", async () => {
    const first = await signIn({ email: "bea@acme.test", issuer: ISSUER, subject: "principal-bea" });
    const second = await signIn({ email: "bea.new@acme.test", issuer: ISSUER, subject: "principal-bea" });
    expect(second).toBe(first);
    // The display name is the person's from first sign-in; a new address doesn't overwrite it.
    expect(await profileOf(second)).toMatchObject({ id: first, name: "bea" });
  });

  it("never merges two subjects that share an email", async () => {
    const one = await signIn({ email: "shared@acme.test", issuer: ISSUER, subject: "principal-c1" });
    const two = await signIn({ email: "shared@acme.test", issuer: ISSUER, subject: "principal-c2" });
    expect(one).not.toBe(two);
    expect(one.startsWith("subject~") && two.startsWith("subject~")).toBe(true);
  });

  it("refuses a subject from an issuer the deployment doesn't trust for this vendor", async () => {
    // A gatekeeper reporting another provider's issuer can't sign in that provider's people,
    // even with a well-formed subject. `other`'s issuer is configured, but not for `inferlab`.
    for (const issuer of ["https://other.example.test", "https://auth.example.test", "http://localhost:9999"]) {
      expect(await signIn({ issuer, subject: "principal-d" }), issuer).toBe(
        "error:This sign-in came from an identity provider this deployment doesn't trust.");
    }
  });

  it("refuses every subject through a vendor with no configured issuer", async () => {
    expect(await signIn({ issuer: ISSUER, subject: "principal-g" }, "unconfigured")).toBe(
      'error:Sign-in is off: AUTH_GATEKEEPER_ISSUERS has no entry for "unconfigured", so it can\'t sign anyone in.');
  });

  it("signs in without an email, naming the person generically", async () => {
    const name = await signIn({ issuer: ISSUER, subject: "principal-e" });
    expect(await profileOf(name)).toMatchObject({ id: name, name: "New user" });
  });

  it.each([
    ["no subject at all", { email: "f@acme.test" }],
    ["an issuer with a path", { issuer: `${ISSUER}/login`, subject: "p" }],
    ["plain http off loopback", { issuer: "http://auth.example.test", subject: "p" }],
    ["a subject with a space", { issuer: ISSUER, subject: "a b" }],
    ["a non-ASCII subject", { issuer: ISSUER, subject: "pé" }],
    ["an empty subject", { issuer: ISSUER, subject: "" }],
  ])("refuses a sign-in with %s, and never falls back to the email", async (_why, props) => {
    expect(await signIn(props)).toBe(
      "error:This account has no stable identity, so it can't be used to sign in.");
  });
});

describe("the InferLab contract (inferlab.stable-subject v1)", () => {
  it("names every contract subject exactly as InferOps' subjectKey does", () => {
    // InferOps wrote each item's key as `${subjectKey(recipient)}|${event}|${reason}`.
    for (const { value } of itemFixtures.valid) {
      expect(`${subjectAccountName(value.recipient)}|${value.sourceEventId}|${value.reason}`)
        .toBe(value.itemKey);
    }
  });

  it("accepts every valid contract subject and refuses every invalid one the kernel can check", () => {
    for (const { value } of subjectFixtures.valid) {
      expect(isValidSubject(value as { issuer: string; subject: string })).toBe(true);
    }
    for (const { name, value } of subjectFixtures.invalid) {
      const subject = value as { issuer?: unknown; subject?: unknown };
      const wellTyped = typeof subject.issuer === "string" && typeof subject.subject === "string";
      expect(wellTyped && isValidSubject(subject as { issuer: string; subject: string }), name).toBe(false);
    }
  });
});

describe("subjectAccountName", () => {
  it("can't collide by running the issuer and subject together", () => {
    expect(subjectAccountName({ issuer: "https://a.test", subject: "x~y" }))
      .not.toBe(subjectAccountName({ issuer: "https://a.test", subject: "x%7Ey" }));
  });

  it("holds no character a session token or a password username uses", () => {
    const name = subjectAccountName({ issuer: "https://a.test", subject: "u:v@w" });
    expect(name).not.toMatch(/[:@]/);
    expect(name).not.toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("applies the contract's issuer rule exactly: the pattern is the pinned schema's, and 255 is the cap", () => {
    const schema = issuerSchema as { properties: { issuer: { pattern: string; maxLength: number } } };
    expect(ISSUER_PATTERN.source).toBe(schema.properties.issuer.pattern);
    expect(ISSUER_MAX_LENGTH).toBe(schema.properties.issuer.maxLength);
    expect(originOfLength(255)).toHaveLength(255);
    expect(isValidSubject({ issuer: originOfLength(255), subject: "x" })).toBe(true);
    expect(isValidSubject({ issuer: originOfLength(256), subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://auth.example.", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://auth.example.test.", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://-auth.example.test", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://Auth.example.test", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://auth.example.test:443", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "http://127.0.0.1:8080", subject: "x" })).toBe(true);
    expect(isValidSubject({ issuer: "http://[::1]:8080", subject: "x" })).toBe(true);
  });

  it("accepts only well-formed subjects", () => {
    expect(isValidSubject({ issuer: "https://a.test", subject: "x" })).toBe(true);
    expect(isValidSubject({ issuer: "https://a.test/", subject: "x" })).toBe(false);
    expect(isValidSubject({ issuer: "https://a.test", subject: "x".repeat(256) })).toBe(false);
  });
});

/** The parsed setting as a plain object, or its error. */
function issuersOf(raw: string | undefined) {
  const parsed = parseAuthGatekeeperIssuers(raw);
  return "error" in parsed ? parsed : Object.fromEntries(parsed.issuers);
}

describe("AUTH_GATEKEEPER_ISSUERS", () => {

  it("parses a valid list, trimming around each entry", () => {
    expect(issuersOf("inferlab=https://auth.inferops.io, other=http://localhost:23380")).toEqual({
      inferlab: "https://auth.inferops.io", other: "http://localhost:23380",
    });
    expect(issuersOf(undefined)).toEqual({});
    expect(issuersOf("  ")).toEqual({});
  });

  it.each([
    ["an empty item", "inferlab=https://a.test,", "AUTH_GATEKEEPER_ISSUERS entry 2 is empty."],
    ["an empty item in the middle", "inferlab=https://a.test,,x=https://b.test", "AUTH_GATEKEEPER_ISSUERS entry 2 is empty."],
    ["a missing =", "inferlab https://a.test", 'AUTH_GATEKEEPER_ISSUERS entry 1 has no "=" (expected <vendor id>=<origin>).'],
    ["an empty vendor id", "=https://a.test", "AUTH_GATEKEEPER_ISSUERS entry 1 has no valid vendor id."],
    ["a vendor id with a space", "infer lab=https://a.test", "AUTH_GATEKEEPER_ISSUERS entry 1 has no valid vendor id."],
    ["whitespace inside the origin", "inferlab=https://a .test", 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") has whitespace in its origin.'],
    ["an origin with a path", "inferlab=https://a.test/x", 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.'],
    ["an origin with a trailing dot", "inferlab=https://a.test.", 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.'],
    ["plain http off loopback", "inferlab=http://a.test", 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.'],
    ["an origin over 255 characters", `inferlab=${originOfLength(256)}`, 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.'],
    ["an empty origin", "inferlab=", 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.'],
    ["a duplicate vendor, both origins valid", "inferlab=https://evil.example,inferlab=https://auth.inferops.io", 'AUTH_GATEKEEPER_ISSUERS entry 2 ("inferlab") names a vendor an earlier entry already names.'],
    ["a duplicate vendor differing only in case", "inferlab=https://a.test,InferLab=https://a.test", 'AUTH_GATEKEEPER_ISSUERS entry 2 ("inferlab") names a vendor an earlier entry already names.'],
  ])("refuses the whole setting for %s", (_why, raw, error) => {
    expect(parseAuthGatekeeperIssuers(raw)).toEqual({ error });
    // ...so every vendor is refused, the valid ones included.
    expect(getAuthGatekeeperIssuer({ AUTH_GATEKEEPER_ISSUERS: raw } as unknown as Cloudflare.Env, "inferlab"))
      .toEqual({ error });
  });

  it.each([
    ["the Kelvin sign", "\u212Aey"],
    ["a Turkish dotted capital I", "\u0130nferlab"],
    ["a Turkish dotless i", "\u0131nferlab"],
    ["fullwidth letters", "\uFF49\uFF4E\uFF46\uFF45\uFF52\uFF4C\uFF41\uFF42"],
    ["a combining character", "infe\u0301rlab"],
    ["a non-breaking space inside", "infer\u00A0lab"],
  ])("refuses a vendor id with %s, before any case folding", (_why, vendor) => {
    expect(parseAuthGatekeeperIssuers(`${vendor}=https://a.test`))
      .toEqual({ error: "AUTH_GATEKEEPER_ISSUERS entry 1 has no valid vendor id." });
    // ...and a lookup by such an id finds nothing, even for the vendor it folds to.
    expect(getAuthGatekeeperIssuer(
      { AUTH_GATEKEEPER_ISSUERS: "key=https://a.test,inferlab=https://a.test" } as unknown as Cloudflare.Env,
      vendor,
    )).toEqual({ error: "AUTH_GATEKEEPER_ISSUERS can't be looked up for a vendor id that isn't ASCII." });
  });

  it("still matches an ASCII vendor id in any case", () => {
    const mixedCase = { AUTH_GATEKEEPER_ISSUERS: "InferLab=https://auth.inferops.io" } as unknown as Cloudflare.Env;
    expect(issuersOf("InferLab=https://auth.inferops.io")).toEqual({ inferlab: "https://auth.inferops.io" });
    expect(getAuthGatekeeperIssuer(mixedCase, "inferlab")).toEqual({ issuer: "https://auth.inferops.io" });
    expect(getAuthGatekeeperIssuer(mixedCase, "INFERLAB")).toEqual({ issuer: "https://auth.inferops.io" });
  });

  it("refuses an issuer origin with a non-ASCII look-alike, whatever it would fold to", () => {
    expect(parseAuthGatekeeperIssuers("inferlab=https://\u212Aey.test")).toEqual({
      error: 'AUTH_GATEKEEPER_ISSUERS entry 1 ("inferlab") isn\'t an https origin (or an http loopback origin) of at most 255 characters.',
    });
  });

  it("never echoes an entry's value in its error", () => {
    const parsed = parseAuthGatekeeperIssuers("inferlab=https://secret-host.example/x");
    expect("error" in parsed && parsed.error).not.toContain("secret-host");
  });
});

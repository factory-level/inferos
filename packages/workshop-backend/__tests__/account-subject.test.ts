// A person's account keyed on their provider's stable subject, not their email (ADR 0018, FAC-165).
// Through the real login callback, user DO and directory: an email change keeps the account; a
// second person who takes over the first person's old address gets a new, empty account and can't
// reach the old one by any email-keyed sign-in; binding happens once, and only for the account's
// own person; the one-off pass binds what connections already prove, and running it twice binds
// nothing new. Every subject and address is fresh per test: the directory is one shared object.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LoginConnectCallbackImpl, PendingLogin } from "../src/auth/login-flow.js";
import type { UserDurableObject } from "../src/user.js";
import { SIGNS_IN_THROUGH_SUBJECT } from "../src/user.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
import { bindAccountSubjects, collaboratorAccountName, resolveSubjectAccount, subjectAccountName } from "../src/account-subject.js";
import type { FakeSubjectAccount } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_PENDING_LOGIN: DurableObjectNamespace<PendingLogin>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

type Exports = {
  FakeSubjectAccount(options: { props: { issuer: string; subject: string | null; email?: string } }): Fetcher<FakeSubjectAccount>;
  TestLoginCallback(options: { props: { pendingId: string; vendorId: string; subject?: boolean } }): Fetcher<LoginConnectCallbackImpl>;
};
// What a test reaches into a user DO for.
type Internals = {
  ctx: DurableObjectState & { exports: Exports };
  storage: {
    connectedAccounts: { put(record: unknown): void };
    nextAccountId: { put(n: number): void };
    passwordHashHash: { put(hash: Uint8Array): void };
  };
};

const ISSUER = "https://auth.example.test";
const fresh = () => crypto.randomUUID().slice(0, 8);
const subjectName = (subject: string) => subjectAccountName({ issuer: ISSUER, subject });

const internals = (instance: UserDurableObject) => instance as unknown as Internals;
/** The namespaces the login flow reaches, as the test binds them. */
const NS = () => ({ users: env.TEST_USER, directory: env.TEST_USER_DIRECTORY });

/**
 * Signs in through the real callback as InferOps would: a vendor that yields a subject. Returns the
 * account name the session token names, or `error:<message>` when the sign-in was refused.
 */
async function signIn(subject: string | null, email?: string): Promise<string> {
  const pending = env.TEST_PENDING_LOGIN.getByName(`subject-login-${fresh()}`);
  await pending.begin();
  // The callback and account entrypoints are reached only through a DO's own exports.
  let ticket = "";
  await runInDurableObject(env.TEST_USER.getByName(`host-${fresh()}`), async (instance: UserDurableObject) => {
    const exports = internals(instance).ctx.exports;
    const callback = exports.TestLoginCallback({ props: { pendingId: pending.id.toString(), vendorId: "inferops", subject: true } });
    const account = exports.FakeSubjectAccount({ props: { issuer: ISSUER, subject, ...(email ? { email } : {}) } });
    ({ ticket } = await callback.complete(account as never));
  });
  try {
    await pending.confirm(ticket);
    const token = await pending.receive();
    return token!.slice(0, token!.lastIndexOf(":"));
  } catch (error) {
    return `error:${(error as Error).message}`;
  }
}

/** An email-keyed account as gatekeeper sign-in made one before ADR 0018. */
async function legacyAccount(email: string): Promise<DurableObjectStub<UserDurableObject>> {
  const user = env.TEST_USER.getByName(email);
  expect(await user.loginOrCreateViaGatekeeper(email, true)).not.toBeNull();
  return user;
}

const profileOf = async (name: string) => (await env.TEST_USER.getByName(name).whoamiIfExists())?.id ?? null;

describe("a sign-in keyed on the stable subject (ADR 0018)", () => {
  it("keeps the same account across an email change, with no manual step (acceptance 1)", async () => {
    const [a, newAddress] = [`ada-${fresh()}@example.test`, `ada.lovelace-${fresh()}@example.test`];
    const legacy = await legacyAccount(a);
    const principal = fresh();
    // The first sign-in after this lands binds the account to the principal behind it.
    expect(await signIn(principal, a)).toBe(a);
    expect(await legacy.isSubjectBound()).toBe(true);
    // The email changes in InferOps, which then vouches for the new one, or for none at all.
    expect(await signIn(principal, newAddress)).toBe(a);
    expect(await signIn(principal)).toBe(a);
    expect(await profileOf(a)).toBe(a);
  });

  it("gives a new person a new account named by their subject, and the same one each time", async () => {
    const principal = fresh();
    const email = `new-${fresh()}@example.test`;
    expect(await signIn(principal, email)).toBe(subjectName(principal));
    expect(await signIn(principal)).toBe(subjectName(principal));
    expect(await profileOf(subjectName(principal))).toBe(subjectName(principal));
    // No email-keyed account was made for the address.
    expect(await profileOf(email)).toBeNull();
  });

  it("refuses a sign-in with no person behind it", async () => {
    expect(await signIn(null, `nobody-${fresh()}@example.test`)).toBe("error:This account has no person behind it, so it can't be used to sign in.");
  });
});

describe("a subject's account name", () => {
  it("can't be an email, a username or another subject's, and keeps the token's shape", () => {
    const name = subjectAccountName({ issuer: "https://a~b.test", subject: "c" });
    expect(name).not.toBe(subjectAccountName({ issuer: "https://a", subject: "b.test~c" }));
    for (const forged of [name, subjectAccountName({ issuer: "https://x@y:z", subject: "u:1@v" })]) {
      expect(forged).not.toMatch(/[@:]/);
      expect(forged.split("~")).toHaveLength(3);
    }
  });
});

describe("taking over someone's old address (acceptance 2)", () => {
  it("gives the second person a new, empty account, and the old one refuses every email-keyed sign-in", async () => {
    const old = `grace-${fresh()}@example.test`;
    const legacy = await legacyAccount(old);
    const [first, second] = [fresh(), fresh()];
    expect(await signIn(first, old)).toBe(old);
    // The first person moves on; InferOps later vouches the old address for someone else.
    expect(await signIn(first, `grace.hopper-${fresh()}@example.test`)).toBe(old);
    expect(await signIn(second, old)).toBe(subjectName(second));
    expect(await profileOf(subjectName(second))).toBe(subjectName(second));
    // Every email-keyed way into the old account is closed to whoever holds the address now.
    // Caught on the call itself: `rejects` leaves the RPC promise's rejection reported as unhandled.
    const refusal = (call: Promise<unknown>) => call.then(() => "signed in", (error: Error) => error.message);
    expect(await refusal(legacy.loginOrCreateViaGatekeeper(old, true))).toBe(SIGNS_IN_THROUGH_SUBJECT);
    expect(await refusal(legacy.authenticateFromCfAccess(old, true))).toBe(SIGNS_IN_THROUGH_SUBJECT);
    // And the first person still has it.
    expect(await signIn(first)).toBe(old);
  });

  it("refuses to bind an account for an address the provider doesn't vouch for, or a password account", async () => {
    const unvouched = `unvouched-${fresh()}@example.test`;
    const legacy = await legacyAccount(unvouched);
    const principal = fresh();
    // InferOps doesn't vouch for the address: the sign-in gets its own account, the old one stays unbound.
    expect(await signIn(principal)).toBe(subjectName(principal));
    expect(await legacy.isSubjectBound()).toBe(false);

    const withPassword = `pw-${fresh()}@example.test`;
    const passwordAccount = await legacyAccount(withPassword);
    await runInDurableObject(passwordAccount, async (instance: UserDurableObject) => {
      internals(instance).storage.passwordHashHash.put(new Uint8Array(32));
    });
    expect(await passwordAccount.bindSubject(subjectName(fresh()))).toBe("password");
    const other = fresh();
    expect(await signIn(other, withPassword)).toBe(subjectName(other));
    expect(await passwordAccount.isSubjectBound()).toBe(false);
  });

  it("binds once: another subject can't take a bound account, and binding the same one again changes nothing", async () => {
    const email = `once-${fresh()}@example.test`;
    const legacy = await legacyAccount(email);
    const [mine, theirs] = [subjectName(fresh()), subjectName(fresh())];
    expect(await legacy.bindSubject(mine)).toBe("bound");
    expect(await legacy.bindSubject(mine)).toBe("bound");
    expect(await legacy.bindSubject(theirs)).toBe("bound-elsewhere");
    expect(await env.TEST_USER.getByName(`absent-${fresh()}@example.test`).bindSubject(mine)).toBe("absent");
  });
});

describe("two first sign-ins for one subject at once (FAC-165 round 1)", () => {
  it("bind exactly one account, whatever their vouched addresses, and both sign in to it", async () => {
    const [first, second] = [`race-a-${fresh()}@example.test`, `race-b-${fresh()}@example.test`];
    await legacyAccount(first);
    await legacyAccount(second);
    const subject = subjectName(fresh());
    // Each bind waits until both sign-ins have reached one, so both are past the directory's
    // check before either binds: the overlap is forced, not left to timing.
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>(resolve => (release = resolve));
    const users = {
      idFromName: (name: string) => env.TEST_USER.idFromName(name),
      get(id: DurableObjectId) {
        const user = env.TEST_USER.get(id);
        return {
          bindSubject: async (name: string) => {
            if (++arrived === 2) release();
            await Promise.race([bothArrived, new Promise(resolve => setTimeout(resolve, 1000))]);
            return user.bindSubject(name);
          },
        };
      },
    } as unknown as DurableObjectNamespace<UserDurableObject>;
    const ns = { users, directory: env.TEST_USER_DIRECTORY };
    const names = await Promise.all([
      resolveSubjectAccount(ns, subject, first),
      resolveSubjectAccount(ns, subject, second),
    ]);
    expect(arrived).toBe(2);
    expect(names[0]).toBe(names[1]);
    const bound = [await env.TEST_USER.getByName(first).isSubjectBound(),
                   await env.TEST_USER.getByName(second).isSubjectBound()];
    expect(bound.filter(Boolean)).toHaveLength(1);
    expect(names[0]).toBe(bound[0] ? first : second);
    // Both sign-ins then land in that one account, and the other stays reachable by its address.
    for (const email of [first, second]) {
      expect(await env.TEST_USER.getByName(names[0]!).loginOrCreateViaSubject(names[0]!, subject, email, true))
        .not.toBeNull();
    }
    expect(await collaboratorAccountName(NS(), bound[0] ? second : first)).toBe(bound[0] ? second : first);
  });

  it("settles a sign-in that stopped between claiming and binding: the next one binds that account", async () => {
    const [first, second] = [`stop-a-${fresh()}@example.test`, `stop-b-${fresh()}@example.test`];
    await legacyAccount(first);
    await legacyAccount(second);
    const subject = subjectName(fresh());
    // The first sign-in claimed its account, then stopped before binding it.
    const directory = env.TEST_USER_DIRECTORY.getByName("");
    expect(await directory.claimSubject(subject, first)).toBe(first);
    expect(await env.TEST_USER.getByName(first).isSubjectBound()).toBe(false);
    // A later sign-in, even with another address, binds the claimed account and signs in to it.
    expect(await resolveSubjectAccount(NS(), subject, second)).toBe(first);
    expect(await env.TEST_USER.getByName(first).isSubjectBound()).toBe(true);
    expect(await env.TEST_USER.getByName(second).isSubjectBound()).toBe(false);
  });

  it("agrees with a sign-in that finished while another's first answer was still on its way", async () => {
    const [late, early] = [`late-${fresh()}@example.test`, `early-${fresh()}@example.test`];
    await legacyAccount(late);
    await legacyAccount(early);
    const subject = subjectName(fresh());
    // The late sign-in's first directory answer is held until the early sign-in has finished:
    // whatever the late one asked first, it acts on an answer from before the early one ran.
    let earlyDone!: () => void;
    const finished = new Promise<void>(resolve => (earlyDone = resolve));
    let held = false;
    const real = env.TEST_USER_DIRECTORY.getByName("");
    const slowDirectory = {
      getByName: () => new Proxy(real, {
        get(target, key) {
          const stub = target as unknown as Record<string | symbol, (...a: unknown[]) => Promise<unknown>>;
          if (typeof key !== "string" || key === "then") return stub[key];
          // An RPC stub's method is called through the stub itself, never with `apply`.
          return async (...args: unknown[]) => {
            const answer = await stub[key]!(...args);
            if (!held) {
              held = true;
              await finished;
            }
            return answer;
          };
        },
      }),
    } as unknown as DurableObjectNamespace<UserDirectoryDurableObject>;
    const lateName = resolveSubjectAccount({ users: env.TEST_USER, directory: slowDirectory }, subject, late);
    const earlyName = await resolveSubjectAccount(NS(), subject, early);
    earlyDone();
    expect(await lateName).toBe(earlyName);
    const bound = [await env.TEST_USER.getByName(late).isSubjectBound(),
                   await env.TEST_USER.getByName(early).isSubjectBound()];
    expect(bound.filter(Boolean)).toHaveLength(1);
    expect(await real.accountForSubject(subject)).toBe(earlyName);
  });
});

describe("an address with capitals (FAC-165 round 1)", () => {
  it("binds the account it named, exactly as the provider gave it, and finds it by any case", async () => {
    const email = `Mixed-${fresh()}@Example.Test`;
    await legacyAccount(email);
    const subject = fresh();
    expect(await signIn(subject, email)).toBe(email);
    expect(await env.TEST_USER.getByName(email).isSubjectBound()).toBe(true);
    expect(await signIn(subject, email)).toBe(email);
    expect(await collaboratorAccountName(NS(), email.toLowerCase())).toBe(email);
  });
});

describe("finding a person by address (shares never follow an email)", () => {
  it("finds an address's current, vouched owner, and never a bound account by its old address", async () => {
    const old = `share-${fresh()}@example.test`;
    await legacyAccount(old);
    const ns = async () => NS();
    // Before anyone signs in with a subject, the address names its email-keyed account.
    expect(await collaboratorAccountName(await ns(), old)).toBe(old);
    const [first, second] = [fresh(), fresh()];
    const moved = `share.moved-${fresh()}@example.test`;
    expect(await signIn(first, old)).toBe(old);
    expect(await signIn(first, moved)).toBe(old);
    // The first person's address is now `moved`; the old one finds nobody until someone holds it.
    expect(await collaboratorAccountName(await ns(), moved)).toBe(old);
    expect(await collaboratorAccountName(await ns(), old)).toBeNull();
    expect(await signIn(second, old)).toBe(subjectName(second));
    expect(await collaboratorAccountName(await ns(), old)).toBe(subjectName(second));
    // A name that isn't an address names its account as before.
    expect(await collaboratorAccountName(await ns(), "a_username")).toBe("a_username");
  });
});

describe("the one-off subject pass (acceptance 3)", () => {
  it("binds an account from its own connection, creates no account, and binds nothing new on a second run", async () => {
    const vendorId = `inferops-pass-${fresh()}`;
    const email = `pass-${fresh()}@example.test`;
    const principal = fresh();
    const legacy = await legacyAccount(email);
    // Lists it in the directory, as any authentication does.
    await legacy.authenticate((await legacy.loginOrCreateViaGatekeeper(email, true))!);
    await runInDurableObject(legacy, async (instance: UserDurableObject) => {
      const user = instance as Internals;
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, vendorId, description: { displayName: "InferOps" },
        account: user.ctx.exports.FakeSubjectAccount({ props: { issuer: ISSUER, subject: principal, email } }),
      });
    });
    // A connection vouching another address proves nothing about this account.
    const elsewhere = `pass-other-${fresh()}@example.test`;
    const other = await legacyAccount(elsewhere);
    await other.authenticate((await other.loginOrCreateViaGatekeeper(elsewhere, true))!);
    await runInDurableObject(other, async (instance: UserDurableObject) => {
      const user = instance as Internals;
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, vendorId, description: { displayName: "InferOps" },
        account: user.ctx.exports.FakeSubjectAccount({ props: { issuer: ISSUER, subject: fresh(), email: `someone-${fresh()}@example.test` } }),
      });
    });

    const ns = NS();
    const first = await bindAccountSubjects(ns, vendorId);
    expect(first.bound).toBe(1);
    expect(first.conflicts).toBe(0);
    expect(await legacy.isSubjectBound()).toBe(true);
    expect(await other.isSubjectBound()).toBe(false);
    const second = await bindAccountSubjects(ns, vendorId);
    expect(second.bound).toBe(0);
    expect(second.alreadyBound).toBe(1);
    // The person's next sign-in reaches the account the pass bound, without vouching an address.
    expect(await signIn(principal)).toBe(email);
    // No account was made for the subject itself.
    expect(await profileOf(subjectName(principal))).toBeNull();
  });

  it("leaves an account unbound when its subject already signs in to another account", async () => {
    const vendorId = `inferops-pass-${fresh()}`;
    const principal = fresh();
    // The person signed in before the pass without a vouched address, so they have their own account.
    expect(await signIn(principal)).toBe(subjectName(principal));
    const email = `pass-conflict-${fresh()}@example.test`;
    const legacy = await legacyAccount(email);
    await legacy.authenticate((await legacy.loginOrCreateViaGatekeeper(email, true))!);
    await runInDurableObject(legacy, async (instance: UserDurableObject) => {
      const user = instance as Internals;
      user.storage.nextAccountId.put(1);
      user.storage.connectedAccounts.put({
        id: 0, vendorId, description: { displayName: "InferOps" },
        account: user.ctx.exports.FakeSubjectAccount({ props: { issuer: ISSUER, subject: principal, email } }),
      });
    });
    const ns = NS();
    const result = await bindAccountSubjects(ns, vendorId);
    expect(result.conflicts).toBeGreaterThanOrEqual(1);
    // Not stranded: still unbound, so its own email-keyed sign-in still reaches it.
    expect(await legacy.isSubjectBound()).toBe(false);
    expect(await legacy.loginOrCreateViaGatekeeper(email, true)).not.toBeNull();
  });
});

// A person's account keyed on their provider's stable subject, not their email (ADR 0018, FAC-165).
// A sign-in that carries a subject finds the account through the directory's subject index; an
// existing email-keyed account is bound to its subject once, and only by its own person; a bound
// account then signs in only through its subject.
import type { AccountSubjectPass } from "@gadgets/workshop-shared/api";
import type { GatekeeperSubject } from "@gadgets/workshop-shared/gatekeeper";
import type { UserDirectoryDurableObject } from "./user-directory";
import type { UserDurableObject } from "./user";

/**
 * The account name a subject keys: `subject~<issuer>~<subject>`, each part URI-encoded with `~`
 * encoded too, so the two parts can't run together and no two subjects share a name. It holds no
 * `@`, so no email names it, no `:`, so the `<name>:<secret>` session token still splits, and a `~`,
 * which no password username (`[a-z][a-z0-9_]*`) holds.
 */
export function subjectAccountName(subject: GatekeeperSubject): string {
  return `subject~${encodePart(subject.issuer)}~${encodePart(subject.subject)}`;
}

const encodePart = (part: string) => encodeURIComponent(part).replaceAll("~", "%7E");

/** Whether `name` is one `subjectAccountName` gives. */
export function isSubjectAccountName(name: string): boolean {
  return name.startsWith("subject~");
}

/** What `UserDurableObject.bindSubject` says of an email-keyed account asked to bind a subject. */
export type SubjectBinding = "bound" | "bound-elsewhere" | "password" | "absent";

type Namespaces = {
  users: DurableObjectNamespace<UserDurableObject>;
  directory: DurableObjectNamespace<UserDirectoryDurableObject>;
};

/**
 * The name of the account `subject` signs in to (ADR 0018 decisions 2 and 3): the account the vouched
 * `email` names, when that account binds to it (an existing gatekeeper account, not bound to another
 * subject, not a password account); else a new account named by the subject. Writes no account
 * itself: the caller's sign-in creates a new one.
 *
 * One atomic directory step decides it, with no read before it: the first sign-in's candidate (its
 * vouched address, or the subject's own name) is claimed set-if-unset, and the claim is the mapping.
 * Every sign-in for the subject then settles that one winner: it binds the winner (set-if-unset,
 * `bound` again for the same subject, so they all agree), never its own candidate, so no second
 * account is ever bound; a winner that can't bind is moved, compare-and-set, to the subject's own
 * name. A sign-in that stopped between the claim and the bind is settled by the next one.
 */
export async function resolveSubjectAccount(ns: Namespaces, subject: string, email: string | null): Promise<string> {
  const directory = ns.directory.getByName("");
  const winner = await directory.claimSubject(subject, email ?? subject);
  if (winner === subject || !winner.includes("@")) return winner;
  const legacy = ns.users.get(ns.users.idFromName(winner));
  if (await legacy.bindSubject(subject) === "bound") return winner;
  return directory.moveSubject(subject, winner, subject);
}

/**
 * The account a person is added by (ADR 0018 decision 6): an address finds the account it is the
 * current vouched address of; failing that, the account it names, unless that account is bound to a
 * subject, whose old name never finds it. Any other name (a username, a subject's account name)
 * names its account. Null when nothing is found. Only the name is returned; the caller reads the
 * profile, and a share then stores the account, never the address.
 */
export async function collaboratorAccountName(ns: Namespaces, name: string): Promise<string | null> {
  if (!name.includes("@")) return name;
  const current = await ns.directory.getByName("").accountForEmail(name);
  if (current !== null) return current;
  const named = ns.users.get(ns.users.idFromName(name));
  return await named.isSubjectBound() ? null : name;
}

/**
 * The one-off subject pass (ADR 0018 decision 7): for each email-keyed account the directory lists,
 * the subject its own `vendorId` connection names (`UserDurableObject.subjectFromConnections`) is
 * bound, unless the directory already sends that subject to another account (a conflict, left
 * unbound, so no account is stranded). Binding is set-if-unset on the account, then recorded; it
 * creates no account, and a second run binds nothing new. Nothing happens without a vendor.
 */
export async function bindAccountSubjects(ns: Namespaces, vendorId: string | null): Promise<AccountSubjectPass> {
  const result: AccountSubjectPass = { checked: 0, bound: 0, alreadyBound: 0, conflicts: 0 };
  if (!vendorId) return result;
  const directory = ns.directory.getByName("");
  for (const id of await directory.listUserIds()) {
    if (!id.includes("@")) continue;
    result.checked++;
    const user = ns.users.get(ns.users.idFromName(id));
    const wasBound = await user.isSubjectBound();
    const subject = await user.subjectFromConnections(vendorId);
    if (subject === null) continue;
    // As for a sign-in, the subject is claimed for this account in one step before it is bound, so
    // a pass racing a first sign-in with another address never binds a second account. One that
    // claimed it but can't bind is moved to the subject's own name, as a sign-in would.
    if (await directory.claimSubject(subject, id) !== id) {
      result.conflicts++;
      continue;
    }
    if (await user.bindSubject(subject) !== "bound") {
      await directory.moveSubject(subject, id, subject);
      result.conflicts++;
      continue;
    }
    if (wasBound) result.alreadyBound++;
    else result.bound++;
  }
  return result;
}

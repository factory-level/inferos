---
title: A person's account is keyed on the provider's stable subject, not their email
status: proposed
date: 2026-11-10
---

# 0018. A person's account is keyed on the provider's stable subject, not their email

## Context

The Workshop keys a person's account (their `UserDurableObject`) on a string: the verified email for gatekeeper and Cloudflare Access sign-in, the username for a password account. The account's name is the email:
- the session token is `<name>:<secret>`;
- `profile.id` equals the name, and about a dozen call sites rebuild an account from a `profile.id` with `idFromName`;
- collaborators, share edges, `requestedBy` logs and chat authors store that `profile.id`.

An email is a mutable claim. InferOps keeps a person's principal across an email change: sign-in is linked by provider subject, not by address. The Workshop does not, so a person whose email changes in InferOps gets a new, empty account. Their workspaces stay with an account named by the old address.

The two obvious repairs are:
- **(a)** key accounts on a stable subject;
- **(b)** carry an email change across to the existing account.

(b) needs a trusted "this email changed" signal. The only trustworthy one is the stable subject itself. Without it, an email change can't be told apart from a second person who has acquired the first person's old address. So (b) reduces to (a), with more moving parts.

The InferOps gatekeeper already receives the subject: the token exchange's `user.id` is the InferOps principal id (`exchangeFromTokenResponse` keeps it as `identity.userId`). It is dropped at sign-in, because `GatekeeperUser` exposes only `getAuthenticatedEmail()`. No InferOps change is needed to expose it.

## Decision

Proposed by dev.design on 2026-11-10 for FAC-165, for a person to accept.

1. **A sign-in that has a stable subject keys the account on it.** `GatekeeperUser` gains an optional `getAuthenticatedSubject(): Promise<{ issuer: string; subject: string } | null>`, following the existing optional-method pattern.
   - `issuer` names the identity provider deployment. For InferOps it is the connection's origin, so two InferOps deployments can never share a subject.
   - `subject` is the provider's own stable id (InferOps: the principal id).
   - A gatekeeper that has none returns null or omits the method, and its sign-in is unchanged (email-keyed).
2. **The account is found through a subject index, never by email.** A durable `subject → account` index records the account a subject owns, and is written only by the sign-in that binds it.
   - A new account for a subject is named in a reserved form that no email or username can take. It contains no `@` or `:`; usernames are `[a-z][a-z0-9_]*`. The token keeps its `<name>:<secret>` shape.
   - `profile.id` stays the account's name, so nothing that rebuilds an account from it changes.
3. **An existing email-keyed account is bound to its subject once, and only by its own person.** At a subject-bearing sign-in that finds no account for the subject, the account named by the email is bound when all of these hold:
   - the provider vouches for the email (InferOps: `emailVerified`);
   - the account isn't already bound to another subject;
   - it isn't a password account.

   Otherwise a new account is made for the subject. Binding is set-if-unset in one storage step on the account, then the index is written, so it is idempotent and a second subject can never take it.
4. **A bound account signs in only through its subject.** Once bound, the account refuses email-keyed sign-in (a gatekeeper without a subject, Cloudflare Access) under its old name. So an address that later belongs to someone else reaches nothing.
5. **After the subject is bound, the email is an attribute.** A subject-keyed sign-in may proceed without a vouched email; an email change in InferOps reports `emailVerified: false`. The account's email is then used for display only. An unvouched email is never written to the lookup used to find a person by address.
6. **A share names an account, and never follows an email.**
   - Existing shares already store the account's `profile.id`, so they stay with the person who owned the address when they were made.
   - Adding a collaborator by address resolves the account whose current, vouched email it is (the directory), and falls back to the email-keyed name only for an unbound account.
7. **Migration is lazy, plus a proactive pass for what is already known.**
   - Accounts bind at their next subject-bearing sign-in (decision 3).
   - An account that holds an InferOps connection already stores that principal id. A one-off, idempotent pass binds those accounts from it, ahead of any sign-in.
   - Neither step creates an account, and running either twice binds nothing new.

## Consequences

- Acceptance 1 holds: after an email change, the same subject finds the same account and its workspaces.
- Acceptance 2 holds for every bound account: another person holding the old address gets a new account (decision 3) and can't sign in to the old one (decision 4).
- **An account not yet bound** relies on the provider not reassigning a vouched address to someone else before the owner's next sign-in. The proactive pass (decision 7) narrows that window; the analysis is kept with the work item.
- Password, Google, GitHub and Cloudflare sign-in stay email- or username-keyed until their gatekeepers supply subjects. Their providers have stable ids (`sub`, user id), so each can adopt decision 1 later without a new mechanism.
- A principal is tenant-bound in InferOps, so a person in two companies has two accounts here, as they have two principals there.
- Immutable history, such as commit identities derived from `profile.id`, keeps the name it was written with.

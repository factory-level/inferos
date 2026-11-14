# gatekeeper-inferlab

Sign in to InferOS with an InferLab account (FAC-214). **Sign-in only:** this gatekeeper names the
person and grants nothing. It lists no resources, refuses any connection but `scopes: "auth"`, and
its account refuses every request for access, credentials or configuration. Reading or changing
InferOps data is a separate connection (FAC-235), never this one.

How it fits the Workshop's sign-in: [docs/oauth-signin.md](../../docs/oauth-signin.md#inferlab).

## Configuration

| Setting | Meaning |
| --- | --- |
| `AUTH_GATEKEEPERS` (backend) | Must include `inferlab` for the Workshop to offer it |
| `INFERLAB_AUTH_ORIGIN` | The InferLab central-auth origin, which is also the subjects' issuer. `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]` only. No path, query, fragment or user info |
| `INFEROPS_COMPANY` | The tenant id of the one company this deployment serves. Any other company's session is refused |
| `BASE_URL` | This gatekeeper's public base URL. InferLab must register exactly `<BASE_URL>/oauth` for the `inferos` client |

If either of the first two is missing or malformed, sign-in is off. Every attempt then fails with a
message naming the setting (the values are never shown). There's no default issuer, demo company,
`internal` mode or password fallback.

## What a sign-in keeps

- **Kept:** the subject (`issuer` = `INFERLAB_AUTH_ORIGIN`, `subject` = the InferLab principal id), the
  company, for the check only, and the email, when InferLab vouches for it (`emailVerified: true`).
- **Never kept:** InferLab's access token and refresh token. The refresh token is used once, to end the
  session (`POST /auth/logout`).
- **Accounts:** the Workshop keys the account on the subject (`providesSubject`), never on the email.

## Ledger: what was ported from the archived fork

Donor: `factory-level/inferos` `archive/main-2026-11-14` at `24f5d8852a2291b846f1c12ae6fd5eb6e172e108`,
`custom-gatekeepers/gatekeeper-inferops`. Only sign-in was taken. Everything taken was rewritten
against this tree's kit and re-tested here.

| File here | Donor path at 24f5d885 | Why | What changed |
| --- | --- | --- | --- |
| `src/worker.ts` (`SignInAttempt`) | `src/inferlab-login.ts` (`InferLabLogin`) | The per-attempt object holding the nonces, the PKCE verifier and the callback | Only the `signin` purpose. `connect` and `reconnect` are gone, along with `InferOpsCredentials`, the workspace-slug list and every InferOps API call. The handshake uses the kit's `connect-handshake` (`putInitiation`, `advanceToOAuth`, `claimOAuth`) instead of a hand-rolled flow record. The callback's redirect URI is stored at `begin` and reused at exchange |
| `src/worker.ts` (default `fetch`) | `src/inferlab-login.ts` (`handleInferLabLogin`) | The two browser legs: link → `/authorize`, and `/oauth` | No sign-in proxy (`auth-proxy.ts`). Adds `response_type=code`. Answers 503 with the reason when not configured |
| `src/worker.ts` (`GatekeeperVendor`, `InferLabAccount`) | `src/inferops.ts` (the `GatekeeperVendor` and `InferOpsAccount` entrypoints, among about 6,200 lines of board, Dot, wiki, table and member code) | A vendor and an account that only sign in | Written new, not copied. They implement only what sign-in needs, and the account refuses everything else |
| `src/token.ts` | `src/inferlab-login.ts` (`exchangeCode`, `exchangeFromTokenResponse`, `subjectOf`) and `src/inferops-credentials.ts` (`logoutInferLabSession`) | The code exchange, the response parse and the logout | Keeps only the subject, company and vouched email. The subject must be 1 to 255 printable ASCII characters, as the InferLab contract requires. The access token and workspace list are no longer parsed. No edge header (`edge-header.ts`, cloud-only) |
| `src/config.ts` | `src/inferlab-login.ts` (`inferLabAuthOrigin`) and `src/deployment-company.ts` | Settings that fail closed | `INFEROPS_COMPANY` is **required** and must be a tenant id. The donor's `unset` and `internal` modes, which deferred to InferOps, are removed |
| `packages/workshop-backend/src/account-subject.ts` | `packages/workshop-backend/src/account-subject.ts` | The subject's account name | Only `subjectAccountName` and a subject validator. Dropped: `resolveSubjectAccount` (binding an existing email-keyed account to a subject), `collaboratorAccountName` and `bindAccountSubjects` (the one-off migration pass). The clean baseline has no email-keyed InferLab accounts to migrate, and binding by email is what the acceptance forbids |
| `packages/workshop-backend/src/auth/login-flow.ts` | the same path (`#deliverBySubject`) | Keys the account on the subject | No user-directory subject table, email index or `moveSubject`. The account name is a pure function of the subject, so there's nothing to claim or move |
| `packages/workshop-shared/src/gatekeeper.ts` | the same path (`GatekeeperSubject`, `providesSubject`, `getAuthenticatedSubject`) | The shared types | Same shape, with doc comments |

**Left behind deliberately:**
- the shared-configuration gatekeeper (`SHARED_CONFIGURATION_GATEKEEPER`) and the admin "bind account subjects" card;
- `devLogin.ts`;
- the stopgap bearer;
- `mock-inferops.ts` and the `demo.local` fixtures;
- every Dot, board, table, wiki, member and workflow-policy file.

## Tests

`pnpm --filter @gadgets/gatekeeper-inferlab test:run` runs `__tests__/sign-in.test.ts` in workerd, against InferLab faked at `fetch` (mock mode: no network). It covers:
- the correct and the wrong company;
- no business tools;
- bad config;
- PKCE, state and the exact callback: wrong state, a replayed state, a replayed link, an error callback, and a moved `BASE_URL`;
- the token-response checks.

The kernel half is `packages/workshop-backend/__tests__/subject-login.test.ts`.

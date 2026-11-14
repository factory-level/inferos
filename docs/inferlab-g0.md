# InferLab G0: authentication, native behaviour, clean-fork boundary

Gate G0 of the InferLab Local Business OS demo (FAC-215, BOS-04). G0 is the first gate: the clean
upstream baseline admits the canonical InferLab person, keeps upstream behaviour working, and carries
none of the archived fork's legacy frameworks. This page holds the **AUTH-01 to AUTH-17** checks that
the reset runbook (`docs/wiki/clean-upstream-reset.md` on the archived line) names but never
defines, the record of one live run, the fence audit, and cutover readiness.

How sign-in works: [oauth-signin.md](oauth-signin.md#inferlab) and
`packages/gatekeeper-inferlab/README.md`.

## The run this records

| | |
| --- | --- |
| InferOS | `clean/upstream-2026-11-14` at `12f7e823` (FAC-214 merged), plus this PR's `8243a85c` (dev-server passthrough) and the audit commit |
| InferOps | `develop` at `afa91218`, which contains factory-level/inferops#2678 (`6b8878bb`): the `/gatekeeper/inferlab/oauth` callback |
| Date and host | 2026-11-14, the shared factory host, one live stack held under the stack lock, then stopped |
| Provider mode | **Real local auth.** InferOps central-auth in stub mode (`NODE_CONFIG_ENV=factory`, no secret layer), reserved stub personas, no real provider or credential. The InferLab gatekeeper talked to it over HTTP, not a fake |
| InferOps | API on `http://localhost:24480` (worktree offset 164), its own database `inferlab_164`. `NODE_CONFIG` sets `auth.sso.inferosOrigins` and `auth.sso.inferosCompanies` (the InferOS origin mapped to the grokbot tenant) |
| InferOS | `pnpm run-local --port 9130`, with `AUTH_GATEKEEPERS`, `AUTH_GATEKEEPER_ISSUERS`, `INFERLAB_AUTH_ORIGIN`, `INFEROPS_COMPANY` (the reserved grokbot tenant) and `PUBLIC_BASE_URL` set in that process only |
| Browser | Headless Chromium through Playwright from the `artilleryio/artillery` image, with a trace and screenshots for every scenario |
| Evidence | `/home/factorylevel/inferlab-bos-evidence/FAC-215/` on the host. It holds `browser/` (screenshots, traces, results JSON), `logs/` (central-auth request counts, native suites), `fence-audit.txt`, `auth10-probe.txt`, and the scripts `live-stack.sh`, `restart-os.sh`, `g0-run*.cjs`, `seat.cjs` and `probe.cjs`. The traces hold throwaway local session data; they stay on the host and aren't attached |

## AUTH-01 to AUTH-17

Each check has an id, what to do, the expected result and how it ran. "Live" means against the
running stack above. Session secrets were never printed: the browser scripts read only the account
name, the part of the session token before `:`.

| Id | Check | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| AUTH-01 | The right company signs in | InferOS login → **Continue with InferLab** → persona **Grokbot Owner** | Signed in. The account is `subject~<issuer>~<principal>` | **PASS, live.** Account `subject~http%3A%2F%2Flocalhost%3A24480~00000000-0000-4000-8000-000000000c21`; display name `owner`, from the vouched email (`g0-run.cjs run1`) |
| AUTH-02 | A wrong company is refused | The same flow as **Canary Inspector**, another reserved tenant | No session. The message names neither company | **PASS, live.** InferOps refused the exchange (`POST /auth/token 403`). The popup said "This InferOS belongs to another company…", and the login page stayed |
| AUTH-03 | A changed email keeps the account | Change the seat's email in InferOps, then sign in again | The same account | **SKIP live.** Stub personas resolve by email, so a renamed seat can't sign in through the persona page ("Persona … is not seeded here"); the email was restored. Proved by the kernel test "keeps the same account when the email changes" (`packages/workshop-backend/__tests__/subject-login.test.ts`) at `12f7e823`. A live proof needs the real provider edge, outside the offline demo |
| AUTH-04 | Distinct subjects never merge | Sign in as **Grokbot Power User** | A different account | **PASS, live.** `…000000000c23`, not `…c21`. InferOps can't hold two users with one email, so "same email, two subjects" is the kernel test "never merges two subjects that share an email" |
| AUTH-05 | Signing in exposes no business tools | After sign-in, read onboarding's connector list | No InferLab connector or connection; nothing connected | **PASS, live.** Every connector reads "Not connected", and InferLab isn't offered as one (`run2-results.json`, `run2-home.png`). The InferLab session was ended at sign-in (AUTH-11) |
| AUTH-06 | Bad config fails closed and loud, with no fallback | Restart InferOS with `INFEROPS_COMPANY` unset; click **Continue with InferLab** | Refused before any popup, naming the setting. No demo, mock or password login happens | **PASS, live.** "InferLab sign-in is off: INFEROPS_COMPANY is missing or isn't a tenant id." No popup, no account (`auth06-nocompany`). The gatekeeper tests cover the other settings |
| AUTH-07 | PKCE is S256 | Read the `/authorize` request; complete a sign-in | `code_challenge_method=S256`, and the exchange succeeds only with the verifier | **PASS, live.** Every attempt sent S256. Central-auth checks the verifier at `/auth/token`, and three exchanges succeeded |
| AUTH-08 | The OAuth state is single use | Replay the captured `/gatekeeper/inferlab/oauth?code=…&state=…` | Refused | **PASS, live.** 400, "This link has expired" |
| AUTH-09 | The sign-in link's nonce is single use | Replay the captured `/gatekeeper/inferlab/<attempt>/<nonce>` | Refused | **PASS, live.** 400 |
| AUTH-10 | The callback is exact | `GET /authorize` for `inferos` with each redirect | Only `<origin>/gatekeeper/inferlab/oauth` and the fork's legacy path are accepted | **PASS, live** (`auth10-probe.txt`). 200 for the sign-in and legacy paths. 400 for `?x=1`, `#y`, `/gatekeeper/other/oauth` and an unconfigured origin. The sign-in itself used exactly `http://localhost:9130/gatekeeper/inferlab/oauth` |
| AUTH-11 | No central session is left behind | Count central-auth calls during the run | One logout per successful exchange | **PASS, live.** 3 × `POST /auth/token 200` and 3 × `POST /auth/logout 204` (`logs/inferops-auth-requests.txt`) |
| AUTH-12 | Only the configured issuer is trusted | Restart with `AUTH_GATEKEEPER_ISSUERS=inferlab=<another origin>`, then with a duplicate entry | Both refused, with no account | **PASS, live.** The untrusted issuer was refused after the provider step, with no account. The duplicate was refused before the popup: "Sign-in is off: AUTH_GATEKEEPER_ISSUERS entry 2 ("inferlab") names a vendor an earlier entry already names." **LOW:** for the untrusted issuer, the main tab shows upstream's generic "This sign-in attempt has expired." The specific message reaches only the popup's confirm step |
| AUTH-13 | Local sign-out ends the session | Signed in → account menu → **Sign out** → reload | The login page; no account | **PASS, live** (`run3-results.json`) |
| AUTH-14 | The account chooser is shown every time | Start a sign-in while a central session exists | InferLab's persona page, never a silent re-entry | **PASS, live.** Every `/authorize` carried `prompt=select_account`, and the persona page was shown on every attempt |
| AUTH-15 | The existing-session revocation policy holds | See the policy below. Remove the seat's workspace grants and sign in; then close its principal and sign in | Grants don't gate sign-in; a closed principal can't sign in | **PASS, live.** With no grants, Grokbot Operate still signed in (`…c22`). Signing in grants nothing, so there's nothing to revoke there. With the principal closed, sign-in was refused. Both were restored afterwards |
| AUTH-16 | State survives a restart | Restart InferOS (no state wiped); sign in as Grokbot Owner | The same account, its state intact | **PASS, live.** The same `…c21`, landing on the home page with onboarding already done (`auth16-restart`) |
| AUTH-17 | Native behaviour is unchanged | Upstream's live workerd suites at this head | All pass | **PASS.** `workshop-sharing` 6, `workshop-blueprints` 14, `workshop-hooks` 3 (including a hook firing after restart): 23 of 23 (`logs/native-suites.log`) |

**Totals:** 16 pass and 1 skipped live (AUTH-03, proved by the kernel test), with 0 failures. One LOW (AUTH-12's wording).

## Existing-session revocation policy

Chosen for G0. It's proposed for the design pages (FAC-214's companion docs PR); a person accepts it.

1. **A sign-in admits a live principal of the deployment's company,** and nothing more. Workspace grants don't gate sign-in, because signing in grants nothing. A person whose principal is closed, or who isn't in the deployment's company, is refused at their **next sign-in attempt**.
2. **An InferOS session carries no InferOps authority.** The InferLab session is ended at sign-in, and InferOS keeps no InferOps credential from it. So revoking a person's InferOps grants or membership **needs no InferOS session revocation to protect InferOps data.** Every data access goes through the separate InferOps connection (FAC-235), which uses the person's own token and is checked on every request; InferOps refuses revoked tokens at once (FAC-169).
3. **An existing InferOS session is not ended by an InferOps revocation.** Upstream issues a gatekeeper sign-in session with no expiry (`#newSessionToken()` without `expiresAt`). It lasts until the person signs out, or an InferOS admin removes the account. **Window:** none by default. This is stated, not hidden.
4. **Gap, a follow-up candidate:** there's no back channel from InferOps to end an InferOS session when someone leaves the company, and sign-in sessions have no lifetime. A bounded session lifetime with re-admission, or a revocation hook, would close it. It's outside G0's scope.

## Fence audit

`bash scripts/inferlab-g0/fence-audit.sh` checks three levels for the fork's identifiers: the
Operate session and mode, canvas model and state, workspace and widget kinds, the InferOps canvas,
`gatekeeper-inferops` / `custom-gatekeepers`, `inferops-dot` and the Dot runtime and relay, console
widgets, `scripts/consumer` / `scripts/local`, the shared-configuration gatekeeper,
`mock-inferops` and `demo.local`. It exits 1 on any hit.

| Level | What it reads | Result |
| --- | --- | --- |
| Import: paths | `git ls-files` | none |
| Import: source text | `git grep` over tracked files | none |
| Build | 25 output directories after `pnpm build` and the integration prebuild (`packages/*/dist`, `packages/*/.wrangler/validate`) | none |
| Runtime | every generated `wrangler.jsonc`: bound classes and Durable Object migrations | none |

**Result: clean** (`fence-audit.txt`).
- **Excluded on purpose, by file or exact phrase only:** `packages/gatekeeper-inferlab/README.md`, the port ledger, and lines containing "Ported from the archived fork", in two source comments and their build copies. They name the donor; they import nothing.
- **Positive control:** the same patterns find 521 paths and 470 files on `archive/main-2026-11-14` (`24f5d885`).
- No old module or generated config was restored to make anything pass.

## Cutover readiness (default-branch switch)

**Readiness facts only. Nothing was switched.**

- **Ready:**
  - the clean line carries only secret-free CI (#505), the InferLab contracts (#506), InferLab sign-in (#507) and, with this PR, the dev-server passthrough and the G0 record;
  - G0 passes live at the revisions above;
  - the fence audit is clean.
- **Not ready, or to decide before switching:**
  - **`pull_request_target` workflows** on the default branch (`main`: `contribution-policy`, `label-pr`; `cla` disabled) still run on every PR onto `clean/*`. They come from the default branch, not the base (#505, correction comment). A switch makes the clean line's own workflow set apply, which has none of those.
  - **dev-os and prod os still run the archived fork,** which signs in at the legacy `/gatekeeper/inferops/oauth`. After a switch, the next stage deploy must come from the clean line, and the legacy callback can then be removed in inferops.
  - **No stage deploy path exists on the clean line.** #505 removed upstream's preview and deploy workflows, so deploying it needs its own decision.
  - **The local launcher:** inferops `dev.mjs` sign-in wiring for the clean OS is FAC-246's, and isn't merged at these revisions. This run set the variables by hand.

## Skipped or not run

- AUTH-03 live (see the table).
- A real (non-stub) provider: out of the offline demo's scope.
- Two InferOS worktrees side by side: that's FAC-218's isolation check.
- Deployed stages.

## G0 status

**G0: PASS at InferOS `12f7e823` + this PR's head, and InferOps `afa91218`.** 16 of 17 pass live and AUTH-03 is skipped live with a kernel-test proof. The fence audit is clean. Cutover readiness is recorded, not executed.

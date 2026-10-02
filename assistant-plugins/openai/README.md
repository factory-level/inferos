# ChatGPT plan usage for local InferOS

This optional Bun companion implements OpenAI's OSS Sign in with ChatGPT flow. It is disabled by
default. Workshop still runs on Cloudflare Workers; Bun owns OAuth, protected credential files,
refresh, revocation, model discovery, and streamed Responses requests. No OAuth tokens cross the
companion boundary. Existing Workshop authentication and sandbox tool approvals remain in place.

## Run locally

Install Bun **1.3.11 or newer**, Node and the repository's pinned pnpm. From the repository root:

```sh
pnpm install
ENABLE_OPENAI_ASSISTANT_PLUGIN=true pnpm run-local
```

For separate development servers, use the same flag with `pnpm dev-server`, then `pnpm dev-client`.
The supervisor starts Bun on an ephemeral `127.0.0.1` port and passes an ephemeral bridge credential
to Wrangler through the backend's gitignored, owner-only `.dev.vars`. It removes that addition on
normal shutdown. An unexpected companion exit disables requests until the local server restarts.
An unavailable companion never triggers API-key fallback.

1. Sign in to Workshop normally and open **Settings → ChatGPT plan usage**.
2. Select **Continue with ChatGPT**, sign in, and consent to plan usage.
3. In AI Models, choose **Add AI Model → Use ChatGPT plan**, then an account and model.
4. Select that model in a chat. The composer labels it **ChatGPT plan**.

If ChatGPT is not connected, select an API-key model in the composer to start working immediately.
The local runner reads `ANTHROPIC_API_KEY` from the repository root `.env` (shell and `.dev.vars`
values take precedence) and offers the repository's suggested Anthropic models in AI Models.
The key stays in the backend's protected runtime configuration; it is never sent to the browser.
These managed models are available only in the local runtime, and their key is changed through
`.env`, not the model editor.

In **Settings → ChatGPT plan usage**, choose **API-key fallback when ChatGPT is disconnected**
to opt into fallback for saved ChatGPT models. Only a missing or signed-out registration (or a
disabled local integration) uses that selected model's API key, directly without a gateway.
The actual responding model is attributed in chat. Quota, permission, network and companion
failures retain the ChatGPT route. Fallback is off until you choose a model; deleting that model
requires selecting a replacement. Connecting ChatGPT again restores the saved plan route on
the next turn without rewriting the model's registration.

Each saved model is bound to its chosen registration. Changing the active account cancels its
in-flight requests and changes the default for new models; it does not rewrite existing model
bindings. Edit a plan model to explicitly change its registration. Background, resumed, scheduled,
and gadget-initiated runs require the account's separate background-usage checkbox.

Plus usage has a shared 5-hour limit across apps; Pro is not subject to that 5-hour limit. Agent
runs compete with other plan usage, including Codex. Review app limits in
[ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). A usage-limit failure pauses that
registration until **Retry plan usage** is selected. No reset time is guessed. Errors stay attached
to their registration so switching accounts does not lose another account's recovery state.

## Storage and recovery

`INFEROS_CONFIG_DIR` overrides the default `~/.config/inferos`. Directories are 0700; records are
0600 and replaced with an atomic rename after syncing their temporary file.

- `host.json`: installation-specific `urn:uuid:` host identity, independent of account data.
- `accounts/<sha256(client_id, sub)>.json`: one registration and renewable token set, scoped to a
  Workshop user ID. Email is display-only. Hash filenames avoid collisions and path injection.
- `preferences/<owner-hash>.json`: selected registration and first-use acknowledgment.
- `companion.lock`: exclusive process ownership. A second companion refuses to start against the
  same directory. After a crash, verify the old process has stopped before removing this lock.

Do not log or attach these files or OAuth authorization URLs to support reports. Authorize URLs
can contain a retained ID token. Browser handoff values are short-lived, single-use capabilities;
the originating authenticated popup must redeem the ticket together with its nonce before the
companion activates credentials.

Sign-out aborts requests, retries revocation on transient failures, and clears all local tokens.
The registration/subject mapping and host ID remain for reauthorization. If revocation cannot be
confirmed, the UI directs the user to disconnect InferOS in ChatGPT Settings. Disconnecting there
has no webhook; a subsequent 401 or terminal refresh failure prompts reauthorization.

## Personal VM transfer

This is for a user's own VM. Hosted multi-user deployments still require OpenAI partner approval.
The loopback callback runs on the browser's computer, so finish sign-in locally first.

1. Stop both companion processes so only the VM will own later rotating refreshes.
2. Transfer just the selected registration file over SSH to a protected 0600 temporary file on the
   VM. Use the same Workshop user ID. Never copy the laptop's `host.json` or `companion.lock`.
3. From the repository root on the VM, run:

   ```sh
   bun assistant-plugins/openai/src/main.ts --import /absolute/path/to/protected-registration.json
   ```

4. Remove the transfer file and the laptop's transferred account file without revoking the shared
   session. Restart the VM's local Workshop/companion and use an SSH tunnel for browser access.

Import creates or preserves the VM's own host ID, disables background spending, and refuses to
overwrite an active destination session. Reauthorizing on the VM needs loopback forwarding or a
fresh local sign-in and transfer; it is not a public HTTPS OAuth callback.

## Verification

```sh
bun test assistant-plugins/openai/src
pnpm build
pnpm test
```

The Bun suite uses temporary stores, signed fixture JWTs/JWKS, mocked provider responses and real
loopback listeners. It covers state/client/subject/nonce validation, consent denial, owner isolation,
0600 files, refresh serialization and terminal errors, revocation, alternate callback ports,
strict payload validation, admission failures, mid-stream quota errors and dropped streams.
Workshop tests drive the actual pi Responses adapter and assert zero gateway fallback.

Live acceptance still requires the developer's Plus/Pro account: sign in, run one short prompt
through the UI, restart, run again, then sign out and confirm the tokens were cleared. Test forced
refresh only with an isolated development registration and the companion stopped before editing
its expiry. Use fixture quota failures rather than deliberately exhausting a real subscription.
No live billing or partner-interest-form submission is performed by the automated tests.

## Integration boundaries

- `AuthProvider` isolates OSS authorization/registration from a future approved partner adapter.
- `CredentialStore` isolates protected local persistence from future server-side encrypted storage.
- `TokenManager` serializes session mutations; the process lock prevents cross-process refresh races.
- `PlanUsageResponsesClient` enforces preview fields and accepts only `response.completed` as success.
- The Worker checks `ENABLE_OPENAI_ASSISTANT_PLUGIN=true`, a loopback companion URL, and its bridge
  secret on every operation. A UI rollout flag cannot authorize this capability.
- The inference route runs before gateway selection, bypasses Cloudflare billing gates, and resends
  Workshop-owned context with `store:false` and `stream:true`. Only namespaced local function/custom
  tools are admitted. Unsupported fields fail before transmission.

The partner registration contract remains unimplemented until onboarding confirms it. Hosted
deployment also needs an approved callback and encrypted token storage; turning on the local flag
does not make this a supported hosted service.

References: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[preview constraints](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[VM transfer](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and
[partner interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).

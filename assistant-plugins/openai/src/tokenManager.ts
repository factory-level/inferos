import type { AuthProvider } from './authProvider.ts';
import { PLAN_SCOPE } from './authProvider.ts';
import type { AccountRecord, CredentialStore } from './credentialStore.ts';
import { fail, PlanError, terminalRefreshCodes } from './errors.ts';

/** Serialized account mutations and request cancellation, owned by the one companion process. */
export class TokenManager {
  #locks = new Map<string, Promise<unknown>>();
  #requests = new Map<string, Set<AbortController>>();
  constructor(readonly store: CredentialStore, readonly provider: AuthProvider,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  async lock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(run);
    this.#locks.set(id, pending);
    try { return await pending; }
    finally { if (this.#locks.get(id) === pending) this.#locks.delete(id); }
  }

  cancel(id: string): void {
    for (const controller of this.#requests.get(id) ?? []) controller.abort();
  }

  track(id: string, controller: AbortController): () => void {
    const requests = this.#requests.get(id) ?? new Set();
    requests.add(controller);
    this.#requests.set(id, requests);
    return () => {
      requests.delete(controller);
      if (!requests.size) this.#requests.delete(id);
    };
  }

  async access(owner: string, id: string, background: boolean): Promise<string> {
    return this.lock(id, async () => {
      const account = await this.store.get(owner, id);
      let tokens = account.tokens;
      if (!tokens) fail('sign_in_required', 'Sign in with ChatGPT again.', 'sign-in', 401);
      if (!tokens.scopes.includes(PLAN_SCOPE)) fail('plan_disabled', 'Enable ChatGPT plan usage or explicitly choose an API-key model.', 'consent', 403);
      if (account.paused) fail('usage_paused', 'ChatGPT plan requests are paused. Review Usage settings and explicitly retry.', 'usage', 429);
      if (background && !account.allowBackground) fail('background_disabled', 'Enable background ChatGPT usage in settings before running autonomous tasks.', 'none', 403);
      const expiresAt = Date.parse(tokens.saved_at) + tokens.expires_in * 1000;
      let earliest = 0;
      if (tokens.earliest_refresh_at !== undefined) {
        const value = tokens.earliest_refresh_at;
        earliest = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value)
          : /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value);
        if (!Number.isFinite(earliest)) fail('invalid_refresh_time', 'OpenAI returned an invalid refresh time.', 'configuration');
      }
      if (this.now() >= expiresAt - 60_000 && this.now() >= earliest) {
        try {
          tokens = await this.provider.refresh(account);
          account.tokens = tokens;
          await this.store.put(account);
        } catch (error) {
          if (error instanceof PlanError && terminalRefreshCodes.has(error.detail.code)) {
            delete account.tokens;
            await this.store.put(account);
          }
          throw error;
        }
      } else if (this.now() >= expiresAt) {
        fail('refresh_not_ready', 'ChatGPT access expired before renewal is permitted. Retry later.', 'retry', 503);
      }
      if (!tokens.scopes.includes(PLAN_SCOPE)) fail('plan_disabled', 'ChatGPT plan permission is no longer enabled.', 'consent', 403);
      return tokens.access_token;
    });
  }

  async mutate(owner: string, id: string, update: (record: AccountRecord) => void): Promise<void> {
    await this.lock(id, async () => {
      const record = await this.store.get(owner, id);
      update(record);
      await this.store.put(record);
    });
  }

  async signOut(owner: string, id: string): Promise<{ revoked: boolean }> {
    // Abort immediately and again under the lock, after any already-running refresh has finished.
    await this.store.get(owner, id);
    this.cancel(id);
    return this.lock(id, async () => {
      const account = await this.store.get(owner, id);
      this.cancel(id);
      let revoked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.provider.revoke(account); revoked = true; break; }
        catch (error) {
          if (error instanceof PlanError && error.detail.status < 500) break;
          if (attempt < 2) await this.delay(250 * 2 ** attempt);
        }
      }
      delete account.tokens;
      account.paused = false;
      await this.store.put(account);
      return { revoked };
    });
  }
}

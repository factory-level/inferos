import { mkdir, open, readFile, readdir, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './errors.ts';

const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), token_type: z.literal('Bearer'),
  expires_in: z.number().positive(), saved_at: z.string().datetime(),
  earliest_refresh_at: z.union([z.string(), z.number()]).optional(),
  scopes: z.array(z.string()),
});

/** Validated tokens stored and replaced as one unit. */
export type TokenSet = z.infer<typeof tokenSchema>;

const accountSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), ownerId: z.string().min(1),
  client_id: z.string().min(1), subject: z.string().min(1), issuer: z.literal('https://auth.openai.com'),
  ext_agent_host_id: z.string(), email: z.string().optional(), label: z.string(),
  allowBackground: z.boolean(), paused: z.boolean(), tokens: tokenSchema.optional(),
});

/** Local registration; identity survives removal of its renewable token set. */
export type AccountRecord = z.infer<typeof accountSchema>;

/** Per-Workshop-user preferences, separate from credentials. */
export type AccountPreferences = { activeAccountId: string | null; welcomed: boolean; pendingClientId?: string };

/** Persistence boundary shared by OAuth and inference; a hosted adapter can replace files later. */
export interface CredentialStore {
  hostId(): Promise<string>;
  list(ownerId: string): Promise<AccountRecord[]>;
  get(ownerId: string, id: string): Promise<AccountRecord>;
  put(record: AccountRecord): Promise<void>;
  preferences(ownerId: string): Promise<AccountPreferences>;
  savePreferences(ownerId: string, value: AccountPreferences): Promise<void>;
}

/** Opaque, path-safe identity for a registration or local owner. */
export function recordId(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Owner-only file store. The companion holds its exclusive process lock for the entire lifetime. */
export class FileCredentialStore implements CredentialStore {
  #host?: string;
  constructor(readonly directory: string) {}

  async initialize(): Promise<() => Promise<void>> {
    for (const path of [this.directory, join(this.directory, 'accounts'), join(this.directory, 'preferences')]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if ((await lstat(path)).isSymbolicLink()) fail('unsafe_storage', 'Credential directories must not be symbolic links.');
      await chmod(path, 0o700);
    }
    const lockPath = join(this.directory, 'companion.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { fail('store_locked', 'Another companion owns this credential directory. If it crashed, stop it before removing companion.lock.'); }
    await lock.writeFile(String(process.pid));
    await lock.close();
    try { await this.hostId(); }
    catch (error) { await unlink(lockPath); throw error; }
    return async () => { await unlink(lockPath); };
  }

  async #read(path: string): Promise<unknown | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        fail('unsafe_storage', 'Credential files must be regular owner-only files (0600).');
      }
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #write(path: string, value: unknown): Promise<void> {
    const temp = path + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
      await file.close();
      await rename(temp, path);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async hostId(): Promise<string> {
    if (this.#host) return this.#host;
    const path = join(this.directory, 'host.json');
    const saved = await this.#read(path);
    if (saved !== undefined) {
      this.#host = z.object({ ext_agent_host_id: z.string().regex(/^urn:uuid:[a-f0-9-]{36}$/) }).parse(saved).ext_agent_host_id;
    } else {
      this.#host = 'urn:uuid:' + randomUUID();
      await this.#write(path, { ext_agent_host_id: this.#host });
    }
    return this.#host;
  }

  async list(ownerId: string): Promise<AccountRecord[]> {
    const records = await Promise.all((await readdir(join(this.directory, 'accounts')))
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async name => accountSchema.parse(await this.#read(join(this.directory, 'accounts', name)))));
    return records.filter(record => record.ownerId === ownerId);
  }

  async get(ownerId: string, id: string): Promise<AccountRecord> {
    if (!/^[a-f0-9]{64}$/.test(id)) fail('account_not_found', 'ChatGPT account not found.', 'none', 404);
    const raw = await this.#read(join(this.directory, 'accounts', id + '.json'));
    if (!raw) fail('account_not_found', 'ChatGPT account not found.', 'none', 404);
    const record = accountSchema.parse(raw);
    if (record.ownerId !== ownerId || record.id !== id) fail('account_not_found', 'ChatGPT account not found.', 'none', 404);
    return record;
  }

  async put(record: AccountRecord): Promise<void> {
    const parsed = accountSchema.parse(record);
    if (parsed.client_id === 'dynamic_agent_client' || parsed.id !== recordId(parsed.client_id, parsed.subject)) {
      fail('invalid_registration', 'Invalid saved ChatGPT registration.', 'configuration');
    }
    const path = join(this.directory, 'accounts', parsed.id + '.json');
    const existing = await this.#read(path);
    if (existing && accountSchema.parse(existing).ownerId !== parsed.ownerId) {
      fail('account_in_use', 'This registration belongs to another Workshop account.');
    }
    await this.#write(path, parsed);
  }

  /** Import a securely transferred registration while preserving this installation's host ID. */
  async importRegistration(path: string): Promise<void> {
    const record = accountSchema.parse(await this.#read(path));
    const existing = await this.#read(join(this.directory, 'accounts', record.id + '.json'));
    if (existing && accountSchema.parse(existing).tokens) {
      fail('account_in_use', 'Sign out of the destination registration before importing a session.');
    }
    await this.put({ ...record, ext_agent_host_id: await this.hostId(), allowBackground: false, paused: false });
  }

  async preferences(ownerId: string): Promise<AccountPreferences> {
    const value = await this.#read(join(this.directory, 'preferences', recordId(ownerId) + '.json'));
    return value === undefined ? { activeAccountId: null, welcomed: false }
      : z.object({ activeAccountId: z.string().nullable(), welcomed: z.boolean(), pendingClientId: z.string().optional() }).parse(value);
  }

  async savePreferences(ownerId: string, value: AccountPreferences): Promise<void> {
    await this.#write(join(this.directory, 'preferences', recordId(ownerId) + '.json'), value);
  }
}

import type { UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDurableObject.#syncDirectory`).
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL
    ) STRICT`);
    // ADR 0018: which account each stable subject signs in to, written once per subject by the
    // sign-in that binds it; and the account each vouched address currently belongs to, for finding a
    // person by address. Reached only from the Workshop's own sign-in and lookups, never a caller.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS subjects (
      subject TEXT PRIMARY KEY,
      account TEXT NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS emails (
      email TEXT PRIMARY KEY,
      account TEXT NOT NULL
    ) STRICT`);
  }

  /** The account name `subject` signs in to (ADR 0018), or null before it was recorded. */
  accountForSubject(subject: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ account: string }>(
      `SELECT account FROM subjects WHERE subject = ?`, subject).toArray();
    return rows[0]?.account ?? null;
  }

  /**
   * Records that `subject` signs in to `account`, unless it already signs in to one: the first
   * record stands, and the account it names is returned, so a second sign-in racing the first agrees
   * with it.
   */
  recordSubject(subject: string, account: string): string {
    this.ctx.storage.sql.exec(
      `INSERT INTO subjects (subject, account) VALUES (?, ?) ON CONFLICT (subject) DO NOTHING`, subject, account);
    return this.accountForSubject(subject)!;
  }

  /** The account whose current vouched address `email` is (ADR 0018), or null. */
  accountForEmail(email: string): string | null {
    const rows = this.ctx.storage.sql.exec<{ account: string }>(
      `SELECT account FROM emails WHERE email = ?`, email.toLowerCase()).toArray();
    return rows[0]?.account ?? null;
  }

  /**
   * Records that `account`'s current vouched address is `email`: it replaces whatever address the
   * account had, and whatever account had the address, so a moved address finds its new owner only.
   */
  recordEmail(email: string, account: string): void {
    const address = email.toLowerCase();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM emails WHERE account = ? AND email != ?`, account, address);
      this.ctx.storage.sql.exec(
        `INSERT INTO emails (email, account) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET account = excluded.account`,
        address, account);
    });
  }

  /** Every account name the directory lists, for the one-off subject pass (ADR 0018 decision 7). */
  listUserIds(): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM users ORDER BY id`).toArray().map(row => row.id);
  }

  /**
   * Insert or update one user's record. `rev` is the user DO's profile revision: a record already
   * at a higher revision is left alone, so syncs that arrive out of order still converge on the
   * newest profile.
   */
  syncUser(record: UserDirectoryRecord, rev: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, record.name, `${record.id}\n${record.name}`.toLowerCase(), rev);
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   * Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and more than
   * `MAX_EXCLUDE_IDS` distinct exclusions.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    // Name and id are joined by a newline in search_text, so a needle containing one could match
    // across the two fields.
    if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
      throw new Error(
        `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
    }
    const excluded = [...new Set(excludeIds)];
    if (excluded.length > MAX_EXCLUDE_IDS) {
      throw new Error(`At most ${MAX_EXCLUDE_IDS} users can be excluded from a search.`);
    }
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excluded), needle, needle,
    ).toArray();
  }
}

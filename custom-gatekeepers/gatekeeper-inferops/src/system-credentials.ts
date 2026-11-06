// System credentials (FAC-102, inferos ADR 0011): the InferOps service-account key a configured
// system workflow's runs act as, one per Workshop trigger assignment, keyed by the assignment's
// credential reference. Kept apart from people's tokens (`InferOpsCredentials`), held server-side
// only, and reached only from this worker (`ctx.exports`): the vendor stores and forgets a key for
// the Workshop's kernel, and a system session reads its authority per request. Nothing here ever
// returns a key across RPC except `authority`, which only this worker's own clients call.

import { DurableObject } from "cloudflare:workers";
import type { InferOpsAuthority } from "./http-inferops";

/** One provisioned key and what it was checked for: the board host's workspace and the company. */
export type StoredSystemCredential = {
  key: string;
  /** The InferOps workspace the key was checked in: the resource host's workspace. */
  workspaceId: string;
  /** The resource host (`<tenant>.<workspace>`) the key serves; any other is refused. */
  host: string;
  /** The company InferOps said the key's service account is in. */
  tenantId: string;
  provisionedAt: number;
};

/** Where the stored key and the reference's tombstone live in each object's storage. */
const CREDENTIAL_KEY = "credential";
const RETIRED_KEY = "retired";

/** A credential reference: the UUID the Workshop minted for one assignment. */
export const CREDENTIAL_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The service-account key for one credential reference. Replacing it rotates it; forgetting deletes
 * it and retires the reference for good.
 */
export class InferOpsSystemCredentials extends DurableObject<Cloudflare.Env> {
  /**
   * Stores `credential`, replacing any stored before, and says whether it did. A forgotten
   * reference stores nothing (#375 round 2): the Workshop forgets a reference only when it retires
   * its assignment and mints a fresh one for any new assignment, so a store arriving after the
   * forget, from a provisioning still checking the key meanwhile, is late and must not leave a key
   * at rest. The check and the write are one synchronous transaction with no await between them
   * (#375 round 3), so no forget can run between the two.
   */
  store(credential: StoredSystemCredential): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.kv.get<boolean>(RETIRED_KEY)) return false;
      this.ctx.storage.kv.put(CREDENTIAL_KEY, credential);
      return true;
    });
  }

  /**
   * The authority a system session sends for `host`: the key and its workspace, or null when
   * nothing is provisioned or the key was checked for another host.
   */
  authority(host: string): InferOpsAuthority | null {
    const stored = this.ctx.storage.kv.get<StoredSystemCredential>(CREDENTIAL_KEY);
    if (!stored || stored.host !== host) return null;
    return { token: stored.key, workspaceId: stored.workspaceId };
  }

  /**
   * Retires the reference and deletes the stored key, if any, in one synchronous transaction
   * (#375 round 3): nothing is stored for it again.
   */
  forget(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(RETIRED_KEY, true);
      this.ctx.storage.kv.delete(CREDENTIAL_KEY);
    });
  }
}

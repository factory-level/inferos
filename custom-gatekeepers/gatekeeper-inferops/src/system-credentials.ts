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

/** A credential reference: the UUID the Workshop minted for one assignment. */
export const CREDENTIAL_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The service-account key for one credential reference. Replacing it rotates it; forgetting deletes it. */
export class InferOpsSystemCredentials extends DurableObject<Cloudflare.Env> {
  /** Stores `credential`, replacing any stored before. */
  async store(credential: StoredSystemCredential): Promise<void> {
    await this.ctx.storage.put("credential", credential);
  }

  /**
   * The authority a system session sends for `host`: the key and its workspace, or null when
   * nothing is provisioned or the key was checked for another host.
   */
  async authority(host: string): Promise<InferOpsAuthority | null> {
    const stored = await this.ctx.storage.get<StoredSystemCredential>("credential");
    if (!stored || stored.host !== host) return null;
    return { token: stored.key, workspaceId: stored.workspaceId };
  }

  /** Deletes the stored key, if any. */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

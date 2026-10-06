// Publication records (docs/design/feature-capabilities.md, "Publication destinations"; ADR 0008).
//
// A blueprint reaches beyond its owner and the installs made inside the deployment only while one
// of its records is active for the destination asked about, at the blueprint's current version.
// The owner's User DO holds each record; AdminSettings mirrors every record for review and writes
// the approved, unwithdrawn ones to one KV key, which the hot-path reach checks read. A record's
// status is derived from the env flags and from when AdminSettings last saw each flag off, never
// stored, so turning a flag off suspends reach without touching any record.

import {
  createPublicationError, PUBLICATION_ERROR_CODES, PUBLICATION_FLAGS, publicationFlagFor,
  type PublicationDestination, type PublicationFlag, type PublicationRecord, type PublicationStatus,
  type WorkspaceKind,
} from '@gadgets/workshop-shared/api';
import { BUNDLED_BLUEPRINTS } from './generated/bundled-blueprints.js';

/** Reserved BLUEPRINTS KV key holding the `PublicationSnapshot`, written only by AdminSettings. */
export const PUBLICATIONS_KEY = '.publications';

/** A record as stored: everything but its derived status. */
export type StoredPublicationRecord = Omit<PublicationRecord, 'status'>;

/**
 * When AdminSettings last saw each flag off. A record approved or re-confirmed before then needs
 * re-confirming: turning a flag on again never resumes a publication by itself.
 */
export type PublicationFlagsOffSeenAt = Partial<Record<PublicationFlag, Date>>;

/** What the reach checks read from KV: the approved, unwithdrawn records, and the flag history. */
export type PublicationSnapshot = {
  offSeenAt: PublicationFlagsOffSeenAt;
  records: StoredPublicationRecord[];
};

/** The env the flag checks read. */
export type PublicationEnv = Pick<Cloudflare.Env, PublicationFlag>;

/** The audience each destination reaches, recorded on each request in these words. */
export const PUBLICATION_AUDIENCES: Record<PublicationDestination, string> = {
  deployment: "Signed-in people of this deployment, through its featured listing.",
  export: "Anyone holding the blueprint link, who can download its .gadget archive and import " +
      "it into another deployment. A downloaded archive cannot be recalled.",
};

/** Longest withdrawal reason accepted, so a record stays small enough to mirror. */
export const MAX_PUBLICATION_REASON_LENGTH = 1000;

/** A withdrawal reason, trimmed; throws if it is too long. */
export function checkedReason(reason: string): string {
  if (reason.length > MAX_PUBLICATION_REASON_LENGTH) {
    throw new Error(`Reason too long (max ${MAX_PUBLICATION_REASON_LENGTH} characters).`);
  }
  return reason.trim();
}

/** Whether `flag` is on. Env-driven only: off unless exactly "true". */
export function isPublicationFlagOn(env: PublicationEnv, flag: PublicationFlag): boolean {
  return env[flag] === "true";
}

/** Throws the coded error naming the flag when publishing `kind` is off. */
export function assertPublicationFlagOn(env: PublicationEnv, kind: WorkspaceKind): void {
  if (isPublicationFlagOn(env, publicationFlagFor(kind))) return;
  throw createPublicationError(kind === "widget"
      ? PUBLICATION_ERROR_CODES.widgetFlagOff : PUBLICATION_ERROR_CODES.appFlagOff);
}

/** Every flag that is off now. */
export function publicationFlagsOff(env: PublicationEnv): PublicationFlag[] {
  return Object.values(PUBLICATION_FLAGS).filter(flag => !isPublicationFlagOn(env, flag));
}

/** When `record` was last approved or re-confirmed, in ms; 0 if never. */
export function lastConfirmedAt(record: StoredPublicationRecord): number {
  return Math.max(record.at?.valueOf() ?? 0, ...(record.confirmations ?? []).map(c => c.at.valueOf()));
}

/** Where `record` stands now (see `PublicationStatus`). */
export function publicationStatus(record: StoredPublicationRecord, env: PublicationEnv,
                                  offSeenAt: PublicationFlagsOffSeenAt): PublicationStatus {
  if (record.withdrawnAt) return "withdrawn";
  if (!record.at) return "requested";
  let flag = publicationFlagFor(record.artifact.kind);
  if (!isPublicationFlagOn(env, flag)) return "suspended";
  let offAt = offSeenAt[flag];
  if (offAt && lastConfirmedAt(record) <= offAt.valueOf()) return "unconfirmed";
  return "active";
}

/** `record` with its status derived. */
export function withPublicationStatus(record: StoredPublicationRecord, env: PublicationEnv,
                                      offSeenAt: PublicationFlagsOffSeenAt): PublicationRecord {
  return { ...record, status: publicationStatus(record, env, offSeenAt) };
}

/** Newest request first. */
export function byRequestedDesc(a: { requestedAt: Date }, b: { requestedAt: Date }): number {
  return b.requestedAt.valueOf() - a.requestedAt.valueOf();
}

/**
 * Whether `records` hold an active record for `blueprintId` at exactly `version` (the blueprint's
 * current one) for `destination`. A newer version is never covered by an older record.
 */
export function isPublishedAt(records: Iterable<StoredPublicationRecord>, env: PublicationEnv,
                              offSeenAt: PublicationFlagsOffSeenAt, blueprintId: string,
                              version: number, destination: PublicationDestination): boolean {
  for (let record of records) {
    if (record.artifact.blueprintId === blueprintId && record.artifact.version === version &&
        record.destination === destination &&
        publicationStatus(record, env, offSeenAt) === "active") {
      return true;
    }
  }
  return false;
}

const BUNDLED_IDS = new Set(BUNDLED_BLUEPRINTS.map(entry => entry.blueprintId));

/**
 * Whether the deployment installed `blueprintId` itself. Bundled blueprints and the output formats
 * built on them are deployment configuration, not publication, so they need no record.
 */
export function isBundledBlueprint(blueprintId: string): boolean {
  return BUNDLED_IDS.has(blueprintId);
}

function reviveRecord(record: StoredPublicationRecord): StoredPublicationRecord {
  record.requestedAt = new Date(record.requestedAt);
  if (record.at) record.at = new Date(record.at);
  if (record.withdrawnAt) record.withdrawnAt = new Date(record.withdrawnAt);
  for (let confirmation of record.confirmations ?? []) confirmation.at = new Date(confirmation.at);
  return record;
}

/** Serialize the KV snapshot. */
export function serializePublicationSnapshot(snapshot: PublicationSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Read the KV snapshot. A deployment that never published reads as empty. */
export async function readPublicationSnapshot(env: Pick<Cloudflare.Env, 'BLUEPRINTS'>)
    : Promise<PublicationSnapshot> {
  let raw = await env.BLUEPRINTS.get(PUBLICATIONS_KEY);
  if (!raw) return { offSeenAt: {}, records: [] };
  let snapshot = JSON.parse(raw) as PublicationSnapshot;
  for (let [flag, at] of Object.entries(snapshot.offSeenAt)) {
    snapshot.offSeenAt[flag as PublicationFlag] = new Date(at);
  }
  snapshot.records.forEach(reviveRecord);
  return snapshot;
}

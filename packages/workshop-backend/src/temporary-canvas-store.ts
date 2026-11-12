// A person's temporary canvases (FAC-137, temporary-canvas.ts), in their own operate session
// workspace. Each expires at the time the server set when it was created, unless the person saves
// it, under FAC-124's rule for dynamic workflow definitions: every read and write takes the clock
// inside one transaction, so a save either lands before the expiry (and keeps the canvas) or is
// refused after it, whether or not the sweep has run. The sweep deletes only expired canvas
// records: a canvas holds references, so no record it shows, no placement on the person's personal
// canvas and no run started from one of its widgets (which lives in that widget's own workspace) is
// touched. Nothing here asks for shared configuration authority or writes outside this workspace.

import {
  TEMPORARY_CANVAS_ERROR_CODES,
  TEMPORARY_CANVAS_EXPIRED,
  TEMPORARY_CANVAS_LIMITS,
  TemporaryCanvasError,
  temporaryCanvasTtlMs,
  type TemporaryCanvas,
  type TemporaryCanvasInput,
} from "@gadgets/workshop-shared/temporary-canvas";
import { orderWidgetPlacements } from "@gadgets/workshop-shared/widget-placements";
import type { OverseerStorage } from "./overseer";

/** A temporary canvas as stored: as its owner reads it. */
export type StoredTemporaryCanvas = TemporaryCanvas;

/**
 * How the store tells time, how long an unsaved canvas lasts, and whom to tell when what is due to
 * expire changes (so the Overseer reschedules its alarm for `nextExpiry`). `ttlMs` is read only when
 * a canvas is created, so a misconfigured deployment refuses just that.
 */
export type TemporaryCanvasRetention = {
  now: () => number;
  ttlMs: () => number;
  onChange?: () => void;
};

const DEFAULT_RETENTION: TemporaryCanvasRetention = { now: () => Date.now(), ttlMs: () => temporaryCanvasTtlMs(undefined) };

const NOT_FOUND = "That canvas is no longer here.";

/** The temporary canvases of one operate session workspace; its caller checks whose session it is. */
export class TemporaryCanvasStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "temporaryCanvases">,
      private retention: TemporaryCanvasRetention = DEFAULT_RETENTION) {}

  // Whether `stored` is available at `now`: saved, or not yet expired.
  #available(stored: StoredTemporaryCanvas, now: number): boolean {
    return stored.expiresAt === undefined || now < stored.expiresAt.getTime();
  }

  // The canvas `id` if it is still available at `now`; refused as expired when it is stored but past
  // its expiry (not yet swept), and as not found otherwise.
  #availableOrRefuse(id: string, now: number): StoredTemporaryCanvas {
    let stored = this.storage.temporaryCanvases.get(id);
    if (!stored) throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.notFound, NOT_FOUND);
    if (!this.#available(stored, now)) throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.expired, TEMPORARY_CANVAS_EXPIRED);
    return stored;
  }

  #changed(): void {
    this.retention.onChange?.();
  }

  /**
   * Creates a temporary canvas from checked `input` (`parseTemporaryCanvasInput`), unsaved, expiring
   * the deployment's TTL from now, with kernel-minted placement ids. Expired canvases are swept first,
   * in the same transaction, so they don't count toward `TEMPORARY_CANVAS_LIMITS.canvases`.
   */
  create(input: TemporaryCanvasInput): TemporaryCanvas {
    // Read before the transaction: a misconfigured TTL refuses only this.
    let ttl = this.retention.ttlMs();
    let created = this.durableStorage.transactionSync(() => {
      let now = this.retention.now();
      this.#sweepAt(now);
      if (Array.from(this.storage.temporaryCanvases.list({ limit: TEMPORARY_CANVAS_LIMITS.canvases })).length
          >= TEMPORARY_CANVAS_LIMITS.canvases) {
        throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.tooMany,
          `You already have ${TEMPORARY_CANVAS_LIMITS.canvases} canvases here. Remove one first.`);
      }
      let canvas: StoredTemporaryCanvas = {
        id: crypto.randomUUID(),
        title: input.title,
        placements: orderWidgetPlacements(input.placements.map(placement => ({
          placementId: crypto.randomUUID(), ref: placement.ref, layout: placement.layout,
          filters: placement.filters ?? {}, updatedAt: now,
        }))),
        revision: 1,
        createdAt: new Date(now),
        expiresAt: new Date(now + ttl),
      };
      this.storage.temporaryCanvases.put(canvas);
      return canvas;
    });
    this.#changed();
    return created;
  }

  /** The canvases still available, saved and unsaved, oldest first. Expired ones are left out. */
  list(): TemporaryCanvas[] {
    return this.durableStorage.transactionSync(() => {
      let now = this.retention.now();
      return Array.from(this.storage.temporaryCanvases.list())
        .filter(stored => this.#available(stored, now))
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    });
  }

  /** Canvas `id`; refused with `TEMPORARY_CANVAS_EXPIRED` past its expiry, else `NOT_FOUND`. */
  get(id: string): TemporaryCanvas {
    return this.durableStorage.transactionSync(() => this.#availableOrRefuse(id, this.retention.now()));
  }

  /**
   * Saves canvas `id`: it no longer expires. Only while it is still available, by the clock read in
   * this transaction; at or after its expiry it is refused (`TEMPORARY_CANVAS_EXPIRED`), swept or
   * not. A canvas already saved is returned as it is. Refused with `TEMPORARY_CANVAS_CONFLICT` when
   * `expectedRevision` isn't current.
   */
  save(id: string, expectedRevision: number): TemporaryCanvas {
    let result = this.durableStorage.transactionSync(() => {
      let stored = this.#availableOrRefuse(id, this.retention.now());
      if (stored.revision !== expectedRevision) {
        throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.conflict, "This canvas changed. Read it again.");
      }
      if (stored.expiresAt === undefined) return stored;
      let { expiresAt: _kept, ...rest } = stored;
      let saved: StoredTemporaryCanvas = { ...rest, revision: stored.revision + 1 };
      this.storage.temporaryCanvases.put(saved);
      return saved;
    });
    this.#changed();
    return result;
  }

  /**
   * Removes canvas `id` at its owner's request, saved or not: only the canvas, never anything it
   * shows. Refused with `TEMPORARY_CANVAS_CONFLICT` when `expectedRevision` isn't current, and as
   * `get` is for a canvas no longer available.
   */
  remove(id: string, expectedRevision: number): void {
    this.durableStorage.transactionSync(() => {
      let stored = this.#availableOrRefuse(id, this.retention.now());
      if (stored.revision !== expectedRevision) {
        throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.conflict, "This canvas changed. Read it again.");
      }
      this.storage.temporaryCanvases.delete(id);
    });
    this.#changed();
  }

  /**
   * Deletes every unsaved canvas past its expiry, and nothing else: no saved canvas, no other record
   * of this workspace and nothing outside it. One transaction, reading the clock inside it, so a
   * save either ran before it (and kept the canvas) or is refused after it. Returns how many.
   */
  sweepExpired(): number {
    return this.durableStorage.transactionSync(() => this.#sweepAt(this.retention.now()));
  }

  // The sweep's body, for a caller already in a transaction.
  #sweepAt(now: number): number {
    let swept = 0;
    for (let stored of Array.from(this.storage.temporaryCanvases.list())) {
      if (this.#available(stored, now)) continue;
      this.storage.temporaryCanvases.delete(stored.id);
      swept++;
    }
    return swept;
  }

  /** When to wake to sweep, or undefined: the earliest expiry among unsaved canvases. */
  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (let stored of Array.from(this.storage.temporaryCanvases.list())) {
      let at = stored.expiresAt?.getTime();
      if (at !== undefined && (next === undefined || at < next)) next = at;
    }
    return next;
  }
}

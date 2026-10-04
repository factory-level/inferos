/**
 * A shared conformance suite for connection packages: the behaviour every gatekeeper must show to
 * its overseer, stated once and run against each gatekeeper through a small adapter.
 *
 * The suite drives a gatekeeper only through what an overseer sees -- a read, an approval queue, an
 * apply, a revoke -- plus a few provider-side levers a fake can pull (change the target behind the
 * gatekeeper's back, fail or lose one write). It names no provider, resource kind or session
 * method: the adapter maps each step onto the gatekeeper under test. It ships no base class and no
 * rule language; a gatekeeper keeps its own assembly and proves it here.
 *
 * Register it from a test file in the package's own vitest pool (workerd for a Durable Object
 * gatekeeper), passing that file's vitest functions so the cases land in the right runner:
 *
 * ```ts
 * import { beforeEach, describe, it } from "vitest";
 * import { defineConformanceSuite } from "@gadgets/gatekeeper-kit/conformance";
 * defineConformanceSuite(myAdapter, { describe, it, beforeEach });
 * ```
 *
 * A case whose optional adapter hook is absent is registered as skipped, with the adapter's stated
 * reason in its name, so a connector's gaps stay visible in every run.
 *
 * This module imports nothing from vitest (a second copy of the runner would register into the
 * void) and nothing from `cloudflare:*`, so it loads in any pool.
 */

/** The vitest functions the suite registers through: the calling test file's own. */
export type ConformanceHarness = {
  /** Groups cases, as vitest's `describe`. */
  describe(name: string, body: () => void): void;
  /** Registers one case, as vitest's `it`, with `it.skip` for an inexpressible one. */
  it: {
    (name: string, body: () => Promise<void>): void;
    skip(name: string, body: () => Promise<void>): void;
  };
  /** Runs before every case, as vitest's `beforeEach`. */
  beforeEach(body: () => Promise<void> | void): void;
};

/** One observation the overseer was asked to authorize, as the suite needs to see it. */
export type ConformanceObservation = {
  /** Collaborators the gatekeeper excluded from this observation. */
  excludeObservers: readonly string[];
};

/** A collaborator the suite asked the gatekeeper to share a binding with. */
export type ConformanceCollaborator = {
  /** The id the gatekeeper knows the collaborator by, as an observation excludes it. */
  id: string;
  /** Whether the gatekeeper admitted them; refusing at admission is a valid way to withhold. */
  admitted: boolean;
};

/**
 * Maps the suite's steps onto one gatekeeper. `F` is whatever one case needs to carry between
 * steps: stubs, ids, the name of the write it proposed.
 *
 * Every method that drives an operation the gatekeeper may refuse returns the refusal's message
 * (or `null` on success) rather than rejecting, so an RPC rejection is always awaited where it is
 * made and never surfaces as an unhandled one.
 */
export type ConformanceAdapter<F> = {
  /** Names the suite's `describe` block, e.g. the package name. */
  name: string;

  /** Clears shared provider and queue state before each case. */
  reset?(): Promise<void> | void;

  /**
   * A fresh connected account bound to one in-scope resource, with a session open on it. Each call
   * must be isolated from every earlier one: no case inherits another's durable state.
   */
  setup(): Promise<F>;

  /** Reads the in-scope target through the session, resolving once the read has returned. */
  read(fixture: F): Promise<void>;

  /** Every observation authorized so far for this fixture, in order. */
  observations(fixture: F): Promise<readonly ConformanceObservation[]>;

  /**
   * Shares the binding with a collaborator who can (`canSee`) or cannot see what `read` reads,
   * before anything is read. The gatekeeper may refuse the collaborator or admit and later exclude
   * them; either withholds the read.
   */
  share(fixture: F, canSee: boolean): Promise<ConformanceCollaborator>;

  /**
   * Proposes one write through the session. The write must not be auto-approvable, must create or
   * change something `effects` can count, and must be distinguishable from every other case's.
   * @returns The action id the approval queue was given.
   */
  proposeWrite(fixture: F): Promise<number>;

  /** The action ids the approval queue was given for this fixture, in order. */
  submittedActions(fixture: F): Promise<readonly number[]>;

  /** Applies an action as the overseer does after approval: the refusal message, or `null`. */
  apply(fixture: F, actionId: number): Promise<string | null>;

  /**
   * How many times the last proposed write's effect landed at the provider: 0 before apply, 1
   * after. A provider whose data is gone (for instance after revocation) counts 0.
   */
  effects(fixture: F): Promise<number>;

  /** Revokes the account, as disconnecting it in the Workshop does. */
  revoke(fixture: F): Promise<void>;

  /**
   * Resource scope: the binding refuses a target outside its scope, and refuses it exactly as it
   * refuses a target that does not exist, so a refusal is not an existence oracle. Omit, with a
   * reason in `notExpressed`, only for a connector whose binding has no narrower scope than the
   * account.
   */
  scope?: {
    /** Reads a target that exists at the provider outside the bound scope: the refusal message. */
    readOutOfScope(fixture: F): Promise<string | null>;
    /** Reads a target that does not exist: the refusal message. */
    readUnknown(fixture: F): Promise<string | null>;
  };

  /**
   * Optimistic concurrency: a write carrying the revision it was proposed against is refused at
   * apply once the target moved on. Omit for a provider with no revisions.
   */
  staleRevision?: {
    /** Proposes a write pinned to the target's current revision: its action id. */
    propose(fixture: F): Promise<number>;
    /** Changes the target at the provider, behind the gatekeeper, as another user would. */
    advanceBehind(fixture: F): Promise<void>;
    /** Whether the write `propose` staged reached the provider. */
    landed(fixture: F): Promise<boolean>;
  };

  /** Provider faults on the next write `proposeWrite` staged. */
  faults?: {
    /** The provider refuses the next write with a server error before committing anything. */
    failNextWrite(fixture: F): Promise<void>;
    /** The provider commits the next write and the response is lost (a timeout or 5xx after it). */
    loseNextResponse(fixture: F): Promise<void>;
  };

  /** Why each omitted optional hook does not apply to this connector; shown on the skipped case. */
  notExpressed?: Partial<Record<"scope" | "staleRevision" | "faults", string>>;
};

/** Thrown by the suite's own checks, so a failure names the step rather than a bare `false`. */
export class ConformanceError extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

/** The message `operation` was refused with, or `null` when it succeeded. */
async function refusal(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Registers the shared conformance cases for one gatekeeper.
 *
 * Cases (each one a single `it`):
 * - scope: an out-of-scope target is refused like an unknown one (`scope`);
 * - observations: a read is authorized before it returns; a collaborator who cannot see the target
 *   is withheld it, by refusal or exclusion; one who can is not;
 * - approval: a write is submitted and does nothing until applied; applied once, even when the
 *   approval is delivered twice;
 * - stale revision: a write whose target moved on is refused at apply and never lands
 *   (`staleRevision`);
 * - provider faults: a server error before commit leaves the write retryable and a retry lands it
 *   once; a lost response is never replayed into a second effect (`faults`);
 * - revocation: reads stop, and a write approved before revocation does not land.
 * @param adapter Maps the suite's steps onto the gatekeeper under test.
 * @param harness The calling test file's vitest `describe`, `it` and `beforeEach`.
 */
export function defineConformanceSuite<F>(
  adapter: ConformanceAdapter<F>, harness: ConformanceHarness,
): void {
  const { describe, it, beforeEach } = harness;

  /** Registers `body` when `hook` is present, else a skipped case naming why it is not expressed. */
  const optional = (
    hook: "scope" | "staleRevision" | "faults", name: string, body: () => Promise<void>,
  ): void => {
    if (adapter[hook] !== undefined) {
      it(name, body);
      return;
    }
    const reason = adapter.notExpressed?.[hook] ?? "not expressed by this connector";
    it.skip(`${name} (${reason})`, body);
  };

  /** Proposes, checks the queue saw it, and returns its id. */
  const proposeQueued = async (fixture: F): Promise<number> => {
    const id = await adapter.proposeWrite(fixture);
    const submitted = await adapter.submittedActions(fixture);
    check(submitted.includes(id),
      `the write's action ${id} was not submitted to the approval queue (saw ${show(submitted)})`);
    return id;
  };

  describe(`connection conformance: ${adapter.name}`, () => {
    beforeEach(async () => {
      await adapter.reset?.();
    });

    describe("resource scope", () => {
      optional("scope", "refuses an out-of-scope target exactly as it refuses an unknown one",
        async () => {
          const fixture = await adapter.setup();
          const outside = await adapter.scope!.readOutOfScope(fixture);
          const unknown = await adapter.scope!.readUnknown(fixture);
          check(outside !== null, "a target outside the binding's scope was read");
          check(unknown !== null, "a target that does not exist was read");
          check(outside === unknown,
            `an out-of-scope refusal differs from an unknown-target one: ${show(outside)} vs `
            + `${show(unknown)}, which tells the agent the out-of-scope target exists`);
        });
    });

    describe("observations and sharing", () => {
      it("authorizes a read as an observation before returning it", async () => {
        const fixture = await adapter.setup();
        const before = (await adapter.observations(fixture)).length;
        await adapter.read(fixture);
        const after = (await adapter.observations(fixture)).length;
        check(after > before, "a read returned without an observation being authorized");
      });

      it("withholds a read from a collaborator who cannot see its target", async () => {
        const fixture = await adapter.setup();
        const collaborator = await adapter.share(fixture, false);
        const before = (await adapter.observations(fixture)).length;
        await adapter.read(fixture);
        const read = (await adapter.observations(fixture)).slice(before);
        check(read.length > 0, "the read was not observed");
        check(!collaborator.admitted || read.every(o => o.excludeObservers.includes(collaborator.id)),
          `collaborator ${collaborator.id} was admitted and shown a target they cannot see`);
      });

      it("shares a read with a collaborator who can see its target", async () => {
        const fixture = await adapter.setup();
        const collaborator = await adapter.share(fixture, true);
        check(collaborator.admitted, `collaborator ${collaborator.id} was refused`);
        const before = (await adapter.observations(fixture)).length;
        await adapter.read(fixture);
        const read = (await adapter.observations(fixture)).slice(before);
        check(read.length > 0, "the read was not observed");
        check(read.every(o => !o.excludeObservers.includes(collaborator.id)),
          `collaborator ${collaborator.id} was excluded from a target they can see`);
      });
    });

    describe("approval", () => {
      it("submits a write for approval and changes nothing until it is applied", async () => {
        const fixture = await adapter.setup();
        const id = await proposeQueued(fixture);
        check(await adapter.effects(fixture) === 0, "the write reached the provider before approval");

        const error = await adapter.apply(fixture, id);
        check(error === null, `the approved write failed: ${error}`);
        check(await adapter.effects(fixture) === 1, "the approved write did not land exactly once");
      });

      it("applies a write once when its approval is delivered twice", async () => {
        const fixture = await adapter.setup();
        const id = await proposeQueued(fixture);

        check(await adapter.apply(fixture, id) === null, "the first apply failed");
        // At-least-once delivery: the second apply must be answered without a second effect.
        const again = await adapter.apply(fixture, id);
        check(again === null, `a repeated apply of an applied write failed: ${again}`);
        check(await adapter.effects(fixture) === 1, "a repeated apply wrote twice");
      });
    });

    describe("stale revision", () => {
      optional("staleRevision", "refuses at apply a write whose target changed after it was proposed",
        async () => {
          const fixture = await adapter.setup();
          const id = await adapter.staleRevision!.propose(fixture);
          await adapter.staleRevision!.advanceBehind(fixture);

          const error = await adapter.apply(fixture, id);
          check(error !== null, "a write proposed against an older revision was applied");
          check(!(await adapter.staleRevision!.landed(fixture)),
            "a refused stale write still reached the provider");
        });
    });

    describe("provider faults and retry", () => {
      optional("faults", "leaves a write retryable after a server error, and a retry lands it once",
        async () => {
          const fixture = await adapter.setup();
          const id = await proposeQueued(fixture);
          await adapter.faults!.failNextWrite(fixture);

          check(await adapter.apply(fixture, id) !== null, "a write the provider refused succeeded");
          check(await adapter.effects(fixture) === 0, "a write the provider refused landed");

          const retry = await adapter.apply(fixture, id);
          check(retry === null, `retrying after a server error failed: ${retry}`);
          check(await adapter.effects(fixture) === 1, "the retry did not land exactly once");
        });

      optional("faults", "never turns a retry after a lost response into a second effect",
        async () => {
          const fixture = await adapter.setup();
          const id = await proposeQueued(fixture);
          await adapter.faults!.loseNextResponse(fixture);

          check(await adapter.apply(fixture, id) !== null,
            "a write whose response was lost was reported applied");
          // Either answer is conformant: replayed under the same idempotency key, or refused as an
          // unknown outcome. Replaying the request as new is not.
          await adapter.apply(fixture, id);
          check(await adapter.effects(fixture) === 1,
            "a retry after a lost response did not leave exactly one effect");
        });
    });

    describe("revocation", () => {
      it("stops reads once the account is revoked", async () => {
        const fixture = await adapter.setup();
        await adapter.read(fixture);

        await adapter.revoke(fixture);

        check(await refusal(() => adapter.read(fixture)) !== null,
          "a binding kept reading after its account was revoked");
      });

      it("does not apply a write approved before the account was revoked", async () => {
        const fixture = await adapter.setup();
        const id = await proposeQueued(fixture);

        await adapter.revoke(fixture);

        check(await adapter.apply(fixture, id) !== null,
          "a write was applied after its account was revoked");
        check(await adapter.effects(fixture) === 0, "a write landed after its account was revoked");
      });
    });
  });
}

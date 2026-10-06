import { describe, expect, it } from "vitest";
import { getPublicationErrorCode, PUBLICATION_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { isPublicationSelfApprovalAllowed } from "../src/auth/config.js";
import {
  assertPublicationFlagOn, checkedReason, isBundledBlueprint, isPublishedAt, publicationStatus,
  PUBLICATIONS_KEY, readPublicationSnapshot, serializePublicationSnapshot, type PublicationEnv,
  type StoredPublicationRecord,
} from "../src/publication.js";
import { BUNDLED_BLUEPRINTS } from "../src/generated/bundled-blueprints.js";

const ON: PublicationEnv = { PUBLISH_CLOUDFLAREOS_WIDGET: "true", PUBLISH_CLOUDFLAREOS_APP: "true" };
const OFF: PublicationEnv = {};

function record(overrides: Partial<StoredPublicationRecord> = {}): StoredPublicationRecord {
  return {
    id: "r1",
    artifact: { blueprintId: "bp", version: 2, digest: "sha256:00", kind: "app", title: "Board" },
    destination: "export",
    audience: "Anyone holding the link.",
    publishedBy: "alice",
    requestedAt: new Date(1_000),
    ...overrides,
  };
}

const approved = (overrides: Partial<StoredPublicationRecord> = {}) =>
  record({ approvedBy: "admin", at: new Date(2_000), ...overrides });

describe("publicationStatus", () => {
  it("is requested until approved, and withdrawn once withdrawn whatever the flags", () => {
    expect(publicationStatus(record(), ON, {})).toBe("requested");
    expect(publicationStatus(record(), OFF, {})).toBe("requested");
    expect(publicationStatus(approved({ withdrawnAt: new Date(3_000) }), ON, {})).toBe("withdrawn");
    expect(publicationStatus(record({ withdrawnAt: new Date(3_000) }), ON, {})).toBe("withdrawn");
  });

  it("suspends an approval while its kind's flag is off, and only that kind's", () => {
    expect(publicationStatus(approved(), ON, {})).toBe("active");
    expect(publicationStatus(approved(), OFF, {})).toBe("suspended");
    // Workflows ride the app flag; widgets have their own.
    const widgetOnly = { PUBLISH_CLOUDFLAREOS_WIDGET: "true" };
    const workflow = approved({ artifact: { ...approved().artifact, kind: "workflow" } });
    const widget = approved({ artifact: { ...approved().artifact, kind: "widget" } });
    expect(publicationStatus(workflow, widgetOnly, {})).toBe("suspended");
    expect(publicationStatus(widget, widgetOnly, {})).toBe("active");
  });

  it("needs re-confirming once its flag was seen off after the approval", () => {
    const seenOff = { PUBLISH_CLOUDFLAREOS_APP: new Date(2_500) };
    expect(publicationStatus(approved(), ON, seenOff)).toBe("unconfirmed");
    // A flag seen off before the approval does not touch it.
    expect(publicationStatus(approved(), ON, { PUBLISH_CLOUDFLAREOS_APP: new Date(1_500) })).toBe("active");
    // The widget flag's history is not the app flag's.
    expect(publicationStatus(approved(), ON, { PUBLISH_CLOUDFLAREOS_WIDGET: new Date(2_500) })).toBe("active");
    const confirmed = approved({ confirmations: [{ by: "admin", at: new Date(4_000) }] });
    expect(publicationStatus(confirmed, ON, seenOff)).toBe("active");
    expect(publicationStatus(confirmed, ON, { PUBLISH_CLOUDFLAREOS_APP: new Date(5_000) })).toBe("unconfirmed");
  });
});

describe("isPublishedAt", () => {
  it("reaches only the pinned version, at its own destination, while active", () => {
    const records = [approved()];
    expect(isPublishedAt(records, ON, {}, "bp", 2, "export")).toBe(true);
    expect(isPublishedAt(records, ON, {}, "bp", 3, "export")).toBe(false);
    expect(isPublishedAt(records, ON, {}, "bp", 2, "deployment")).toBe(false);
    expect(isPublishedAt(records, ON, {}, "other", 2, "export")).toBe(false);
    expect(isPublishedAt(records, OFF, {}, "bp", 2, "export")).toBe(false);
    expect(isPublishedAt([record()], ON, {}, "bp", 2, "export")).toBe(false);
  });
});

describe("flags and settings", () => {
  it("refuses with the code naming the kind's flag", () => {
    const codeFor = (env: PublicationEnv, kind: "app" | "widget" | "workflow") => {
      try {
        assertPublicationFlagOn(env, kind);
        return null;
      } catch (error) {
        return getPublicationErrorCode(error);
      }
    };
    expect(codeFor(OFF, "widget")).toBe(PUBLICATION_ERROR_CODES.widgetFlagOff);
    expect(codeFor(OFF, "app")).toBe(PUBLICATION_ERROR_CODES.appFlagOff);
    expect(codeFor(OFF, "workflow")).toBe(PUBLICATION_ERROR_CODES.appFlagOff);
    expect(codeFor({ PUBLISH_CLOUDFLAREOS_APP: "1" }, "app")).toBe(PUBLICATION_ERROR_CODES.appFlagOff);
    expect(codeFor(ON, "workflow")).toBeNull();
  });

  it("allows self-approval only when the env says exactly true", () => {
    expect(isPublicationSelfApprovalAllowed({} as Cloudflare.Env)).toBe(false);
    expect(isPublicationSelfApprovalAllowed({ PUBLICATION_SELF_APPROVAL: "yes" } as Cloudflare.Env)).toBe(false);
    expect(isPublicationSelfApprovalAllowed({ PUBLICATION_SELF_APPROVAL: "true" } as Cloudflare.Env)).toBe(true);
  });

  it("treats the bundled blueprints as configuration, and nothing else", () => {
    for (const entry of BUNDLED_BLUEPRINTS) expect(isBundledBlueprint(entry.blueprintId)).toBe(true);
    expect(isBundledBlueprint("0".repeat(32))).toBe(false);
  });

  it("bounds a withdrawal reason", () => {
    expect(checkedReason("  done  ")).toBe("done");
    expect(() => checkedReason("x".repeat(1001))).toThrow("Reason too long");
  });
});

describe("the KV snapshot", () => {
  it("round-trips its dates, and reads as empty when absent", async () => {
    const values = new Map<string, string>();
    const env = { BLUEPRINTS: { get: async (key: string) => values.get(key) ?? null } } as
        unknown as Pick<Cloudflare.Env, "BLUEPRINTS">;
    expect(await readPublicationSnapshot(env)).toEqual({ offSeenAt: {}, records: [] });
    const snapshot = {
      offSeenAt: { PUBLISH_CLOUDFLAREOS_APP: new Date(2_500) },
      records: [approved({ confirmations: [{ by: "admin", at: new Date(4_000) }], withdrawnAt: new Date(5_000) })],
    };
    values.set(PUBLICATIONS_KEY, serializePublicationSnapshot(snapshot));
    expect(await readPublicationSnapshot(env)).toEqual(snapshot);
  });
});

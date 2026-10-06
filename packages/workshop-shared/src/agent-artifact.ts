// Revisioned, digest-identified agent artifacts (issues #15, #16 and #17).
//
// Accepted by the owner on 2026-10-05 (docs/adr/0006-agent-artifact-revisions.md). The six authoring
// operations are members of Overseer (api.ts) and are implemented by the workspace's Overseer
// (workshop-backend/src/artifact-store.ts). This module holds the wire types and the pure helpers
// both sides share: the canonical-JSON digest, the qualification predicate and the reference form.
// See docs/design/agent-authoring.md.

import type { AiChatAuthorInfo, BlueprintBinding } from "./api";

/**
 * Kinds of authored artifact this contract versions. `skill` is a reusable instruction or code
 * package (today a Context Library skill directory), `agent` is an agent definition (persona,
 * instructions, pinned skills, requirements), and `gadget` is Gadget code shared as a Blueprint.
 * AI Trader's `strategy`, `study`, `view` and `brand` kinds are trading- or product-specific and are
 * not part of the reusable layer.
 */
export type ArtifactKind = "skill" | "agent" | "gadget";

/**
 * Pattern every artifact name must match: lowercase ASCII, digits and hyphens, starting with a
 * letter or digit, at most 63 characters. Names are stable across revisions; a rename is a new
 * artifact.
 */
export const ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Largest revision number accepted. Numbers are chosen by the author, start at 1 and only increase
 * for a given kind and name.
 */
export const MAX_ARTIFACT_REVISION_NUMBER = 2147483647;

/**
 * Human name of one exact revision, `<kind>/<name>@<N>`, for example `skill/triage@3`. A reference
 * is always exact: `latest`, ranges, branch names and floating aliases are refused with
 * `inexact_reference`. The name is for people; the digest is the identity.
 */
export type ArtifactRef = `${ArtifactKind}/${string}@${number}`;

/**
 * Content identity of a revision or file: `sha256:` followed by 64 lowercase hex digits. A
 * revision's digest is computed by artifactDigest() from its ArtifactManifest.
 */
export type ArtifactDigest = `sha256:${string}`;

/** Pattern every ArtifactDigest must match. */
export const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * An exact dependency on another published revision, recorded by name, number and digest so that a
 * dependent's own digest changes whenever a dependency changes. Resolution refuses a pin whose
 * revision does not exist (`pin_unresolved`) or whose published digest differs
 * (`pin_digest_mismatch`).
 */
export interface ArtifactPin {
  /** Kind of the pinned revision. */
  kind: ArtifactKind;
  /** Name of the pinned revision; matches ARTIFACT_NAME_PATTERN. */
  name: string;
  /** Exact revision number; never a range or alias. */
  number: number;
  /** Digest the pinned revision was published with. */
  digest: ArtifactDigest;
}

/**
 * What model an artifact needs. `any` lets the destination pick any of its configured models;
 * `exact` names a provider and model, and a destination that cannot bind it refuses with
 * `incompatible_requirement`. A requirement is never a credential or a model ID: model IDs are
 * per-user configuration, chosen at bind time (see BlueprintBindingAssignment).
 */
export type ArtifactModelRequirement =
  | { type: "any" }
  | { type: "exact"; provider: string; modelName: string };

/**
 * One binding an artifact needs, keyed by binding name in ArtifactManifest.bindings. Derived from
 * BlueprintBinding by keeping only the fields that describe the kind of resource required and
 * dropping everything environment-specific or presentational (`resourceUrl` and
 * `suggestedModel` suggestions, `title`, `description`, spawner `env`), so the digest never covers a
 * source environment's values. The destination satisfies it with a BlueprintBindingAssignment.
 */
export type ArtifactBindingRequirement =
  | Pick<Extract<BlueprintBinding, { type: "gatekeeper" }>, "type" | "gatekeeperName" | "typeUrlPattern">
  | Pick<Extract<BlueprintBinding, { type: "aiModel" }>, "type">
  | Pick<Extract<BlueprintBinding, { type: "agentSpawner" }>, "type">;

/** Value of ArtifactManifest.format for this, the first manifest version. */
export const ARTIFACT_MANIFEST_FORMAT = "inferos-artifact/1";

/**
 * Everything a revision's digest covers, and nothing else. Every file that can change behaviour,
 * including tests and fixtures, is listed by path with the digest of its raw bytes. Name, number,
 * title, description, author, timestamps, qualification and environment values are outside the
 * digest: identical content published under two numbers has one digest, and renaming or
 * re-describing a revision cannot invalidate its qualification.
 */
export interface ArtifactManifest {
  /** Manifest version; a reader refuses a format it does not know with `unsupported_format`. */
  format: typeof ARTIFACT_MANIFEST_FORMAT;
  /** Artifact kind. Covered, so identical files published as two kinds never share a digest. */
  kind: ArtifactKind;
  /**
   * File path to the digest of the file's exact bytes (fileDigest()). Paths are relative POSIX
   * paths with no `.` or `..` segment, no leading `/` and no empty segment, compared byte for byte
   * (no Unicode normalisation).
   */
  files: Record<string, ArtifactDigest>;
  /**
   * Exact dependencies. Sorted by kind, then name, then number, with no two pins sharing a kind and
   * name; validation refuses any other order rather than sorting silently.
   */
  pins: ArtifactPin[];
  /** Model requirement, or null when the artifact runs no model (for example a pure code skill). */
  model: ArtifactModelRequirement | null;
  /** Binding name to the kind of resource it requires. Never a credential, account or resource. */
  bindings: Record<string, ArtifactBindingRequirement>;
}

/**
 * Whether a qualification check's outcome is reproducible. A `deterministic` check runs fixed code
 * against committed fixtures and must give the same result on every run; a `liveModel` check calls
 * a real model and is evidence of behaviour at one moment, not a reproducible proof.
 */
export type QualificationCheckMode = "deterministic" | "liveModel";

/** Longest QualificationCheck.detail accepted, in UTF-16 code units. */
export const MAX_QUALIFICATION_DETAIL_LENGTH = 1024;

/**
 * One sanitised check result. A check records only its name, mode, outcome and a short detail:
 * never prompts, model responses, tool data, tokens, headers or request bodies.
 */
export interface QualificationCheck {
  /** Stable check name, for example `fixtures/triage-routes-bug`. */
  name: string;
  /** Whether the result is reproducible (see QualificationCheckMode). */
  mode: QualificationCheckMode;
  /** Whether the check passed. */
  passed: boolean;
  /** Optional sanitised explanation, at most MAX_QUALIFICATION_DETAIL_LENGTH long. */
  detail?: string;
  /** For a `liveModel` check, the provider and model it ran against. */
  model?: { provider: string; modelName: string };
}

/**
 * Proof evidence bound to one exact digest. Because the manifest covers every file and every pin
 * digest, the artifact digest is also bound to the exact dependency revisions: any change to
 * instructions, files, skills, model requirement or bindings yields a new digest, and a
 * qualification for the old digest is refused as `qualification_stale`. A qualification qualifies
 * its digest only when it has at least one deterministic check and every deterministic check
 * passed (see isQualified()); liveModel checks are recorded and shown, never gating.
 */
export interface ArtifactQualification {
  /** The digest this evidence was produced for. */
  digest: ArtifactDigest;
  /** Name and version of the harness that ran the checks, for example `inferos-qualify@1`. */
  harness: string;
  /** Digest of the fixture set the deterministic checks used, when it is not one of the files. */
  fixtures?: ArtifactDigest;
  /** Check results, at least one. */
  checks: QualificationCheck[];
  /** When the harness finished. Outside the digest. */
  completedAt: Date;
}

/**
 * Why a validate, publish, import or bind was refused. Codes carried over from AI Trader's registry
 * keep their meaning, with `content_hash` renamed `digest`; the last four are new here.
 *
 * - `digest_mismatch`: the receiver recomputed the digest and it differs from the claim.
 * - `qualification_incomplete`: no deterministic check, or a deterministic check failed.
 * - `qualification_stale`: the qualification is for a different digest.
 * - `pin_unresolved`: a pinned revision does not exist.
 * - `pin_digest_mismatch`: a pinned revision exists with a different digest.
 * - `revision_exists_different_digest`: the name and number are already published with another
 *   digest. An identical republish is not refused; it reports `created: false`.
 * - `number_not_increasing`: a higher number is already published for the name.
 * - `inexact_reference`: a reference was `latest`, a range or an alias rather than an exact pin.
 * - `unsupported_format`: an unknown manifest or archive format version.
 * - `incompatible_requirement`: the destination cannot satisfy a model or binding requirement.
 * - `secret_present`: validation found credential-shaped material in a file or field. The rule is
 *   deliberately conservative: only well-known credential formats with a distinctive prefix or
 *   frame (private-key PEM blocks, cloud and source-host access tokens, signed JWTs) are matched,
 *   and the refusal names the file path or field, never the matched text.
 *
 * A method whose result has no refusal slot (getArtifactRevision(), diffArtifactRevisions(),
 * bindArtifactRevision()) throws an Error whose message starts with the code and a colon, for
 * example `inexact_reference: latest is not an exact revision`; artifactRefusalOf() reads it back.
 */
export type ArtifactRefusal =
  | "digest_mismatch"
  | "qualification_incomplete"
  | "qualification_stale"
  | "pin_unresolved"
  | "pin_digest_mismatch"
  | "revision_exists_different_digest"
  | "number_not_increasing"
  | "inexact_reference"
  | "unsupported_format"
  | "incompatible_requirement"
  | "secret_present";

/** Every ArtifactRefusal code, in declaration order. */
export const ARTIFACT_REFUSALS: readonly ArtifactRefusal[] = [
  "digest_mismatch", "qualification_incomplete", "qualification_stale", "pin_unresolved",
  "pin_digest_mismatch", "revision_exists_different_digest", "number_not_increasing",
  "inexact_reference", "unsupported_format", "incompatible_requirement", "secret_present",
];

/**
 * The refusal code a thrown authoring error carries (see ArtifactRefusal), or null when `error` is
 * not a refusal.
 */
export function artifactRefusalOf(error: unknown): ArtifactRefusal | null {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let code = message.slice(0, Math.max(0, message.indexOf(":")));
  return (ARTIFACT_REFUSALS as readonly string[]).includes(code) ? code as ArtifactRefusal : null;
}

/**
 * One immutable published revision. Never edited: a change is a new number. A superseded revision
 * stays readable, with its qualification, for rollback and audit.
 */
export interface ArtifactRevision {
  /** `<kind>/<name>@<N>` display form of kind, name and number. */
  ref: ArtifactRef;
  /** Artifact kind. */
  kind: ArtifactKind;
  /** Artifact name. */
  name: string;
  /** Revision number. */
  number: number;
  /** Digest of `manifest`, recomputed by the receiver at publish and import. */
  digest: ArtifactDigest;
  /** The manifest the digest covers. */
  manifest: ArtifactManifest;
  /** Evidence that qualified `digest`. */
  qualification: ArtifactQualification;
  /** The signed-in person who published. Agents may draft and qualify; they never publish. */
  publishedBy: AiChatAuthorInfo & { type: "user" };
  /** When the revision was published. */
  publishedAt: Date;
}

/** Outcome of a publish: the revision (new or an identical existing one), or why it was refused. */
export type ArtifactPublishResult =
  | { ok: true; created: boolean; revision: ArtifactRevision }
  | { ok: false; refusal: ArtifactRefusal; detail?: string };

/** One manifest-level difference between two revisions, as returned by diffArtifactRevisions(). */
export type ArtifactChange =
  | { type: "file"; path: string; change: "added" | "removed" | "modified" }
  | { type: "pin"; kind: ArtifactKind; name: string; from: number | null; to: number | null }
  | { type: "model"; from: ArtifactModelRequirement | null; to: ArtifactModelRequirement | null }
  | { type: "binding"; name: string; change: "added" | "removed" | "modified" };

/** Pattern every ArtifactRef must match: kind, name and a decimal number with no leading zero. */
export const ARTIFACT_REF_PATTERN = /^(skill|agent|gadget)\/([a-z0-9][a-z0-9-]{0,62})@([1-9][0-9]{0,9})$/;

/** The display reference of one exact revision, `<kind>/<name>@<number>`. */
export function artifactRef(kind: ArtifactKind, name: string, number: number): ArtifactRef {
  return `${kind}/${name}@${number}`;
}

/**
 * Split an exact reference into kind, name and number, or return null when `ref` is not exact:
 * `latest`, a range, an alias, a malformed name or a number outside 1..MAX_ARTIFACT_REVISION_NUMBER.
 * Callers refuse a null result with `inexact_reference`.
 */
export function parseArtifactRef(ref: string): { kind: ArtifactKind; name: string; number: number } | null {
  let match = ARTIFACT_REF_PATTERN.exec(ref);
  if (!match) return null;
  let number = Number(match[3]);
  if (number > MAX_ARTIFACT_REVISION_NUMBER) return null;
  return { kind: match[1] as ArtifactKind, name: match[2]!, number };
}

/**
 * Whether `qualification` qualifies `digest`: it is for exactly that digest, it has at least one
 * deterministic check, and every deterministic check passed. Live-model checks never decide it.
 */
export function isQualified(qualification: ArtifactQualification, digest: ArtifactDigest): boolean {
  let deterministic = qualification.checks.filter(check => check.mode === "deterministic");
  return qualification.digest === digest && deterministic.length > 0 &&
      deterministic.every(check => check.passed);
}

/**
 * Canonical JSON text of `value`, the byte form every artifact digest is computed over. The rule
 * (the integer subset of RFC 8785, JSON Canonicalization Scheme):
 *
 * - Accepted values are null, booleans, strings, safe integers, arrays and plain objects. Anything
 *   else -- fractional or unsafe numbers, NaN, bigint, Date, functions, `undefined` inside an
 *   array -- throws rather than being coerced, so two implementations cannot disagree silently.
 * - Object members whose value is `undefined` are omitted; all others are sorted by key in UTF-16
 *   code unit order (JavaScript's default sort, as RFC 8785 specifies).
 * - Strings are escaped exactly as JSON.stringify() escapes them, with no Unicode normalisation.
 * - No whitespace anywhere. The text is hashed as UTF-8.
 */
export function canonicalArtifactJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Not a safe integer: ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined) throw new TypeError("undefined is not allowed in an array");
      return canonicalArtifactJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let members = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${members.map(([key, item]) =>
        `${JSON.stringify(key)}:${canonicalArtifactJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`Not canonical JSON: ${Object.prototype.toString.call(value)}`);
}

async function sha256(bytes: Uint8Array): Promise<ArtifactDigest> {
  // Copied so the argument is ArrayBuffer-backed, as BufferSource requires under every lib setting.
  let hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Digest of one file's exact bytes, as listed in ArtifactManifest.files. */
export function fileDigest(bytes: Uint8Array): Promise<ArtifactDigest> {
  return sha256(bytes);
}

/** A revision's digest: SHA-256 over the UTF-8 bytes of canonicalArtifactJson(manifest). */
export function artifactDigest(manifest: ArtifactManifest): Promise<ArtifactDigest> {
  return sha256(new TextEncoder().encode(canonicalArtifactJson(manifest)));
}

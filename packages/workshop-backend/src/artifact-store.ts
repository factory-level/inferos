import {
  ARTIFACT_DIGEST_PATTERN, ARTIFACT_MANIFEST_FORMAT, ARTIFACT_NAME_PATTERN, artifactDigest, artifactRef,
  canonicalArtifactJson, fileDigest, MAX_ARTIFACT_REVISION_NUMBER, MAX_QUALIFICATION_DETAIL_LENGTH,
  type ArtifactBindingRequirement, type ArtifactChange, type ArtifactDigest, type ArtifactKind,
  type ArtifactManifest, type ArtifactModelRequirement, type ArtifactPin, type ArtifactQualification,
  type ArtifactRefusal, type ArtifactRevision,
} from "@gadgets/workshop-shared/agent-artifact";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerStorage } from "./overseer";

// Workspace-local storage and publish rules for agent artifact revisions (ADR 0006). The Overseer
// gathers a gadget's committed files and binding metadata; everything that decides whether a
// revision may be stored is here, so the rules can be read in one place.

/**
 * One stored revision: the wire ArtifactRevision plus what this workspace needs to instantiate it
 * again. Both extra fields are outside the digest and never leave the workspace over RPC.
 */
export type ArtifactRevisionRecord = ArtifactRevision & {
  /**
   * The commit, in this workspace's git store, holding exactly the manifest's files. Git objects
   * are never collected, so the record is the ref that keeps them.
   */
  commitId: string;

  /**
   * Binding metadata collected from the gadget at publish, with every source suggestion
   * (`resourceUrl`, `suggestedModel`) dropped: titles and spawner env shape for bindArtifactRevision.
   */
  bindingTemplates: Record<string, BlueprintBinding>;
};

/** A refusal and the path, field or reference it concerns. Never matched or secret text. */
export type RefusalFinding = { refusal: ArtifactRefusal; detail: string };

/** An Error whose message carries a refusal code, as artifactRefusalOf() reads it back. */
export function artifactRefusalError(refusal: ArtifactRefusal, detail: string): Error {
  return new Error(`${refusal}: ${detail}`);
}

const KINDS: readonly ArtifactKind[] = ["skill", "agent", "gadget"];
const MAX_PINS = 64;
const MAX_CHECKS = 256;
const MAX_LABEL_LENGTH = 256;

/** Storage key of one revision: `<kind>/<name>@<keyString(number)>`, so a name lists in number order. */
export function revisionKey(kind: ArtifactKind, name: string, number: number): string {
  return `${kind}/${name}@${keyString(number)}`;
}

function requireKind(kind: ArtifactKind): ArtifactKind {
  if (!KINDS.includes(kind)) throw new TypeError(`Unknown artifact kind: ${kind}`);
  return kind;
}

function requireLabel(value: string, what: string): string {
  if (value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    throw new TypeError(`${what} must be 1-${MAX_LABEL_LENGTH} characters.`);
  }
  return value;
}

/** Throws unless `name` and `number` are a valid artifact name and revision number. */
export function requireNameAndNumber(name: string, number?: number): void {
  if (!ARTIFACT_NAME_PATTERN.test(name)) throw new TypeError(`Invalid artifact name: ${name}`);
  if (number !== undefined &&
      (!Number.isSafeInteger(number) || number < 1 || number > MAX_ARTIFACT_REVISION_NUMBER)) {
    throw new TypeError(`Invalid revision number: ${number}`);
  }
}

function comparePins(a: ArtifactPin, b: ArtifactPin): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.name < b.name ? -1 : a.name > b.name ? 1 : a.number - b.number;
}

/**
 * Throws unless every pin is well formed and the list is sorted by kind, then name, then number,
 * with no two pins sharing a kind and name. An unsorted list is refused rather than sorted, so the
 * caller's manifest and the receiver's can never silently differ.
 */
export function requirePins(pins: ArtifactPin[]): ArtifactPin[] {
  if (pins.length > MAX_PINS) throw new TypeError(`At most ${MAX_PINS} pins.`);
  pins.forEach((pin, index) => {
    requireKind(pin.kind);
    requireNameAndNumber(pin.name, pin.number);
    if (!ARTIFACT_DIGEST_PATTERN.test(pin.digest)) throw new TypeError(`Invalid pin digest: ${pin.digest}`);
    let previous = pins[index - 1];
    if (previous && (comparePins(previous, pin) >= 0 || (previous.kind === pin.kind && previous.name === pin.name))) {
      throw new TypeError("Pins must be sorted by kind, name and number, one per kind and name.");
    }
  });
  // Rebuilt field by field so no extra property reaches the digest.
  return pins.map(({kind, name, number, digest}) => ({kind, name, number, digest}));
}

/** Throws unless `model` is a well-formed requirement; returns it without extra properties. */
export function requireModel(model: ArtifactModelRequirement | null): ArtifactModelRequirement | null {
  if (model === null) return null;
  if (model.type === "any") return {type: "any"};
  if (model.type === "exact") {
    return {
      type: "exact",
      provider: requireLabel(model.provider, "Model provider"),
      modelName: requireLabel(model.modelName, "Model name"),
    };
  }
  throw new TypeError("Unknown model requirement.");
}

/** The kind of resource a binding requires, with every environment-specific field dropped. */
export function bindingRequirement(binding: BlueprintBinding): ArtifactBindingRequirement {
  switch (binding.type) {
    case "gatekeeper":
      return {type: "gatekeeper", gatekeeperName: binding.gatekeeperName, typeUrlPattern: binding.typeUrlPattern};
    case "aiModel": return {type: "aiModel"};
    case "agentSpawner": return {type: "agentSpawner"};
    default: return binding satisfies never;
  }
}

// What bindArtifactRevision needs of a binding beyond its requirement: display text, whether it
// only feeds a spawner, and a spawner's symbolic env. Source suggestions are dropped.
function bindingTemplate(binding: BlueprintBinding): BlueprintBinding {
  let base = {title: binding.title, description: binding.description,
    ...(binding.spawnerOnly ? {spawnerOnly: true as const} : {})};
  switch (binding.type) {
    case "gatekeeper":
      return {...base, type: "gatekeeper", gatekeeperName: binding.gatekeeperName, typeUrlPattern: binding.typeUrlPattern};
    case "aiModel": return {...base, type: "aiModel"};
    case "agentSpawner": return {...base, type: "agentSpawner", env: binding.env};
    default: return binding satisfies never;
  }
}

// Credential formats matched by `secret_present`. Conservative on purpose: each pattern is a
// well-known format with a distinctive prefix or frame, so ordinary code, fixtures and prose are
// not refused. Generic high-entropy strings and `password = "..."` assignments are not matched;
// a credential in such a form is a false negative, which review and the "never put credentials
// in an artifact" rule cover. Patterns only ever decide yes or no: matched text is never echoed.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,        // PEM / OpenSSH / PGP private keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,                                 // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,                                // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,                              // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,                                  // GitLab personal tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,                              // Slack tokens
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,                      // OpenAI / Anthropic API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/,                                     // Google API keys
  /\b[rs]k_live_[0-9A-Za-z]{20,}\b/,                               // Stripe live keys
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/, // signed JWTs
];

/** Whether `text` contains material in one of the conservative credential formats above. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

/** Throws unless `qualification` is well formed; returns it without extra properties. */
export function requireQualification(qualification: ArtifactQualification): ArtifactQualification {
  if (!ARTIFACT_DIGEST_PATTERN.test(qualification.digest)) throw new TypeError("Invalid qualification digest.");
  if (qualification.fixtures !== undefined && !ARTIFACT_DIGEST_PATTERN.test(qualification.fixtures)) {
    throw new TypeError("Invalid fixture-set digest.");
  }
  if (qualification.checks.length > MAX_CHECKS) throw new TypeError(`At most ${MAX_CHECKS} checks.`);
  return {
    digest: qualification.digest,
    harness: requireLabel(qualification.harness, "Harness"),
    ...(qualification.fixtures !== undefined ? {fixtures: qualification.fixtures} : {}),
    checks: qualification.checks.map(check => {
      if (check.mode !== "deterministic" && check.mode !== "liveModel") throw new TypeError("Unknown check mode.");
      if (check.detail !== undefined && check.detail.length > MAX_QUALIFICATION_DETAIL_LENGTH) {
        throw new TypeError(`Check detail is limited to ${MAX_QUALIFICATION_DETAIL_LENGTH} characters.`);
      }
      return {
        name: requireLabel(check.name, "Check name"), mode: check.mode, passed: check.passed,
        ...(check.detail !== undefined ? {detail: check.detail} : {}),
        ...(check.model ? {model: {provider: requireLabel(check.model.provider, "Model provider"),
          modelName: requireLabel(check.model.modelName, "Model name")}} : {}),
      };
    }),
    completedAt: qualification.completedAt,
  };
}

/**
 * Why `qualification` cannot qualify `digest`, in the order they are reported: credential-shaped
 * text in its sanitised fields, a different digest, then missing or failed deterministic checks.
 * Live-model checks are never consulted for the outcome.
 */
export function qualificationFindings(qualification: ArtifactQualification, digest: ArtifactDigest): RefusalFinding[] {
  let findings: RefusalFinding[] = [];
  let fields: [string, string | undefined][] = [["qualification.harness", qualification.harness],
    ...qualification.checks.flatMap((check, i): [string, string | undefined][] =>
        [[`qualification.checks[${i}].name`, check.name], [`qualification.checks[${i}].detail`, check.detail]])];
  for (let [field, text] of fields) {
    if (text !== undefined && containsSecret(text)) findings.push({refusal: "secret_present", detail: field});
  }
  if (qualification.digest !== digest) {
    findings.push({refusal: "qualification_stale", detail: `qualification is for ${qualification.digest}`});
  }
  let deterministic = qualification.checks.filter(check => check.mode === "deterministic");
  if (deterministic.length === 0) {
    findings.push({refusal: "qualification_incomplete", detail: "no deterministic check"});
  } else {
    let failed = deterministic.find(check => !check.passed);
    if (failed) findings.push({refusal: "qualification_incomplete", detail: `deterministic check failed: ${failed.name}`});
  }
  return findings;
}

/** A gadget's committed code as an unpublished artifact: what validate reports and publish stores. */
export type ArtifactDraft = {
  manifest: ArtifactManifest;
  digest: ArtifactDigest;
  findings: RefusalFinding[];
  bindingTemplates: Record<string, BlueprintBinding>;
};

/** Field-by-field difference between two manifests, as diffArtifactRevisions() reports it. */
export function diffManifests(from: ArtifactManifest, to: ArtifactManifest): ArtifactChange[] {
  let changes: ArtifactChange[] = [];
  for (let path of [...new Set([...Object.keys(from.files), ...Object.keys(to.files)])].toSorted()) {
    let [a, b] = [from.files[path], to.files[path]];
    if (a !== b) changes.push({type: "file", path, change: !a ? "added" : !b ? "removed" : "modified"});
  }
  let pinKey = (pin: ArtifactPin) => `${pin.kind}/${pin.name}`;
  let fromPins = new Map(from.pins.map(pin => [pinKey(pin), pin]));
  let toPins = new Map(to.pins.map(pin => [pinKey(pin), pin]));
  for (let key of [...new Set([...fromPins.keys(), ...toPins.keys()])].toSorted()) {
    let [a, b] = [fromPins.get(key), toPins.get(key)];
    if (a?.number !== b?.number || a?.digest !== b?.digest) {
      let {kind, name} = (a ?? b)!;
      changes.push({type: "pin", kind, name, from: a?.number ?? null, to: b?.number ?? null});
    }
  }
  if (canonicalArtifactJson(from.model) !== canonicalArtifactJson(to.model)) {
    changes.push({type: "model", from: from.model, to: to.model});
  }
  for (let name of [...new Set([...Object.keys(from.bindings), ...Object.keys(to.bindings)])].toSorted()) {
    let [a, b] = [from.bindings[name], to.bindings[name]];
    if (!a || !b || canonicalArtifactJson(a) !== canonicalArtifactJson(b)) {
      changes.push({type: "binding", name, change: !a ? "added" : !b ? "removed" : "modified"});
    }
  }
  return changes;
}

/** The wire form of a stored record: drops the workspace-local fields. */
export function revisionOf({commitId: _commit, bindingTemplates: _templates, ...revision}: ArtifactRevisionRecord)
    : ArtifactRevision {
  return revision;
}

/**
 * A workspace's published artifact revisions, reachable only through a build-capable Overseer
 * session. Revisions are immutable and keyed by kind, name and number; the author-chosen number
 * plays the part the canvas and console stores give an expected revision, so two publishes racing
 * for one name cannot both land.
 */
export class WorkspaceArtifactStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "artifactRevisions">) {}

  /** Every revision of one name, lowest number first. */
  list(kind: ArtifactKind, name: string): ArtifactRevisionRecord[] {
    requireKind(kind);
    requireNameAndNumber(name);
    return Array.from(this.storage.artifactRevisions.list({prefix: `${kind}/${name}@`}));
  }

  get(kind: ArtifactKind, name: string, number: number): ArtifactRevisionRecord | null {
    return this.storage.artifactRevisions.get(revisionKey(kind, name, number)) ?? null;
  }

  /** Each pin that does not resolve to a published revision with exactly its digest. */
  pinFindings(pins: ArtifactPin[]): RefusalFinding[] {
    return pins.flatMap((pin): RefusalFinding[] => {
      let ref = artifactRef(pin.kind, pin.name, pin.number);
      let published = this.get(pin.kind, pin.name, pin.number);
      if (!published) return [{refusal: "pin_unresolved", detail: ref}];
      return published.digest === pin.digest ? [] : [{refusal: "pin_digest_mismatch", detail: ref}];
    });
  }

  /**
   * Build the manifest for `files` (path to committed text, hashed as its UTF-8 bytes) and report
   * the refusals publishing it would meet now: credential-shaped files, then unresolved pins.
   */
  async draft(kind: ArtifactKind, files: Map<string, string>, pins: ArtifactPin[],
      model: ArtifactModelRequirement | null, bindings: Record<string, BlueprintBinding>): Promise<ArtifactDraft> {
    let encoder = new TextEncoder();
    let digests: Record<string, ArtifactDigest> = {};
    let findings: RefusalFinding[] = [];
    for (let [path, text] of [...files].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      digests[path] = await fileDigest(encoder.encode(text));
      if (containsSecret(path) || containsSecret(text)) findings.push({refusal: "secret_present", detail: path});
    }
    let manifest: ArtifactManifest = {
      format: ARTIFACT_MANIFEST_FORMAT,
      kind: requireKind(kind),
      files: digests,
      pins: requirePins(pins),
      model: requireModel(model),
      bindings: Object.fromEntries(Object.entries(bindings).map(([name, b]) => [name, bindingRequirement(b)])),
    };
    findings.push(...this.pinFindings(manifest.pins));
    return {
      manifest, digest: await artifactDigest(manifest), findings,
      bindingTemplates: Object.fromEntries(Object.entries(bindings).map(([name, b]) => [name, bindingTemplate(b)])),
    };
  }

  /**
   * Store `record` unless its name and number already hold another digest or a higher number is
   * published. An identical republish returns the existing record with `created: false`. Checked
   * and written in one synchronous transaction.
   */
  publish(record: ArtifactRevisionRecord): {created: boolean, record: ArtifactRevisionRecord} | RefusalFinding {
    return this.durableStorage.transactionSync(() => {
      let existing = this.get(record.kind, record.name, record.number);
      if (existing) {
        return existing.digest === record.digest ? {created: false, record: existing}
            : {refusal: "revision_exists_different_digest" as const, detail: record.ref};
      }
      let highest = this.list(record.kind, record.name).at(-1);
      if (highest && highest.number > record.number) {
        return {refusal: "number_not_increasing" as const, detail: `${highest.ref} is published`};
      }
      this.storage.artifactRevisions.put(record);
      return {created: true, record};
    });
  }
}

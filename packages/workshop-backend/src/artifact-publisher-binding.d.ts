/**
 * Binding that lets an agent check a gadget's committed code as an artifact revision and ask the
 * person to publish it. Publishing always waits for a person to approve it in the workspace's
 * approval queue; the revision is then recorded as published by that person. Nothing is
 * activated, scheduled or bound by publishing.
 */
export interface ArtifactPublisherBinding {
  /**
   * Build the manifest for gadget `gadgetId`'s committed code under `kind`, compute its digest and
   * list every refusal publishing it now would meet. Stores nothing. Use the digest as the
   * `qualification.digest` of the proof you produce.
   */
  validate(gadgetId: number, kind: ArtifactKind, pins: ArtifactPin[],
      model: ArtifactModelRequirement | null): Promise<{digest: string, refusals: string[]}>;

  /**
   * Ask the person to publish `<kind>/<name>@<number>` from gadget `gadgetId`'s committed code.
   * Resolves once the request is queued; your turn ends until the person decides. On approval the
   * workspace rebuilds the manifest and checks the qualification again, so a gadget changed since
   * you qualified it is refused as `qualification_stale`.
   */
  requestPublish(request: ArtifactPublishRequest): Promise<void>;
}

/** `skill` (reusable instructions or code), `agent` (an agent definition) or `gadget`. */
export type ArtifactKind = "skill" | "agent" | "gadget";

/** An exact published dependency: kind, name, number and the digest it was published with. */
export type ArtifactPin = {kind: ArtifactKind, name: string, number: number, digest: string};

/** The model the artifact needs: any configured model, an exact one, or none. */
export type ArtifactModelRequirement =
  | {type: "any"}
  | {type: "exact", provider: string, modelName: string};

/** What to publish, and the proof that qualifies it. */
export type ArtifactPublishRequest = {
  gadgetId: number;
  kind: ArtifactKind;
  /** Lowercase letters, digits and hyphens, at most 63 characters. */
  name: string;
  /** Higher than every number already published for the name. */
  number: number;
  /** Sorted by kind, then name, then number; one per kind and name. */
  pins: ArtifactPin[];
  model: ArtifactModelRequirement | null;
  qualification: {
    /** The digest validate() returned. */
    digest: string;
    /** Name and version of your harness, for example `inferos-qualify@1`. */
    harness: string;
    /**
     * At least one `deterministic` check, all passing. `liveModel` checks are recorded but never
     * decide. Details are at most 1024 characters and never contain prompts, model output,
     * tokens or credentials.
     */
    checks: {name: string, mode: "deterministic" | "liveModel", passed: boolean, detail?: string,
      model?: {provider: string, modelName: string}}[];
    completedAt: Date;
  };
};

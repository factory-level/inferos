// Installing the deployment's bundled blueprints, which it then offers as its standard output
// formats.
//
// The reviewable source and its presentation come from a directory chosen at build time (see
// scripts/build-bundled-blueprints.ts), so a deployment ships its own formats by pointing
// BUNDLED_BLUEPRINTS_DIR at its own tree rather than by editing this repo.
//
// Installation writes an ordinary blueprint -- metadata into BLUEPRINTS, the code snapshot into
// BLUEPRINT_CONTENT -- exactly as publishing does. Nothing downstream knows these are special:
// no reserved id prefix, no fallback branch in the read path. Failure is tolerable: a deployment
// with none installed simply has no standard formats.

import { BlueprintMetadata, BlueprintPublicInfo, DEFAULT_WORKSPACE_KIND } from "@gadgets/workshop-shared/api";
import { BlueprintKvRecord, blueprintVersionMetadata, parseBlueprintArchive } from "./blueprint-archive.js";
import { BundledBlueprint, BUNDLED_BLUEPRINTS } from "./generated/bundled-blueprints.js";
import { fingerprint } from "./admin-config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.formats");

type InstallEnv = Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">;

/**
 * Identifies the exact set of bundled blueprints a deployment has installed, and how. Compared
 * with what was installed last time, so any change here triggers reinstallation.
 *
 * Everything that ends up in the installed metadata contributes, not just `revision`: editing a
 * description would otherwise build, deploy, and change nothing on a deployment that had already
 * installed. `contentHash` covers the generated archive, including direct edits to source files.
 */
export function bundledBlueprintsManifestVersion(
    entries: readonly BundledBlueprint[] = BUNDLED_BLUEPRINTS): string {
  return entries
      .map(e => `${e.blueprintId}@${e.revision}+${e.contentHash}+` +
          fingerprint(JSON.stringify([e.title, e.description, e.author, e.output,
            ...(e.kind !== undefined ? [e.kind] : [])])))
      .toSorted()
      .join(",");
}

// Install one bundled blueprint, returning its public info for the featured mirror.
async function installOne(env: InstallEnv, entry: BundledBlueprint)
    : Promise<BlueprintPublicInfo> {
  // Parse through the ordinary archive reader so a corrupt bundled file fails the same way an
  // uploaded one would, rather than producing a half-installed blueprint.
  let {metadata, contentLength, content} = await parseBlueprintArchive(
      new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);

  // R2 needs a known length, and the archive is already fully in memory (it came out of the
  // Worker bundle), so buffer rather than plumbing a FixedLengthStream through as the upload path
  // does for genuinely streamed uploads.
  let contentBytes = new Uint8Array(await new Response(content).arrayBuffer());
  if (contentBytes.byteLength !== contentLength) {
    throw new Error(`Archive declares ${contentLength} content bytes but holds ` +
        `${contentBytes.byteLength}.`);
  }

  // The archive supplies what the blueprint does -- code, bindings, and the dates from the
  // workspace it was exported from. How it is presented comes from its source manifest, overwriting
  // whatever the archive carries.
  let installed: BlueprintMetadata = {
    ...metadata,
    title: entry.title,
    description: entry.description,
    author: entry.author,
    output: entry.output,
    // An app's record stays as it always was; only another kind is named.
    ...(entry.kind !== undefined && entry.kind !== DEFAULT_WORKSPACE_KIND ? {kind: entry.kind} : {}),
  };

  // Content first: a blueprint whose metadata exists but whose R2 object doesn't is broken, while
  // the reverse is merely an orphaned object that the next install overwrites. The archive's
  // content section is already gzip-compressed, which is exactly what R2 holds.
  // Stored with the kind, as a published version is (see blueprintVersionMetadata): an install
  // pinned to this version reads its kind from here, so a bundled widget installs as a widget.
  await env.BLUEPRINT_CONTENT.put(`${entry.blueprintId}/${installed.version}`, contentBytes,
      {customMetadata: blueprintVersionMetadata(installed.kind, installed.dataContract)});

  let kvRecord: BlueprintKvRecord = {metadata: installed};
  await env.BLUEPRINTS.put(entry.blueprintId, JSON.stringify(kvRecord));

  return {id: entry.blueprintId, metadata: installed};
}

/**
 * Install every bundled blueprint, skipping (and logging) any that fail. Returns the public info
 * of those that installed, so the caller can offer them to users. `entries` defaults to the
 * deployment's bundle; a test passes its own.
 */
export async function installBundledBlueprints(
    env: InstallEnv, entries: readonly BundledBlueprint[] = BUNDLED_BLUEPRINTS)
    : Promise<BlueprintPublicInfo[]> {
  let installed: BlueprintPublicInfo[] = [];
  for (let entry of entries) {
    try {
      installed.push(await installOne(env, entry));
      logger.info("installed bundled blueprint", {
        event: "formats.install.ok", blueprintId: entry.blueprintId,
      });
    } catch (err) {
      // One bad archive must not deny the deployment the others.
      logger.error("failed to install bundled blueprint", {
        event: "formats.install.failed", blueprintId: entry.blueprintId, error: err,
      });
    }
  }
  return installed;
}

/**
 * Whether a bundled blueprint is offered as one of the deployment's standard output formats. A
 * format is something its users create and open, which only an app is; a bundled widget or
 * workflow is installed and listed like any other blueprint, but never promoted to a format.
 */
export function isBundledFormat(entry: Pick<BundledBlueprint, "kind">): boolean {
  return (entry.kind ?? DEFAULT_WORKSPACE_KIND) === "app";
}

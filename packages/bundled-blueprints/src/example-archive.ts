// Build the `.gadget` archive of one EXAMPLE blueprint (`examples/<name>/`), for importing by hand
// into a Workshop. Examples are never bundled: `generateBundledBlueprintsModule` reads only
// `BUNDLED_BLUEPRINTS_DIR`, and this builds one archive on request with the same manifest parser,
// source reader (and its TypeScript bundling and import checks) and codec as a bundled blueprint.
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContent, readSourceFiles, serializeArchive } from "./files.ts";
import { type BundledBlueprintManifest, parseBundledBlueprintManifest } from "./manifest.ts";

/** Where the example blueprints live: beside `blueprints/`, never inside it. */
export const EXAMPLES_DIR: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples");

export async function buildExampleArchive(
  directory: string,
): Promise<{ manifest: BundledBlueprintManifest; bytes: Uint8Array }> {
  const name = basename(directory);
  const manifest = parseBundledBlueprintManifest(
    name, await readFile(join(directory, "blueprint.json"), "utf8"));
  const { created, version, lastUpdated, bindings } = manifest;
  const files = await readSourceFiles(join(directory, "files"), `${name}/files`);
  const metadata = {
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    created,
    version,
    lastUpdated,
    bindings,
  };
  return { manifest, bytes: serializeArchive(metadata, buildContent(files, name), name) };
}

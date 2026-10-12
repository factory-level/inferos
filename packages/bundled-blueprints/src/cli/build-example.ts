// `pnpm build:example <examples/name> <out.gadget>` -- write one example blueprint's archive. It is
// not installed anywhere: import the file into a Workshop by hand.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildExampleArchive } from "../example-archive.ts";

const [directory, out] = process.argv.slice(2);
if (!directory || !out) {
  console.error("usage: build-example <examples/name> <out.gadget>");
  process.exit(2);
}
const { manifest, bytes } = await buildExampleArchive(resolve(directory));
await writeFile(resolve(out), bytes);
console.log(`wrote ${out}: ${manifest.blueprintId} v${manifest.version}, ${bytes.byteLength} bytes (not installed)`);

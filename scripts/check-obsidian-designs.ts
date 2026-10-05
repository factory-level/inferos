import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Validate architecture design references without requiring access to the vault. */
export const validateObsidianDesigns = (source: string): string[] => {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!frontMatter) return ["missing YAML front matter"];

  let metadata: unknown;
  try {
    metadata = parse(frontMatter[1]);
  } catch (error) {
    return [`invalid YAML front matter: ${error instanceof Error ? error.message : String(error)}`];
  }

  const designs = isRecord(metadata) ? metadata.obsidian_designs : undefined;
  if (!Array.isArray(designs) || designs.length === 0) {
    return ["obsidian_designs must be a nonempty list"];
  }

  const errors: string[] = [];
  const notes = new Set<string>();
  for (const [index, design] of designs.entries()) {
    const label = `obsidian_designs[${index}]`;
    if (!isRecord(design)) {
      errors.push(`${label} must contain a note and optional sections`);
      continue;
    }

    const note = design.note;
    if (
      !isText(note) ||
      note !== note.trim() ||
      !note.endsWith(".md") ||
      /[\\:#\r\n\0]/.test(note) ||
      note.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      errors.push(`${label}.note must be a vault-relative Markdown path (no URL or heading)`);
    } else if (notes.has(note)) {
      errors.push(`${label}.note duplicates '${note}'; combine its sections in one entry`);
    } else {
      notes.add(note);
    }

    if (
      "sections" in design &&
      (!Array.isArray(design.sections) ||
        design.sections.length === 0 ||
        !design.sections.every(isText))
    ) {
      errors.push(`${label}.sections must be a nonempty list of heading names, or be omitted`);
    }
  }
  return errors;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = false;
  for (const file of process.argv.slice(2)) {
    if (["README.md", "_template.md", "_brain.md"].includes(basename(file))) continue;
    try {
      for (const error of validateObsidianDesigns(readFileSync(file, "utf8"))) {
        console.error(`ERROR: ${file}: ${error}`);
        failed = true;
      }
    } catch (error) {
      console.error(`ERROR: ${file}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

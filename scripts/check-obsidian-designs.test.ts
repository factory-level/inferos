import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { validateObsidianDesigns } from "./check-obsidian-designs.ts";

const document = (metadata: unknown) => `---\n${stringify(metadata)}---\n\n# Architecture\n`;

describe("Obsidian design references", () => {
  it("accepts multiple notes, optional sections, and notes outside the InferOS folder", () => {
    assert.deepEqual(
      validateObsidianDesigns(
        document({
          title: "Agent deployments",
          obsidian_designs: [
            {
              note: "software/InferOS/InferOS Agent Deployments.md",
              sections: ["Agent deployments"],
            },
            {
              note: "software/InferOS/InferOS IAM.md",
              sections: ["Gatekeepers", "Remote agent boundary"],
            },
            { note: "software/vocabulary/Local Agent.md" },
          ],
        }),
      ),
      [],
    );
  });

  for (const designs of [undefined, null, [], "note.md", ["note.md"], [{}]]) {
    it(`rejects missing or malformed mappings: ${JSON.stringify(designs)}`, () => {
      assert.notEqual(validateObsidianDesigns(document({ obsidian_designs: designs })).length, 0);
    });
  }

  for (const note of [
    "",
    "/note.md",
    "../note.md",
    "a/../note.md",
    "a//note.md",
    "C:\\note.md",
    "obsidian://open",
    "https://example.com/note.md",
    "note.txt",
    "note.md#Heading",
    42,
  ]) {
    it(`rejects invalid vault paths: ${JSON.stringify(note)}`, () => {
      assert.match(
        validateObsidianDesigns(document({ obsidian_designs: [{ note }] })).join("\n"),
        /vault-relative/,
      );
    });
  }

  for (const sections of [null, [], "Heading", [""], [" "], [42]]) {
    it(`rejects invalid sections: ${JSON.stringify(sections)}`, () => {
      assert.match(
        validateObsidianDesigns(
          document({ obsidian_designs: [{ note: "Note.md", sections }] }),
        ).join("\n"),
        /sections/,
      );
    });
  }

  it("requires sections of the same note to share one entry", () => {
    assert.match(
      validateObsidianDesigns(
        document({
          obsidian_designs: [
            { note: "Note.md", sections: ["One"] },
            { note: "Note.md", sections: ["Two"] },
          ],
        }),
      ).join("\n"),
      /duplicates/,
    );
  });

  it("reports invalid YAML and missing front matter", () => {
    assert.match(
      validateObsidianDesigns("---\nobsidian_designs: [\n---\n").join("\n"),
      /invalid YAML/,
    );
    assert.match(validateObsidianDesigns("# Architecture\n").join("\n"), /missing YAML/);
  });

  it("fails the CLI for an unmapped topic while exempting navigation and templates", () => {
    const directory = mkdtempSync(join(tmpdir(), "inferos-docs-"));
    try {
      const files = ["README.md", "_template.md", "_brain.md", "topic.md"].map((name) =>
        join(directory, name),
      );
      for (const file of files) writeFileSync(file, "# Documentation\n");
      const script = new URL("./check-obsidian-designs.ts", import.meta.url);
      const valid = spawnSync(process.execPath, [script.pathname, ...files.slice(0, 3)], {
        encoding: "utf8",
      });
      assert.equal(valid.status, 0, valid.stderr);
      const invalid = spawnSync(process.execPath, [script.pathname, ...files], {
        encoding: "utf8",
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /topic\.md: missing YAML/);
      assert.doesNotMatch(invalid.stderr, /README|_template|_brain/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

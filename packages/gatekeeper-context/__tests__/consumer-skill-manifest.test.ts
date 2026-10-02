import { describe, expect, it } from "vitest";
import { parseSkillManifest } from "../src/agent-skill";
// The wrapper CLI's restatement of parseSkillManifest (it must run under plain node); see its header.
import { parseConsumerSkillManifest } from "../../../scripts/consumer/skill-manifest.ts";

const outcome = (parse: () => unknown) => {
  try { return { ok: parse() }; } catch (error) { return { error: (error as Error).message }; }
};

const sources = [
  "---\nname: ok\ndescription: Does a thing.\n---\n# Body\n",
  "﻿---\nname: bom\ndescription: With a byte-order mark.\n---\n",
  "---\r\nname: crlf\r\ndescription:   padded   \r\n---\r\n",
  "---\nname: folded\ndescription: >\n  across\n  lines\nlicense: MIT\nmetadata:\n  owner: ops\n---\n",
  "# no frontmatter\n",
  "---\nname: unclosed\ndescription: x\n",
  "---\nname: [unbalanced\n---\n",
  "---\n- a list\n---\n",
  "---\ndescription: missing name\n---\n",
  "---\nname: no-description\n---\n",
  "---\nname: blank\ndescription: '   '\n---\n",
  "---\nname: Upper_Case\ndescription: x\n---\n",
  "---\nname: double--hyphen\ndescription: x\n---\n",
  `---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`,
  `---\nname: long-description\ndescription: ${"d".repeat(1025)}\n---\n`,
  "---\nname: 42\ndescription: x\n---\n",
];

describe("consumer skill manifest parity", () => {
  it.each(sources)("matches the Context Library for %j", source => {
    expect(outcome(() => parseConsumerSkillManifest(source)))
      .toEqual(outcome(() => parseSkillManifest("pack/skill/SKILL.md", source)));
  });
});

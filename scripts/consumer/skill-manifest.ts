import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The Context Library indexes a SKILL.md only when its frontmatter passes parseSkillManifest in
// packages/gatekeeper-context/src/agent-skill.ts, and silently skips it otherwise. That module cannot
// run under plain `node` (its relative imports name `.js` files), so these are its rules restated for
// the wrapper CLI; packages/gatekeeper-context/__tests__/consumer-skill-manifest.test.ts keeps the
// two in step.

/** Agent Skill frontmatter fields the Context Library reads. */
export interface ConsumerSkillManifest {
  /** Slash-command name: lowercase letters, numbers and single hyphens, at most 64 characters. */
  name: string;
  /** Trimmed description of at most 1024 characters; shown in the picker and agent catalog. */
  description: string;
}

const Frontmatter = z.object({
  name: z.string().min(1, "Skill name is required.").max(64, "Skill name must be at most 64 characters.")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name must use lowercase letters, numbers, and single hyphens."),
  description: z.string().transform(value => value.trim()).pipe(z.string()
    .min(1, "Skill description is required.").max(1024, "Skill description must be at most 1024 characters.")),
});

const isFence = (line: string) => line.startsWith("---") && line.slice(3).trim() === "";

/** Validate a SKILL.md source the way the Context Library will; throws a reason it would skip it. */
export function parseConsumerSkillManifest(source: string): ConsumerSkillManifest {
  const lines = (source.startsWith("\uFEFF") ? source.slice(1) : source).split(/\r?\n/);
  if (!isFence(lines[0] ?? "")) throw new Error("Skill manifest must start with YAML frontmatter.");
  const end = lines.findIndex((line, index) => index > 0 && isFence(line));
  if (end < 0) throw new Error("Skill manifest frontmatter is not closed.");
  let data: unknown;
  try { data = parseYaml(lines.slice(1, end).join("\n")); } catch { throw new Error("Skill frontmatter is not valid YAML."); }
  const result = Frontmatter.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.code === "invalid_type" && issue.path[0] === "name") throw new Error("Skill name is required.");
    if (issue?.code === "invalid_type" && issue.path[0] === "description") throw new Error("Skill description is required.");
    if (issue?.code === "invalid_type" && issue.path.length === 0) throw new Error("Skill frontmatter must be a mapping.");
    throw new Error(issue?.message ?? "Skill frontmatter is invalid.");
  }
  return { name: result.data.name, description: result.data.description };
}

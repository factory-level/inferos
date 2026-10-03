import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConsumerSkillManifest } from "./skill-manifest.ts";
import { checkConsumerSkills, collectSkillPack, defaultConsumerSkillsManifest, readConsumerSkillsManifest, STARTER_SKILL_PACKS } from "./skills.ts";

const skill = (name: string, description = `Use ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function wrapper(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "inferos-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, body: string | Uint8Array) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const manifest = defaultConsumerSkillsManifest();
  const save = () => write("inferos.skills.json", JSON.stringify(manifest));
  save();
  return { root, write, manifest, save };
}

test("starter packs ship valid skills for every default pack", () => {
  const root = fileURLToPath(new URL("skill-packs", import.meta.url));
  for (const pack of STARTER_SKILL_PACKS) {
    const collected = collectSkillPack(dirname(root), { ...defaultConsumerSkillsManifest(), packs: {
      [pack]: { title: pack, description: "", directory: `skill-packs/${pack}`, include: [] },
    } }, pack);
    assert.ok(collected.skills.length > 0, `${pack} has a starter skill`);
  }
});

test("collects pack files, includes installed skills and drops excluded output", t => {
  const w = wrapper(t);
  w.write("skills/build/gadget/SKILL.md", skill("gadget"));
  w.write("skills/build/gadget/references/notes.md", "# Notes\n");
  w.write("skills/build/shared.json", "{}");
  w.write(".agents/skills/skill-creator/SKILL.md", skill("skill-creator", "Create skills.\n  Long form."));
  w.write(".agents/skills/skill-creator/assets/logo.png", new Uint8Array([137, 80, 78, 71]));
  w.write(".agents/skills/skill-creator/evals/evals.json", "{}");
  w.write("skills/build/gadget-workspace/iteration-1/out.md", "draft");
  const pack = collectSkillPack(w.root, readConsumerSkillsManifest(w.root), "build");
  assert.deepEqual(pack.files.map(file => file.path).toSorted(), [
    "gadget/SKILL.md", "gadget/references/notes.md", "shared.json",
    "skill-creator/SKILL.md", "skill-creator/assets/logo.png",
  ]);
  assert.deepEqual(pack.skills, [{ name: "gadget", path: "gadget/SKILL.md" }, { name: "skill-creator", path: "skill-creator/SKILL.md" }]);
  const logo = pack.files.find(file => file.path.endsWith("logo.png"));
  assert.equal(logo?.contentType, "image/png");
  assert.equal(logo?.body, Buffer.from([137, 80, 78, 71]).toString("base64"));
  assert.equal(pack.files.find(file => file.path === "gadget/SKILL.md")?.description, "Use gadget.");
  assert.deepEqual(pack.warnings, []);
});

test("a missing include warns instead of failing so fresh wrappers still check", t => {
  const w = wrapper(t);
  w.write("skills/build/gadget/SKILL.md", skill("gadget"));
  const { warnings } = checkConsumerSkills(w.root);
  assert.ok(warnings.some(warning => warning.includes("pnpm skills:install")));
});

test("rejects SKILL.md files the Context Library would silently skip", t => {
  const w = wrapper(t);
  w.write("skills/shared/bad/SKILL.md", skill("Bad_Name"));
  assert.throws(() => checkConsumerSkills(w.root), /bad\/SKILL.md: Skill name must use lowercase/);
  w.write("skills/shared/bad/SKILL.md", "# no frontmatter\n");
  assert.throws(() => checkConsumerSkills(w.root), /must start with YAML frontmatter/);
});

test("skill names must be unique across packs", t => {
  const w = wrapper(t);
  w.write("skills/operate/triage/SKILL.md", skill("triage"));
  w.write("skills/shared/triage/SKILL.md", skill("triage"));
  assert.throws(() => checkConsumerSkills(w.root), /defined in both operate and shared/);
});

test("rejects links, oversized files and paths outside the wrapper", t => {
  const w = wrapper(t);
  w.write("skills/operate/a/SKILL.md", skill("a"));
  symlinkSync("/etc/hostname", join(w.root, "skills/operate/a/leak.txt"));
  assert.throws(() => checkConsumerSkills(w.root), /symbolic link/);
  rmSync(join(w.root, "skills/operate/a/leak.txt"));
  w.write("skills/operate/a/big.txt", new Uint8Array(1_800_001));
  assert.throws(() => checkConsumerSkills(w.root), /document limit/);
  rmSync(join(w.root, "skills/operate/a/big.txt"));
  w.manifest.packs.operate.directory = "../outside";
  w.save();
  assert.throws(() => readConsumerSkillsManifest(w.root), /normalized wrapper-relative directory/);
});

test("manifest parsing rejects unknown shapes and duplicate titles", t => {
  const w = wrapper(t);
  w.manifest.packs.shared.title = w.manifest.packs.build.title;
  w.save();
  assert.throws(() => readConsumerSkillsManifest(w.root), /titles must be unique/);
  w.write("inferos.skills.json", JSON.stringify({ schemaVersion: 2, packs: {}, exclude: [] }));
  assert.throws(() => readConsumerSkillsManifest(w.root), /schemaVersion 1/);
});

test("frontmatter parsing accepts folded descriptions and extra fields", () => {
  assert.deepEqual(parseConsumerSkillManifest("---\nname: x\ndescription: >\n  folded\n  text\nlicense: MIT\n---\n"), { name: "x", description: "folded text" });
});

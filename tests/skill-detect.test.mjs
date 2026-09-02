/**
 * Deteccao das 3 skills obrigatorias (webapp-testing, frontend-design,
 * ui-ux-pro-max). `ok: true` exige frontmatter `name:` batendo exatamente —
 * um diretorio vazio ou com a skill errada nunca conta como "instalada".
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_SKILLS,
  detectRequiredSkills,
  detectSkill,
  readSkillFrontmatterName,
} from "../skills/testador-subagents/scripts/lib/skill-detect.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-detect-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeSkill(dir, name, frontmatterName = name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: test fixture\n---\n\n# ${name}\n`,
    "utf8",
  );
}

test("detects a skill installed at project level (.claude/skills/<name>/SKILL.md)", () => {
  const root = fixture();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeSkill(join(root, ".claude", "skills", "webapp-testing"), "webapp-testing");

  const result = detectSkill("webapp-testing", { home, cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.evidence[0].type, "project");
});

test("detects a skill installed at user (home) level", () => {
  const root = fixture();
  const home = join(root, "home");
  writeSkill(join(home, ".claude", "skills", "frontend-design"), "frontend-design");

  const result = detectSkill("frontend-design", { home, cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.evidence[0].type, "home");
});

test("detects a skill bundled inside an installed marketplace plugin cache", () => {
  const root = fixture();
  const home = join(root, "home");
  const pluginSkillDir = join(home, ".claude", "plugins", "cache", "anthropic-agent-skills", "example-skills", "1.0.0", "skills", "webapp-testing");
  writeSkill(pluginSkillDir, "webapp-testing");

  const result = detectSkill("webapp-testing", { home, cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.evidence[0].type, "plugin");
  assert.equal(result.evidence[0].marketplace, "anthropic-agent-skills");
});

test("an empty directory (no SKILL.md) never counts as installed", () => {
  const root = fixture();
  const home = join(root, "home");
  mkdirSync(join(root, ".claude", "skills", "ui-ux-pro-max"), { recursive: true });
  mkdirSync(home, { recursive: true });

  const result = detectSkill("ui-ux-pro-max", { home, cwd: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.evidence, []);
});

test("a directory with mismatched frontmatter name is rejected (not a false positive)", () => {
  const root = fixture();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // Directory is named "webapp-testing" but SKILL.md's own frontmatter says something else.
  writeSkill(join(root, ".claude", "skills", "webapp-testing"), "webapp-testing", "totally-different-skill");

  const result = detectSkill("webapp-testing", { home, cwd: root });
  assert.equal(result.ok, false);
});

test("readSkillFrontmatterName extracts the name field, tolerating quotes", () => {
  const root = fixture();
  const path = join(root, "SKILL.md");
  writeFileSync(path, '---\nname: "quoted-name"\ndescription: x\n---\n', "utf8");
  assert.equal(readSkillFrontmatterName(path), "quoted-name");
});

test("readSkillFrontmatterName returns null for a file with no frontmatter", () => {
  const root = fixture();
  const path = join(root, "SKILL.md");
  writeFileSync(path, "# just a heading, no frontmatter\n", "utf8");
  assert.equal(readSkillFrontmatterName(path), null);
});

test("detectRequiredSkills covers exactly the 3 mandatory skills", () => {
  const root = fixture();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const result = detectRequiredSkills({ home, cwd: root });
  assert.deepEqual(Object.keys(result).sort(), [...REQUIRED_SKILLS].sort());
  for (const name of REQUIRED_SKILLS) assert.equal(result[name].ok, false);
});

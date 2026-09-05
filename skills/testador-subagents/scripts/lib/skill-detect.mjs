import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Detection of the skills this plugin treats as mandatory (decision: they
 * are wired to specific phases/gates, not optional reference material — see
 * SKILL.md "Principios" and `references/skills-integration.md`).
 *
 * Unlike an MCP server, a skill has no CLI to query — its only observable
 * signature is a `SKILL.md` file with a matching `name:` in its YAML
 * frontmatter, at one of a few conventional locations:
 *   - project-level: `<cwd>/.claude/skills/<name>/SKILL.md`
 *   - user-level:    `<home>/.claude/skills/<name>/SKILL.md`
 *   - bundled inside an installed marketplace plugin:
 *     `<home>/.claude/plugins/cache/<marketplace>/<plugin>[/<version>]/skills/<name>/SKILL.md`
 *     (the `example-skills` plugin from the `anthropic-agent-skills`
 *     marketplace ships `webapp-testing` and `frontend-design` this way).
 *
 * Frontmatter `name` is validated so an empty or mismatched directory never
 * counts as evidence — a directory that exists but holds the wrong skill (or
 * no parseable frontmatter at all) is not "installed".
 */

export const REQUIRED_SKILLS = Object.freeze(["webapp-testing", "frontend-design", "ui-ux-pro-max"]);

// `frontend-design` and `ui-ux-pro-max` are shipped by cc-pensador (a
// sibling plugin, declared as a real dependency in plugin.json — WF-005 /
// DEC-007) — installing it satisfies both. `webapp-testing` is the only one
// of the three that is genuinely third-party (anthropics/skills).
export const SKILL_INSTALL_COMMANDS = Object.freeze({
  "webapp-testing": "npx skills add https://github.com/anthropics/skills --skill webapp-testing",
  "frontend-design": "Install the cc-pensador plugin (it ships this skill) — /plugin install cc-pensador@cc-pensador",
  "ui-ux-pro-max": "Install the cc-pensador plugin (it ships this skill) — /plugin install cc-pensador@cc-pensador",
});

/** Which phase(s)/gate(s) each mandatory skill is wired to — surfaced in preflight remediation. */
export const SKILL_USAGE = Object.freeze({
  "webapp-testing": "Fases 4-5 (subida da stack e exploracao MCP) — gates stack/smoke",
  "frontend-design": "Fase 8 (validacao UI/UX) — gate uiux",
  "ui-ux-pro-max": "Fase 8 (validacao UI/UX) — gate uiux",
});

export function defaultSkillContext() {
  return { home: homedir(), cwd: process.cwd() };
}

export function skillCandidatePaths(name, ctx = defaultSkillContext()) {
  return [
    { type: "project", path: join(ctx.cwd, ".claude", "skills", name, "SKILL.md") },
    { type: "home", path: join(ctx.home, ".claude", "skills", name, "SKILL.md") },
  ];
}

/** Extracts the `name:` field from a SKILL.md's YAML frontmatter, or `null` if absent/unparseable. */
export function readSkillFrontmatterName(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const nameLine = frontmatter[1].match(/^name:\s*(.+?)\s*$/m);
  if (!nameLine) return null;
  return nameLine[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * Scans `<home>/.claude/plugins/cache/<marketplace>/<plugin>[/<version>]/skills/<name>/SKILL.md`
 * for every installed marketplace plugin. Bounded to two directory levels
 * (marketplace, plugin) plus an optional version level — never a recursive
 * filesystem walk.
 */
export function findSkillInPluginsCache(name, ctx = defaultSkillContext()) {
  const cacheDir = join(ctx.home, ".claude", "plugins", "cache");
  if (!existsSync(cacheDir)) return [];
  const hits = [];
  let marketplaces = [];
  try {
    marketplaces = readdirSync(cacheDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  for (const marketplace of marketplaces) {
    const marketplaceDir = join(cacheDir, marketplace.name);
    let plugins = [];
    try {
      plugins = readdirSync(marketplaceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      const pluginDir = join(marketplaceDir, plugin.name);
      const direct = join(pluginDir, "skills", name, "SKILL.md");
      if (existsSync(direct)) {
        hits.push({ marketplace: marketplace.name, plugin: plugin.name, version: null, path: direct });
      }
      let versions = [];
      try {
        versions = readdirSync(pluginDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch {
        versions = [];
      }
      for (const version of versions) {
        const versioned = join(pluginDir, version.name, "skills", name, "SKILL.md");
        if (existsSync(versioned)) {
          hits.push({ marketplace: marketplace.name, plugin: plugin.name, version: version.name, path: versioned });
        }
      }
    }
  }
  return hits;
}

/**
 * Detects one skill by name. `ok: true` only when at least one candidate
 * exists AND its frontmatter `name` matches exactly.
 */
export function detectSkill(name, ctx = defaultSkillContext()) {
  const evidence = [];
  for (const candidate of skillCandidatePaths(name, ctx)) {
    if (!existsSync(candidate.path)) continue;
    if (readSkillFrontmatterName(candidate.path) === name) {
      evidence.push({ type: candidate.type, path: candidate.path });
    }
  }
  for (const hit of findSkillInPluginsCache(name, ctx)) {
    if (readSkillFrontmatterName(hit.path) === name) {
      evidence.push({
        type: "plugin",
        marketplace: hit.marketplace,
        plugin: hit.plugin,
        version: hit.version,
        path: hit.path,
      });
    }
  }
  return {
    ok: evidence.length > 0,
    name,
    evidence,
    error: evidence.length > 0 ? null : `Skill "${name}" not detected in known locations.`,
    install: SKILL_INSTALL_COMMANDS[name] ?? null,
  };
}

/** Detects every mandatory skill. Returns `{ [name]: detectSkill(...) }`. */
export function detectRequiredSkills(ctx = defaultSkillContext()) {
  const result = {};
  for (const name of REQUIRED_SKILLS) result[name] = detectSkill(name, ctx);
  return result;
}

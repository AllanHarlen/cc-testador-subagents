#!/usr/bin/env node
/**
 * Preflight check for cc-testador-subagents.
 *
 * Unlike cc-executor-subagents, this plugin's Required_CLI_Set is not
 * derived from a Project_Config role table — the stack is fixed (Claude Code
 * puro, no Codex/AGY), so the set of mandatory items is fixed too:
 *
 *  - Node.js >= 22 on PATH
 *  - Playwright MCP registered in a known Claude Code MCP config location
 *  - The 3 mandatory skills: webapp-testing, frontend-design, ui-ux-pro-max
 *    (decision: they are wired to specific phases/gates, NOT optional
 *    reference material — see SKILL.md "Principios")
 *  - Chromium downloaded for Playwright (`npx playwright install chromium`)
 *  - A Bash permission covering `node` and `npx` (auto-remediated)
 *
 * Optional (never blocking):
 *  - `.testador/project-config.md` (informative — defaults apply when absent)
 *  - Python 3 on PATH (enables `with_server.py` from webapp-testing;
 *    `serverLifecycle: auto` falls back to the Node equivalent otherwise)
 *  - `openspec` CLI (ingestion reads openspec/ files directly; the CLI only
 *    complements as a completeness check, never a prerequisite)
 *  - Context7 MCP
 *
 * Report contract (schemaVersion 1, mirrors the shape cc-executor-subagents
 * settled on): `checks` is FLAT (`checks.{config,cli,mcp,skills,capabilities,
 * permissions,optional}`); every check under the first five carries
 * `required: true|false`; `failed` holds only failing REQUIRED checks;
 * failing optional checks go to `warnings` with a `reason`
 * (`NOT_DETECTED`). Exit code is 0 iff `status === "ok"`.
 *
 * Usage:
 *   node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs"
 *   node scripts/preflight.mjs # compatibility wrapper
 */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProjectConfig } from "./lib/project-config.mjs";
import { ProjectConfigError } from "./lib/project-config.mjs";
import {
  CONTEXT7_BINARY_NAMES,
  CONTEXT7_CONFIG_CANDIDATES,
  CONTEXT7_DEFINITION_MARKERS,
  CONTEXT7_SERVER_NAMES,
  CONTEXT7_SKILL_CANDIDATES,
  PLAYWRIGHT_CONFIG_CANDIDATES,
  PLAYWRIGHT_DEFINITION_MARKERS,
  PLAYWRIGHT_SERVER_NAMES,
  resolveCandidate,
} from "./lib/mcp-candidates.mjs";
import { REQUIRED_SKILLS, SKILL_INSTALL_COMMANDS, SKILL_USAGE, detectRequiredSkills } from "./lib/skill-detect.mjs";

const HOME = homedir();
const PROJECT_ROOT = process.cwd();
const PROJECT_CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const PROJECT_SETTINGS_FILE = join(PROJECT_CLAUDE_DIR, "settings.json");
const MIN_NODE_VERSION = "22.0.0";
const PREFLIGHT_SCHEMA_VERSION = 1;

function parseSemver(version) {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map((part) => Number(part)), prerelease: match[4]?.split(".") ?? [] };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index] - b.core[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function checkNodeVersion() {
  const version = process.version;
  const ok = compareSemver(version, MIN_NODE_VERSION) >= 0;
  return { ok, version, minVersion: MIN_NODE_VERSION, error: ok ? null : `Node ${MIN_NODE_VERSION}+ is required (found ${version})` };
}

function checkCli(cli) {
  try {
    const out = execSync(`${cli} --version`, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).toString().trim();
    return { ok: true, version: out.split(/\r?\n/)[0] };
  } catch (err) {
    return { ok: false, error: err.message?.split(/\r?\n/)[0] ?? "not found" };
  }
}

function checkPython3() {
  const candidates = platform() === "win32" ? ["python", "py -3"] : ["python3", "python"];
  for (const cli of candidates) {
    const result = checkCli(cli);
    if (result.ok && /^3\./.test(result.version.replace(/^Python\s*/i, ""))) {
      return { ok: true, cli, version: result.version };
    }
  }
  return { ok: false, error: "Python 3 not found on PATH; serverLifecycle will use the Node fallback." };
}

function checkOpenspecCli() {
  return checkCli("openspec");
}

/** `<path>` normalized for the `projects` key match in `~/.claude.json`. */
function normalizePathKey(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function readMcpServerMaps(file, cwd) {
  let json;
  try {
    if (!existsSync(file)) return [];
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!json || typeof json !== "object") return [];
  const maps = [];
  if (json.mcpServers && typeof json.mcpServers === "object") {
    maps.push({ servers: json.mcpServers, disabled: [] });
  }
  if (json.projects && typeof json.projects === "object") {
    const wanted = normalizePathKey(cwd);
    for (const [key, project] of Object.entries(json.projects)) {
      if (normalizePathKey(key) !== wanted) continue;
      if (project?.mcpServers && typeof project.mcpServers === "object") {
        maps.push({
          servers: project.mcpServers,
          disabled: Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers : [],
        });
      }
    }
  }
  return maps;
}

function findMcpServer(files, cwd, names, markers = []) {
  const wanted = names.map((n) => n.toLowerCase());
  const wantedMarkers = markers.map((m) => m.toLowerCase());
  for (const file of files) {
    for (const { servers, disabled } of readMcpServerMaps(file, cwd)) {
      const off = new Set(disabled.map((n) => String(n).toLowerCase()));
      for (const [name, definition] of Object.entries(servers)) {
        const key = name.toLowerCase();
        if (off.has(key)) continue;
        if (wanted.includes(key)) return { path: file, server: name };
        if (wantedMarkers.length === 0) continue;
        let blob = "";
        try {
          blob = JSON.stringify(definition ?? "").toLowerCase();
        } catch {
          blob = "";
        }
        if (wantedMarkers.some((m) => blob.includes(m))) return { path: file, server: name };
      }
    }
  }
  return null;
}

function findMcpServerAcrossCandidates(candidates, ctx, names, markers = []) {
  const jsonPaths = candidates.map((c) => resolveCandidate(c, ctx));
  return findMcpServer(jsonPaths, ctx.cwd, names, markers);
}

function checkPlaywrightMcp() {
  const ctx = { home: HOME, cwd: PROJECT_ROOT };
  const hit = findMcpServerAcrossCandidates(
    PLAYWRIGHT_CONFIG_CANDIDATES,
    ctx,
    PLAYWRIGHT_SERVER_NAMES,
    PLAYWRIGHT_DEFINITION_MARKERS,
  );
  if (hit) return { ok: true, evidence: [{ type: "mcp-config", path: hit.path, server: hit.server }] };
  return {
    ok: false,
    error: "Playwright MCP not detected in known Claude Code MCP config locations.",
    install: ["claude mcp add playwright npx @playwright/mcp@latest"],
  };
}

function checkContext7Mcp() {
  const ctx = { home: HOME, cwd: PROJECT_ROOT };
  const evidence = [];
  for (const candidate of CONTEXT7_SKILL_CANDIDATES) {
    const path = resolveCandidate(candidate, ctx);
    if (existsSync(path)) evidence.push({ type: "skill", path });
  }
  const cli = checkCli(CONTEXT7_BINARY_NAMES[0]);
  if (cli.ok) evidence.push({ type: "binary", path: CONTEXT7_BINARY_NAMES[0] });
  const hit = findMcpServerAcrossCandidates(CONTEXT7_CONFIG_CANDIDATES, ctx, CONTEXT7_SERVER_NAMES, CONTEXT7_DEFINITION_MARKERS);
  if (hit) evidence.push({ type: "mcp-config", path: hit.path, server: hit.server });
  if (evidence.length > 0) return { ok: true, evidence };
  return { ok: false, error: "Context7 MCP not detected in known locations.", install: ["npx ctx7 setup --claude"] };
}

/**
 * Playwright downloads browsers into a per-OS cache directory (or
 * `PLAYWRIGHT_BROWSERS_PATH` when set), never into the plugin or the
 * project. Presence is detected by any `chromium-*` subdirectory existing —
 * this is a heuristic (it does not invoke Playwright's own resolver), good
 * enough for a preflight gate; `npx playwright install chromium` is
 * idempotent if this heuristic under- or over-reports.
 */
function playwrightBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local"), "ms-playwright");
  if (platform() === "darwin") return join(HOME, "Library", "Caches", "ms-playwright");
  return join(HOME, ".cache", "ms-playwright");
}

/**
 * Raiz do plugin: este arquivo vive em `skills/testador-subagents/scripts/`;
 * tres niveis acima chega na raiz (`scripts` -> `testador-subagents` ->
 * `skills` -> raiz). Aceita `CLAUDE_PLUGIN_ROOT` como override.
 */
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return resolve(process.env.CLAUDE_PLUGIN_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Verifica que os pacotes de runtime que `runner/` importa
 * (`@playwright/test`, `@axe-core/playwright`) sao de fato resolviveis a
 * partir da raiz do plugin -- nao apenas que o `package.json` os declara.
 * `createRequire(...).resolve()` e o unico jeito confiavel de confirmar que
 * `npm install` de fato populou `node_modules`; o antigo
 * `checkChromiumInstalled()` inspeciona um cache de browsers completamente
 * desconectado do `node_modules` do plugin e nunca detectaria esta classe
 * de falha (dependencia declarada em package.json, nunca instalada).
 */
function checkPluginDependencies() {
  const pluginRoot = resolvePluginRoot();
  const require = createRequire(join(pluginRoot, "package.json"));
  const packages = ["@playwright/test", "@axe-core/playwright"];
  const missing = [];
  const resolved = {};
  for (const pkg of packages) {
    try {
      resolved[pkg] = require.resolve(pkg);
    } catch {
      missing.push(pkg);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      pluginRoot,
      missing,
      error: `Missing plugin runtime dependencies: ${missing.join(", ")}.`,
      install: [`npm install --prefix "${pluginRoot}"`],
    };
  }
  return { ok: true, pluginRoot, resolved };
}

function checkChromiumInstalled() {
  const dir = playwrightBrowsersDir();
  if (!existsSync(dir)) {
    return { ok: false, dir, error: "Playwright browsers cache not found.", install: ["npx playwright install chromium"] };
  }
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, dir, error: "Playwright browsers cache is not readable.", install: ["npx playwright install chromium"] };
  }
  const chromium = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium"));
  if (chromium.length > 0) return { ok: true, dir, versions: chromium.map((entry) => entry.name) };
  return { ok: false, dir, error: "No chromium-* directory found in the Playwright browsers cache.", install: ["npx playwright install chromium"] };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** A rule that grants Bash access to `node` and one that grants it to `npx` — both required. */
function bashRuleGrants(rule, tool) {
  if (typeof rule !== "string") return false;
  const normalized = rule.replace(/\s+/g, " ").trim();
  return normalized === "Bash" || normalized === "Bash(*)" || normalized === `Bash(${tool}:*)`;
}

function checkTestadorBashPermission() {
  const candidates = [
    PROJECT_SETTINGS_FILE,
    join(PROJECT_CLAUDE_DIR, "settings.local.json"),
    join(HOME, ".claude", "settings.json"),
    join(HOME, ".claude", "settings.local.json"),
  ];
  const inspected = [];
  const parseErrors = [];
  let nodeMatch = null;
  let npxMatch = null;

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, "utf8"));
      const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
      inspected.push({ path: file, allow: allow.filter((rule) => String(rule).startsWith("Bash")) });
      if (!nodeMatch) nodeMatch = allow.find((rule) => bashRuleGrants(rule, "node")) ? { path: file } : null;
      if (!npxMatch) npxMatch = allow.find((rule) => bashRuleGrants(rule, "npx")) ? { path: file } : null;
      if (nodeMatch && npxMatch) return { ok: true, nodeMatch, npxMatch };
    } catch (err) {
      parseErrors.push({ path: file, error: err.message?.split(/\r?\n/)[0] ?? "cannot parse settings file" });
    }
  }

  return {
    ok: nodeMatch != null && npxMatch != null,
    nodeMatch,
    npxMatch,
    error: "Missing Claude Code permission to run node and npx via Bash. Add Bash(node:*) and Bash(npx:*).",
    expected: 'permissions.allow includes "Bash(node:*)" and "Bash(npx:*)"',
    inspected,
    parseErrors,
  };
}

/**
 * Auto-remediates a missing node/npx Bash permission by appending the two
 * rules to the project's `.claude/settings.json`. Refuses to touch the file
 * when it exists but is invalid JSON, has a non-object root, a non-object
 * `permissions`, or a non-array `permissions.allow` — in every refusal case
 * the prior file is left byte-for-byte intact.
 */
function autoRemediateTestadorBashPermission(initialCheck) {
  const fileExistedBefore = existsSync(PROJECT_SETTINGS_FILE);
  const result = { attempted: false, changed: false, target: PROJECT_SETTINGS_FILE, action: "none", revalidated: false, ok: initialCheck.ok };
  if (initialCheck.ok) return result;

  const projectParseError = initialCheck.parseErrors?.find((entry) => entry.path === PROJECT_SETTINGS_FILE);
  if (projectParseError) {
    return { ...result, attempted: true, action: "blocked-invalid-json", error: "Auto-remediation skipped: .claude/settings.json contains invalid JSON. Fix it manually and rerun preflight.", ok: false };
  }

  let settings = {};
  if (fileExistedBefore) {
    try {
      settings = JSON.parse(readFileSync(PROJECT_SETTINGS_FILE, "utf8"));
    } catch (err) {
      return { ...result, attempted: true, action: "blocked-invalid-json", error: err.message?.split(/\r?\n/)[0] ?? "could not be parsed", ok: false };
    }
  }
  if (!isPlainObject(settings)) {
    return { ...result, attempted: true, action: "blocked-non-object-root", error: ".claude/settings.json must contain a JSON object at the root.", ok: false };
  }
  const permissions = settings.permissions;
  if (permissions != null && !isPlainObject(permissions)) {
    return { ...result, attempted: true, action: "blocked-invalid-permissions-shape", error: ".claude/settings.json has a non-object permissions field.", ok: false };
  }
  const allow = permissions?.allow;
  if (allow != null && !Array.isArray(allow)) {
    return { ...result, attempted: true, action: "blocked-invalid-allow-shape", error: ".claude/settings.json has permissions.allow in a non-array format.", ok: false };
  }

  const missingRules = [];
  if (!(allow ?? []).some((rule) => bashRuleGrants(rule, "node"))) missingRules.push("Bash(node:*)");
  if (!(allow ?? []).some((rule) => bashRuleGrants(rule, "npx"))) missingRules.push("Bash(npx:*)");

  const nextSettings = { ...settings, permissions: { ...(permissions ?? {}), allow: [...(allow ?? []), ...missingRules] } };
  mkdirSync(PROJECT_CLAUDE_DIR, { recursive: true });
  writeFileSync(PROJECT_SETTINGS_FILE, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  const revalidated = checkTestadorBashPermission();
  return {
    attempted: true,
    changed: true,
    target: PROJECT_SETTINGS_FILE,
    action: fileExistedBefore ? "updated-settings-json" : "created-settings-json",
    revalidated: revalidated.ok,
    ok: revalidated.ok,
    error: revalidated.ok ? null : revalidated.error,
  };
}

function checkProjectConfig() {
  try {
    const resolved = readProjectConfig(PROJECT_ROOT);
    return { ok: true, exists: resolved.exists, source: resolved.source, path: ".testador/project-config.md" };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    return {
      ok: false,
      exists: true,
      source: "invalid",
      path: error.details?.path ?? ".testador/project-config.md",
      code: error.code,
      error: error.message,
    };
  }
}

const CHECK_ONLY = process.argv.includes("--check-only") || process.argv.includes("--dry-run");

const initialBash = checkTestadorBashPermission();
const autoRemediation = CHECK_ONLY
  ? { attempted: false, changed: false, target: PROJECT_SETTINGS_FILE, action: "skipped-check-only", revalidated: false, ok: initialBash.ok }
  : autoRemediateTestadorBashPermission(initialBash);
const finalBash = CHECK_ONLY ? initialBash : checkTestadorBashPermission();

const skillChecks = detectRequiredSkills({ home: HOME, cwd: PROJECT_ROOT });

const checks = {
  config: {
    "project-config": checkProjectConfig(),
  },
  cli: {
    node: checkNodeVersion(),
  },
  mcp: {
    playwright: checkPlaywrightMcp(),
  },
  skills: skillChecks,
  capabilities: {
    "chromium-installed": checkChromiumInstalled(),
    "plugin-deps-installed": checkPluginDependencies(),
  },
  permissions: {
    "bash-node-npx": finalBash,
  },
  optional: {
    python3: checkPython3(),
    openspec: checkOpenspecCli(),
    mcp: {
      context7: checkContext7Mcp(),
    },
  },
};

/**
 * Everything under config/cli/mcp/skills/capabilities/permissions is
 * required, except `config.project-config` (informative — defaults apply).
 * This mirrors the executor's `REQUIRED_BY_CHECK` map but the boolean is
 * fixed here, not derived from a Project_Config role table.
 */
const REQUIRED_BY_CHECK = {
  config: { "project-config": false },
  cli: { node: true },
  mcp: { playwright: true },
  skills: Object.fromEntries(REQUIRED_SKILLS.map((name) => [name, true])),
  capabilities: { "chromium-installed": true, "plugin-deps-installed": true },
  permissions: { "bash-node-npx": true },
};

const CATEGORY_LABEL = {
  config: "config",
  cli: "cli",
  mcp: "mcp",
  skills: "skill",
  capabilities: "capability",
  permissions: "permission",
};

const failed = [];
const warnings = [];

for (const [name, result] of Object.entries(checks.optional)) {
  if (name === "mcp") {
    for (const [mcpName, mcpResult] of Object.entries(result)) {
      if (mcpResult.ok) continue;
      warnings.push({ category: "mcp", name: mcpName, required: false, reason: "NOT_DETECTED" });
    }
    continue;
  }
  if (result.ok) continue;
  warnings.push({ category: "optional", name, required: false, reason: "NOT_DETECTED" });
}

for (const [group, results] of Object.entries(REQUIRED_BY_CHECK)) {
  for (const [name, required] of Object.entries(results)) {
    const result = checks[group][name];
    result.required = required;
    if (result.ok) continue;
    if (required) {
      failed.push({ category: CATEGORY_LABEL[group], name, ...result });
      continue;
    }
    warnings.push({ category: CATEGORY_LABEL[group], name, required: false, reason: "NOT_REQUIRED" });
  }
}

const status = failed.length === 0 ? "ok" : "failed";

function remediationFor(f) {
  const key = `${f.category}:${f.name}`;
  if (f.category === "skill") {
    return {
      target: `skill:${f.name}`,
      steps: [
        `Skill "${f.name}" is mandatory (${SKILL_USAGE[f.name] ?? "used by this plugin"}).`,
        `Install it: ${SKILL_INSTALL_COMMANDS[f.name]}`,
      ],
      docs: null,
    };
  }
  switch (key) {
    case "cli:node":
      return { target: "node", steps: [`Install Node.js ${MIN_NODE_VERSION}+ and make sure it is on PATH.`], docs: "https://nodejs.org" };
    case "mcp:playwright":
      return {
        target: "playwright-mcp",
        steps: ["Register the Playwright MCP server in Claude Code:", "  claude mcp add playwright npx @playwright/mcp@latest"],
        docs: "https://github.com/microsoft/playwright-mcp",
      };
    case "capability:chromium-installed":
      return { target: "playwright-chromium", steps: ["Download the Chromium browser Playwright needs:", "  npx playwright install chromium"], docs: null };
    case "capability:plugin-deps-installed":
      return {
        target: "plugin-runtime-deps",
        steps: [
          `Install this plugin's own runtime dependencies (@playwright/test, @axe-core/playwright): ${f.install?.[0] ?? 'npm install --prefix "${CLAUDE_PLUGIN_ROOT}"'}`,
          "This also runs the postinstall hook that downloads Chromium.",
        ],
        docs: null,
      };
    case "permission:bash-node-npx":
      return {
        target: "Claude Code permission: node/npx via Bash",
        steps: [
          "Auto-remediation attempted and failed - see autoRemediation.error in this report.",
          "Create or update .claude/settings.json in the target project:",
          '  { "permissions": { "allow": ["Bash(node:*)", "Bash(npx:*)"] } }',
          "Reload Claude Code before running /testador again.",
        ],
        docs: "https://docs.anthropic.com/en/docs/claude-code/settings",
      };
    default:
      return { target: f.name, steps: ["Check the dependency manually."], docs: null };
  }
}

const report = {
  schemaVersion: PREFLIGHT_SCHEMA_VERSION,
  status,
  generatedAt: new Date().toISOString(),
  checks,
  autoRemediation,
  warnings,
  failed,
  remediation: failed.length === 0 ? null : failed.map(remediationFor),
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === "ok" ? 0 : 1);

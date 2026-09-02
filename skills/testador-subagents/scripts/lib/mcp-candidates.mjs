import { join } from "node:path";

/**
 * Candidate locations probed by preflight detection for the MCP servers this
 * plugin cares about: Playwright (mandatory — the only automation surface
 * the whole workflow depends on) and Context7 (optional — current docs for
 * libs/frameworks/APIs, same server the sibling plugins treat as optional).
 *
 * Unlike `cc-executor-subagents`, this plugin has no Codex/AGY dependency
 * (Project_Config decision: Claude Code puro), so candidates are trimmed to
 * locations Claude Code itself (or an IDE built on it, e.g. Kiro) reads —
 * no `~/.codex/config.toml`, no Gemini/Antigravity-specific paths.
 *
 * Each config candidate is `{ base: "cwd" | "home", segments: string[], format: "json" }`.
 */

export const CLAUDE_MCP_CONFIG_CANDIDATES = Object.freeze([
  { base: "cwd", segments: [".mcp.json"], format: "json" },
  { base: "cwd", segments: [".kiro", "settings", "mcp.json"], format: "json" },
  { base: "home", segments: [".claude.json"], format: "json" },
  { base: "home", segments: [".claude", ".mcp.json"], format: "json" },
  { base: "home", segments: [".claude", "mcp.json"], format: "json" },
  { base: "home", segments: [".claude", "settings", "mcp.json"], format: "json" },
  { base: "home", segments: [".config", "claude", "mcp.json"], format: "json" },
  { base: "home", segments: [".kiro", "settings", "mcp.json"], format: "json" },
]);

export const PLAYWRIGHT_CONFIG_CANDIDATES = CLAUDE_MCP_CONFIG_CANDIDATES;
export const PLAYWRIGHT_SERVER_NAMES = Object.freeze(["playwright", "playwright-mcp"]);
/**
 * Marker instead of relying on the server NAME alone: a project could
 * register the server under a custom key (`"pw"`, `"browser"`) or, the
 * inverse risk documented in the sibling plugins' Context7 detection, a
 * common name like "playwright" could collide with an unrelated definition
 * whose command/args happen to contain that substring. The package spec is
 * a stable, low-collision signal either way.
 */
export const PLAYWRIGHT_DEFINITION_MARKERS = Object.freeze(["@playwright/mcp"]);

export const CONTEXT7_CONFIG_CANDIDATES = CLAUDE_MCP_CONFIG_CANDIDATES;
export const CONTEXT7_SERVER_NAMES = Object.freeze(["context7", "context7-mcp", "ctx7"]);
export const CONTEXT7_DEFINITION_MARKERS = Object.freeze(["@upstash/context7-mcp", "mcp.context7.com"]);
export const CONTEXT7_BINARY_NAMES = Object.freeze(["ctx7"]);
export const CONTEXT7_SKILL_CANDIDATES = Object.freeze([
  { base: "home", segments: [".claude", "skills", "context7", "SKILL.md"] },
  { base: "home", segments: [".claude", "skills", "context7-mcp", "SKILL.md"] },
]);

/** Resolves a `{ base, segments }` candidate to an absolute path given `{ home, cwd }`. */
export function resolveCandidate({ base, segments }, { home, cwd }) {
  const root = base === "cwd" ? cwd : home;
  return join(root, ...segments);
}

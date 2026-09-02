#!/usr/bin/env node
/**
 * Compatibility wrapper.
 *
 * The canonical preflight script lives inside the skill directory so
 * SKILL.md can reference it through ${CLAUDE_SKILL_DIR}. Keep this wrapper
 * for README examples and command invocations that point at
 * scripts/preflight.mjs.
 */
import "../skills/testador-subagents/scripts/preflight.mjs";

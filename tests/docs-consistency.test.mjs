/**
 * Guarda doc<->codigo: SKILL.md/references/README nao podem divergir do
 * testador-spec.mjs, e identificadores retirados nao podem reaparecer fora
 * de tests/ e CHANGELOG.md.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMPLETION_GATE_IDS,
  FINDING_CATEGORIES,
  PHASE_NAMES,
  PHASE_ORDER,
  REQUIRED_SKILLS,
  RETIRED_IDENTIFIERS,
  RUN_STATUSES,
  SEVERITIES,
} from "../skills/testador-subagents/scripts/testador-spec.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_MD = join(REPO_ROOT, "skills/testador-subagents/SKILL.md");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".claude", ".claude-plugin", ".testador", ".executor",
  ".orchestration", ".pensador", "tests",
]);
const SCAN_EXTENSIONS = new Set([".md", ".mjs", ".json"]);

function* walkRepo(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkRepo(path);
    else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

test("PHASE_ORDER covers all 12 phases (0-11)", () => {
  assert.deepEqual([...PHASE_ORDER], [0,1,2,3,4,5,6,7,8,9,10,11]);
});

test("PHASE_NAMES covers every phase in PHASE_ORDER", () => {
  for (const phase of PHASE_ORDER) {
    assert.ok(PHASE_NAMES[phase], `PHASE_NAMES must have an entry for phase ${phase}`);
  }
});

test("REQUIRED_SKILLS are the three mandatory ones", () => {
  assert.deepEqual([...REQUIRED_SKILLS].sort(), ["frontend-design", "ui-ux-pro-max", "webapp-testing"].sort());
});

test("COMPLETION_GATE_IDS match COMPLETION_GATE_DEFINITIONS in testador-state.mjs", async () => {
  const { COMPLETION_GATE_DEFINITIONS } = await import("../skills/testador-subagents/scripts/lib/testador-state.mjs");
  const stateGateIds = Object.keys(COMPLETION_GATE_DEFINITIONS).sort();
  const specGateIds = [...COMPLETION_GATE_IDS].sort();
  assert.deepEqual(stateGateIds, specGateIds);
});

test("RUN_STATUSES covers the four expected values", () => {
  const expected = ["APROVADO", "APROVADO_COM_RESSALVAS", "REPROVADO", "PARCIAL"].sort();
  assert.deepEqual([...RUN_STATUSES].sort(), expected);
});

test("no RETIRED_IDENTIFIERS appear outside tests/ and CHANGELOG.md", () => {
  if (RETIRED_IDENTIFIERS.length === 0) return; // nothing to check yet
  for (const path of walkRepo(REPO_ROOT)) {
    if (path.includes("tests") || path.endsWith("CHANGELOG.md")) continue;
    const text = readText(path);
    for (const retired of RETIRED_IDENTIFIERS) {
      assert.ok(!text.includes(retired), `Retired identifier "${retired}" must not appear in ${path}`);
    }
  }
});

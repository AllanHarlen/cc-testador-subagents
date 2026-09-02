/**
 * Guarda de seguranca: nenhuma operacao do testador escreve dentro de
 * `openspec/`. Verifica que apos ingestao e parse, o diretorio fica
 * byte-identico ao estado inicial.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseOpenSpecChange } from "../skills/testador-subagents/scripts/lib/openspec-parser.mjs";
import { ingestUpstream } from "../skills/testador-subagents/scripts/lib/upstream-ingest.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openspec-readonly-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function snapshotDir(dir) {
  const files = new Map();
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(path, readFileSync(path));
    }
  }
  walk(dir);
  return files;
}

function dirsAreIdentical(before, after) {
  if (before.size !== after.size) return false;
  for (const [path, content] of before) {
    if (!after.has(path) || !after.get(path).equals(content)) return false;
  }
  return true;
}

test("parseOpenSpecChange leaves openspec/ directory byte-identical", () => {
  const root = fixture();
  const changePath = join(root, "openspec", "changes", "login-social");
  mkdirSync(join(changePath, "specs", "auth"), { recursive: true });
  writeFileSync(
    join(changePath, "specs", "auth", "spec.md"),
    `### Requirement: Login\n\n#### Scenario: Valid credentials\n- **WHEN** user logs in\n- **THEN** dashboard renders on screen\n`,
    "utf8",
  );

  const openspecDir = join(root, "openspec");
  const before = snapshotDir(openspecDir);
  parseOpenSpecChange(changePath);
  const after = snapshotDir(openspecDir);

  assert.ok(dirsAreIdentical(before, after), "openspec/ must be byte-identical after parsing");
});

test("ingestUpstream leaves .orchestration/ and .pensador/ byte-identical", () => {
  const root = fixture();

  const pensadorHandoff = {
    handoffVersion: 1, stage: "pensador", slug: "test-slug",
    producer: { plugin: "cc-pensador", version: "1.0.0" },
    artifactRoot: ".pensador/test-slug-v1",
    status: "DONE",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    summary: "done",
    upstream: null,
    artifacts: [],
    nextStage: { consumer: "cc-orchestrador-subagents", entrypoint: "/orquestrador" },
  };

  const orchestradorHandoff = {
    handoffVersion: 1, stage: "orchestrador", slug: "test-slug",
    producer: { plugin: "cc-orchestrador-subagents", version: "1.0.0" },
    artifactRoot: ".orchestration/test-slug",
    status: "DONE",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    summary: "done",
    upstream: { stage: "pensador", handoffPath: ".pensador/test-slug-v1/handoff.json" },
    artifacts: [],
    nextStage: { consumer: "cc-testador-subagents", entrypoint: "/testador" },
  };

  mkdirSync(join(root, ".pensador", "test-slug-v1"), { recursive: true });
  mkdirSync(join(root, ".orchestration", "test-slug", "report"), { recursive: true });
  writeFileSync(join(root, ".pensador", "test-slug-v1", "handoff.json"), JSON.stringify(pensadorHandoff), "utf8");
  writeFileSync(join(root, ".orchestration", "test-slug", "report", "handoff.json"), JSON.stringify(orchestradorHandoff), "utf8");

  const orchestrationBefore = snapshotDir(join(root, ".orchestration"));
  const pensadorBefore = snapshotDir(join(root, ".pensador"));

  ingestUpstream({ projectRoot: root });

  const orchestrationAfter = snapshotDir(join(root, ".orchestration"));
  const pensadorAfter = snapshotDir(join(root, ".pensador"));

  assert.ok(dirsAreIdentical(orchestrationBefore, orchestrationAfter), ".orchestration/ must be unchanged");
  assert.ok(dirsAreIdentical(pensadorBefore, pensadorAfter), ".pensador/ must be unchanged");
});

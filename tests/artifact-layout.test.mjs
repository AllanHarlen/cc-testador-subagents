import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_LAYOUT_VERSION,
  LAYOUT_ROOT_FILES,
  artifactRelativePath,
  artifactWritePath,
  ensureArtifactLayout,
  resolveArtifact,
} from "../skills/testador-subagents/scripts/lib/artifact-layout.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-artifact-layout-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

// handoff.json e ingested-baseline.md ficam na raiz porque
// references/handoff-contract.md (byte-identico nos 4 plugins) nomeia esses
// caminhos literalmente como relativos a raiz de artefatos_dir.
test("handoff.json and ingested-baseline.md are pinned to LAYOUT_ROOT_FILES", () => {
  assert.ok(LAYOUT_ROOT_FILES.includes("handoff.json"));
  assert.ok(LAYOUT_ROOT_FILES.includes("ingested-baseline.md"));
});

test("state.json, events.jsonl and .state.lock also never move", () => {
  for (const file of ["state.json", "events.jsonl", ".state.lock"]) {
    assert.equal(artifactRelativePath(file), file);
  }
});

test("ARTIFACT_LAYOUT_VERSION is 2 (grouped by stage)", () => {
  assert.equal(ARTIFACT_LAYOUT_VERSION, 2);
});

test("a stage-grouped file (e.g. test-report.md) resolves under review/", () => {
  assert.equal(artifactRelativePath("test-report.md"), "review/test-report.md");
});

test("a stage-grouped file (e.g. test-plan.md) resolves under plan/", () => {
  assert.equal(artifactRelativePath("test-plan.md"), "plan/test-plan.md");
});

test("resolveArtifact finds a file at its expected grouped path", () => {
  const root = fixture();
  ensureArtifactLayout(root);
  writeFileSync(join(root, "review", "test-report.md"), "laudo\n", "utf8");
  const resolved = resolveArtifact(root, "test-report.md");
  assert.ok(resolved);
  assert.equal(resolved.relativePath, "review/test-report.md");
});

test("resolveArtifact returns null for a file that does not exist", () => {
  const root = fixture();
  assert.equal(resolveArtifact(root, "test-report.md"), null);
});

test("artifactWritePath always targets the grouped subdirectory", () => {
  const root = fixture();
  const writePath = artifactWritePath(root, "a11y-report.md");
  assert.equal(writePath.relativePath, "review/a11y-report.md");
});

test("ensureArtifactLayout creates every stage subdirectory", () => {
  const root = fixture();
  ensureArtifactLayout(root);
  for (const dir of ["plan", "run", "run/specs", "run/playwright-report", "review", "review/screenshots", "report", "evidence"]) {
    assert.ok(existsSync(join(root, ...dir.split("/"))), `${dir} must exist`);
  }
});

/**
 * Parser de resultados axe: contagem por severidade, agrupamento por tag
 * WCAG, a11yBlocking (default false -> nao bloqueia, true -> bloqueia).
 * Regra de upgrade via requisito rastreavel e testada em finding-triage.test.mjs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { collectAxeResults, parseAxeReport, AxeReportError } from "../skills/testador-subagents/scripts/lib/axe-report.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "axe-report-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

const AXE_RESULT_WITH_VIOLATIONS = {
  violations: [
    { id: "color-contrast", impact: "serious", description: "Elements must have sufficient color contrast", tags: ["wcag2aa", "wcag21aa"], nodes: [{ target: ["#btn-1"], html: "<button>Click</button>" }] },
    { id: "label", impact: "critical", description: "Form elements must have labels", tags: ["wcag2a", "wcag21a"], nodes: [{ target: ["#input-1"], html: "<input type=\"text\">" }] },
  ],
  incomplete: [],
};

test("parseAxeReport returns found:false when no results file exists", () => {
  const root = fixture();
  mkdirSync(join(root, "run"), { recursive: true });
  const result = parseAxeReport(join(root, "run", "axe-results.json"));
  assert.equal(result.found, false);
  assert.equal(result.counts.critical, 0);
});

test("parseAxeReport counts violations by severity from axe JSON", () => {
  const root = fixture();
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "run", "axe-results.json"), JSON.stringify(AXE_RESULT_WITH_VIOLATIONS), "utf8");
  const result = parseAxeReport(join(root, "run", "axe-results.json"));
  assert.equal(result.found, true);
  assert.equal(result.counts.critical, 1);
  assert.equal(result.counts.serious, 1);
  assert.equal(result.counts.moderate, 0);
});

test("parseAxeReport groups violations by WCAG tag", () => {
  const root = fixture();
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "run", "axe-results.json"), JSON.stringify(AXE_RESULT_WITH_VIOLATIONS), "utf8");
  const result = parseAxeReport(join(root, "run", "axe-results.json"));
  assert.ok(result.byTag["wcag2aa"] >= 1);
  assert.ok(result.byTag["wcag2a"] >= 1);
});

test("collectAxeResults status is PASS when a11yBlocking=false even with critical violations", () => {
  const root = fixture();
  const artefatosDir = join(root, "artefatos");
  mkdirSync(join(artefatosDir, "run"), { recursive: true });
  writeFileSync(join(artefatosDir, "run", "axe-results.json"), JSON.stringify(AXE_RESULT_WITH_VIOLATIONS), "utf8");

  const result = collectAxeResults(artefatosDir, { a11yBlocking: false });
  assert.equal(result.summary.status, "PASS", "a11yBlocking:false must not fail even with critical violations");
});

test("collectAxeResults status is FAIL when a11yBlocking=true and there are violations", () => {
  const root = fixture();
  const artefatosDir = join(root, "artefatos");
  mkdirSync(join(artefatosDir, "run"), { recursive: true });
  writeFileSync(join(artefatosDir, "run", "axe-results.json"), JSON.stringify(AXE_RESULT_WITH_VIOLATIONS), "utf8");

  const result = collectAxeResults(artefatosDir, { a11yBlocking: true });
  assert.equal(result.summary.status, "FAIL");
});

test("collectAxeResults emits an intelligence envelope", () => {
  const root = fixture();
  const artefatosDir = join(root, "artefatos");
  mkdirSync(join(artefatosDir, "run"), { recursive: true });
  writeFileSync(join(artefatosDir, "run", "axe-results.json"), JSON.stringify(AXE_RESULT_WITH_VIOLATIONS), "utf8");

  const result = collectAxeResults(artefatosDir);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, "axe-results");
  assert.ok(result.evidenceId.startsWith("intel-axe-results-"));
});

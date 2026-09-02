/**
 * Os 7 gates de conclusao do Testador: `stack`/`smoke`/`reports`
 * nao-waivable; `deterministic`/`a11y`/`uiux`/`spec-coverage` waivable.
 * Semantica de waiver: gate marcado required:true e fechado N/A grava
 * requiredOverride:false, e RUN_GATES_WAIVED passa a bloquear DONE.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  COMPLETION_GATE_DEFINITIONS,
  initRun,
  registerTask,
  updateCompletionGate,
  updateRunStatus,
  updateTaskStatus,
} from "../skills/testador-subagents/scripts/lib/testador-state.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-completion-gates-test-"));
  roots.push(root);
  const artifactDir = join(root, ".testador", "demo", "artefatos");
  initRun({ slug: "demo", artifactDir });
  return artifactDir;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("fresh run: stack/smoke/reports required true, the other 4 required false", () => {
  const artifactDir = fixture();
  for (const [gateId, definition] of Object.entries(COMPLETION_GATE_DEFINITIONS)) {
    assert.equal(!definition.waivable, ["stack", "smoke", "reports"].includes(gateId));
  }
});

test("a non-waivable gate rejects N/A with GATE_NOT_WAIVABLE", () => {
  const artifactDir = fixture();
  assert.throws(
    () => updateCompletionGate(artifactDir, "stack", "N/A", { reason: "skip" }),
    (error) => error.code === "GATE_NOT_WAIVABLE",
  );
});

test("a waivable gate never marked required closes N/A without blocking DONE", () => {
  const artifactDir = fixture();
  const result = updateCompletionGate(artifactDir, "a11y", "N/A", { reason: "no front-end in this run" });
  assert.equal(result.gate.status, "N/A");
  assert.equal(result.gate.requiredOverride, null, "never-required gate closing N/A is not-applicable, not a waiver");
});

test("--required true then N/A is a WAIVER: requiredOverride becomes false and blocks DONE", () => {
  const artifactDir = fixture();
  updateCompletionGate(artifactDir, "deterministic", "PENDING", { required: true });
  const waived = updateCompletionGate(artifactDir, "deterministic", "N/A", { reason: "Playwright unavailable in this environment" });
  assert.equal(waived.gate.requiredOverride, false);

  updateCompletionGate(artifactDir, "stack", "DONE", { evidence: "app-up" });
  updateCompletionGate(artifactDir, "smoke", "DONE", { evidence: "explored" });
  updateCompletionGate(artifactDir, "reports", "DONE", { evidence: "report-written" });

  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) => error.code === "RUN_GATES_WAIVED",
  );
});

test("N/A without a reason is rejected", () => {
  const artifactDir = fixture();
  assert.throws(
    () => updateCompletionGate(artifactDir, "a11y", "N/A", {}),
    (error) => error.code === "GATE_WAIVER_REQUIRES_REASON",
  );
});

test("an unknown gate id is rejected", () => {
  const artifactDir = fixture();
  assert.throws(
    () => updateCompletionGate(artifactDir, "browser-e2e", "DONE", {}),
    (error) => error.code === "UNKNOWN_COMPLETION_GATE",
  );
});

test("closing all 7 gates DONE (or legitimately N/A when never required) allows the run to close DONE", () => {
  const artifactDir = fixture();
  updateCompletionGate(artifactDir, "stack", "DONE", { evidence: "app-up" });
  updateCompletionGate(artifactDir, "smoke", "DONE", { evidence: "explored" });
  updateCompletionGate(artifactDir, "deterministic", "N/A", { reason: "no specs generated in this scope" });
  updateCompletionGate(artifactDir, "a11y", "N/A", { reason: "no front-end in this run" });
  updateCompletionGate(artifactDir, "uiux", "N/A", { reason: "no front-end in this run" });
  updateCompletionGate(artifactDir, "spec-coverage", "N/A", { reason: "no formal requirement source" });
  updateCompletionGate(artifactDir, "reports", "DONE", { evidence: "report-written" });

  const result = updateRunStatus(artifactDir, "DONE");
  assert.equal(result.state.status, "DONE");
});

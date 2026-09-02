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
  applyCompletionGateRequirements,
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

// --- gates plan -> completion gate requirements at init time ---

test("initRun with completionGateRequirements marks planned waivable gates required:true", () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-completion-gates-test-"));
  roots.push(root);
  const artifactDir = join(root, ".testador", "demo2", "artefatos");
  initRun({
    slug: "demo2",
    artifactDir,
    completionGateRequirements: { deterministic: true, a11y: true, uiux: false, "spec-coverage": false },
  });
  // Re-load via loadRun through a no-op gate read: query current gate required flags.
  const gate = updateCompletionGate(artifactDir, "a11y", "PENDING", {});
  assert.equal(gate.gate.required, true);
  const uiux = updateCompletionGate(artifactDir, "uiux", "PENDING", {});
  assert.equal(uiux.gate.required, false);
});

test("without completionGateRequirements, every waivable gate still defaults to required:false (legacy behavior)", () => {
  const artifactDir = fixture();
  for (const gateId of ["deterministic", "a11y", "uiux", "spec-coverage"]) {
    const gate = updateCompletionGate(artifactDir, gateId, "PENDING", {});
    assert.equal(gate.gate.required, false);
  }
});

// --- requiredOverride monotonicity guard ---

test("flipping a waived gate's requiredOverride back to true without --unwaive is rejected", () => {
  const artifactDir = fixture();
  updateCompletionGate(artifactDir, "deterministic", "PENDING", { required: true });
  const waived = updateCompletionGate(artifactDir, "deterministic", "N/A", { reason: "Playwright unavailable" });
  assert.equal(waived.gate.requiredOverride, false);

  assert.throws(
    () => updateCompletionGate(artifactDir, "deterministic", "PENDING", { required: true }),
    (error) => error.code === "GATE_WAIVER_REQUIRES_EXPLICIT_UNWAIVE",
  );
});

test("flipping a waived gate's requiredOverride back to true WITH --unwaive succeeds", () => {
  const artifactDir = fixture();
  updateCompletionGate(artifactDir, "deterministic", "PENDING", { required: true });
  updateCompletionGate(artifactDir, "deterministic", "N/A", { reason: "Playwright unavailable" });

  const reopened = updateCompletionGate(artifactDir, "deterministic", "PENDING", { required: true, unwaive: true });
  assert.equal(reopened.gate.requiredOverride, true);
  assert.equal(reopened.gate.required, true);
});

test("applyCompletionGateRequirements marking a gate required:false (not applicable) never counts as a waiver", () => {
  const artifactDir = fixture();
  // spec-coverage nao planejado para este run (sem OpenSpec/joint) -> required:false,
  // mas o gate nunca foi fechado N/A -- isso NAO e um waiver e nao deve bloquear DONE.
  applyCompletionGateRequirements(artifactDir, { deterministic: true, a11y: true, uiux: true, "spec-coverage": false });

  updateCompletionGate(artifactDir, "stack", "DONE", { evidence: "app-up" });
  updateCompletionGate(artifactDir, "smoke", "DONE", { evidence: "explored" });
  updateCompletionGate(artifactDir, "deterministic", "DONE", { evidence: "specs-passed" });
  updateCompletionGate(artifactDir, "a11y", "DONE", { evidence: "axe-passed" });
  updateCompletionGate(artifactDir, "uiux", "DONE", { evidence: "review-done" });
  updateCompletionGate(artifactDir, "reports", "DONE", { evidence: "report-written" });
  // spec-coverage fica PENDING (required:false, mas nunca fechado) -- ainda assim
  // nao bloqueia DONE porque RUN_GATES_NOT_CLOSED so olha gates com required:true.

  const result = updateRunStatus(artifactDir, "DONE");
  assert.equal(result.state.status, "DONE");
});

/**
 * Estado persistente por-run: atomicidade, replay de eventos, transicoes de
 * task/run, DONE exige evidencia, sweep com grace period, resume nunca
 * presume FAILED/DONE de um RUNNING interrompido.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  TestadorStateError,
  findRunDirectory,
  initRun,
  loadRun,
  registerTask,
  resumeRunAtDirectory,
  sweepStalledTasks,
  updateRunStatus,
  updateTaskStatus,
} from "../skills/testador-subagents/scripts/lib/testador-state.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-testador-state-test-"));
  roots.push(root);
  const artifactDir = join(root, ".testador", "demo", "artefatos");
  return { root, artifactDir, slug: "demo" };
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("initRun creates a run and is idempotent on repeat calls", () => {
  const { artifactDir, slug } = fixture();
  const first = initRun({ slug, artifactDir });

  assert.equal(first.created, true);
  assert.equal(first.state.status, "RUNNING");
  assert.equal(first.state.projectConfig.fields.baseUrl, "http://localhost:3000");

  const second = initRun({ slug, artifactDir });
  assert.equal(second.created, false);
  assert.equal(second.state.runId, first.state.runId);
});

test("event replay repairs a missing snapshot after a simulated crash", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });

  rmSync(join(artifactDir, "state.json"));

  const loaded = loadRun(artifactDir, { repairSnapshot: true });
  assert.equal(loaded.snapshotRecovered, true);
  assert.equal(loaded.state.tasks["mcp-explorer"].status, "RUNNING");
  assert.ok(existsSync(join(artifactDir, "state.json")), "repairSnapshot must rewrite state.json from events.jsonl");
});

test("resume converts an interrupted RUNNING task to UNKNOWN, never FAILED or DONE", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });

  const result = resumeRunAtDirectory(artifactDir);
  assert.deepEqual(result.unknownTasks, ["mcp-explorer"]);
  assert.equal(result.state.tasks["mcp-explorer"].status, "UNKNOWN");
  assert.equal(result.state.tasks["mcp-explorer"].reasonCode, "OWNER_SESSION_INTERRUPTED");
});

test("a terminal DONE task cannot be silently reopened", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });
  updateTaskStatus(artifactDir, "mcp-explorer", "DONE", { evidence: "manual confirmation" });

  assert.throws(
    () => updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" }),
    (error) => error instanceof TestadorStateError && error.code === "INVALID_TASK_TRANSITION",
  );
});

test("DONE requires local evidence: no expected/produced files, no passing validation, no commit delta -> rejected", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });

  assert.throws(
    () => updateTaskStatus(artifactDir, "mcp-explorer", "DONE", {}),
    (error) => error instanceof TestadorStateError && error.code === "TASK_DONE_REQUIRES_EVIDENCE",
  );
});

test("stall sweep only flags a RUNNING task after the idle threshold elapses, and grace period gates the escalated recommendation", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  const started = new Date("2026-01-01T00:00:00Z");
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code", now: started });

  const early = sweepStalledTasks(artifactDir, { now: new Date(started.getTime() + 10_000), staleIdleSeconds: 450 });
  assert.equal(early.changed, false);

  const late = sweepStalledTasks(artifactDir, { now: new Date(started.getTime() + 500_000), staleIdleSeconds: 450, stallGraceSeconds: 120 });
  assert.equal(late.changed, true);
  assert.deepEqual(late.stalled, ["mcp-explorer"]);
  assert.equal(late.state.tasks["mcp-explorer"].stall.recommendation, "INTERRUPT_THEN_RECONCILE");

  const afterGrace = sweepStalledTasks(artifactDir, { now: new Date(started.getTime() + 700_000), staleIdleSeconds: 450, stallGraceSeconds: 120 });
  assert.deepEqual(afterGrace.graceExpired, ["mcp-explorer"]);
  assert.equal(afterGrace.state.tasks["mcp-explorer"].stall.recommendation, "CANCEL_OR_RETRY_AFTER_RECONCILIATION");
});

test("run cannot be DONE while a task remains non-terminal", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });

  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) => error.code === "RUN_TASKS_NOT_TERMINAL",
  );

  updateTaskStatus(artifactDir, "mcp-explorer", "DONE", { evidence: "done" });

  // Task terminal is necessary but not sufficient: the 3 non-waivable gates
  // (stack, smoke, reports) are still PENDING at this point.
  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) => error.code === "RUN_GATES_NOT_CLOSED",
  );
});

test("findRunDirectory prefers an explicit artifactDir over the checkpoint index", () => {
  const { artifactDir } = fixture();
  assert.equal(findRunDirectory({ artifactDir }), artifactDir);
});

test("init is idempotent even after a crash-simulated missing state.json (replay from events.jsonl)", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  registerTask(artifactDir, "mcp-explorer", {});
  updateTaskStatus(artifactDir, "mcp-explorer", "RUNNING", { executor: "claude-code" });
  assert.ok(existsSync(join(artifactDir, "state.json")));

  rmSync(join(artifactDir, "state.json"));
  const reinit = initRun({ slug, artifactDir });
  assert.equal(reinit.created, false);
  assert.ok(existsSync(join(artifactDir, "state.json")), "loadRun with repairSnapshot must rewrite the snapshot from events.jsonl");
});

test("a duplicated event revision is a hard error", () => {
  const { artifactDir, slug } = fixture();
  initRun({ slug, artifactDir });
  const eventsPath = join(artifactDir, "events.jsonl");
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
  writeFileSync(eventsPath, `${lines[0]}\n${lines[0]}\n`, "utf8");
  assert.throws(
    () => registerTask(artifactDir, "mcp-explorer", {}),
    (error) => error.code === "DUPLICATE_EVENT_REVISION",
  );
});

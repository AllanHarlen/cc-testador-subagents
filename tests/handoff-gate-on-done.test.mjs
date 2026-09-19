/**
 * `run --status DONE` recusa um handoff.json presente que reprova em validateHandoff().
 *
 * Regressao: numa run real do Pensador (OficinaAI, 2026-09-18) o handoff foi escrito a mao, sem
 * handoffVersion/stage/producer/..., e a run foi fechada como concluida mesmo assim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { validateHandoff } from "../skills/testador-subagents/scripts/lib/handoff-validator.mjs";
import {
  initRun,
  updateCompletionGate,
  updateRunStatus,
} from "../skills/testador-subagents/scripts/lib/testador-state.mjs";

const roots = [];
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function closedRun() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-handoff-gate-test-"));
  roots.push(root);
  const artifactDir = join(root, ".testador", "demo", "artefatos");
  initRun({ slug: "demo", artifactDir });
  for (const gate of ["stack", "smoke", "reports"]) updateCompletionGate(artifactDir, gate, "DONE", { projectRoot: root });
  return { root, artifactDir };
}

const validHandoff = () => ({
  handoffVersion: 1,
  stage: "testador",
  slug: "demo",
  producer: { plugin: "cc-testador-subagents", version: "1.3.0" },
  artifactRoot: ".testador/demo/artefatos",
  status: "DONE",
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
  summary: "Laudo aprovado.",
  upstream: null,
  artifacts: [{ role: "test-report", path: "review/test-report.md", required: true }],
  nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor" },
});

test("the valid fixture really is valid", () => {
  assert.equal(validateHandoff(validHandoff()).ok, true);
});

test("DONE is refused for a hand-written handoff.json that fails validation", () => {
  const { root, artifactDir } = closedRun();
  writeFileSync(join(artifactDir, "handoff.json"), JSON.stringify({ schemaVersion: "1.0", slug: "demo", status: "DONE" }));
  assert.throws(
    () => updateRunStatus(artifactDir, "DONE", { projectRoot: root }),
    (error) => error.code === "HANDOFF_INVALID" && error.details.errors.length > 0,
  );
});

test("DONE is refused for a handoff.json that is not JSON", () => {
  const { root, artifactDir } = closedRun();
  writeFileSync(join(artifactDir, "handoff.json"), "{ not json");
  assert.throws(() => updateRunStatus(artifactDir, "DONE", { projectRoot: root }), (error) => error.code === "HANDOFF_INVALID");
});

test("DONE succeeds with a valid handoff.json, and without one (standalone run)", () => {
  const withHandoff = closedRun();
  writeFileSync(join(withHandoff.artifactDir, "handoff.json"), JSON.stringify(validHandoff()));
  assert.equal(updateRunStatus(withHandoff.artifactDir, "DONE", { projectRoot: withHandoff.root }).state.status, "DONE");

  const without = closedRun();
  assert.equal(updateRunStatus(without.artifactDir, "DONE", { projectRoot: without.root }).state.status, "DONE");
});

test("a non-DONE status change is not blocked by an invalid handoff.json", () => {
  const { root, artifactDir } = closedRun();
  writeFileSync(join(artifactDir, "handoff.json"), "{}");
  assert.equal(updateRunStatus(artifactDir, "BLOCKED", { projectRoot: root }).state.status, "BLOCKED");
});

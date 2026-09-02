/**
 * Validador do envelope handoff.json para os 4 estagios da cadeia:
 * pensador -> orchestrador -> testador -> executor.
 *
 * Cobre caminhos positivos (cada estagio bem-formado) e negativos (cada
 * violacao especifica do contrato), incluindo as duas regras unicas do
 * testador: TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR e o vocabulario
 * de roles proprio.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolve } from "node:path";

import {
  HANDOFF_ROLES_BY_STAGE,
  HANDOFF_STAGES,
  HANDOFF_STATUSES,
  SUPPORTED_HANDOFF_VERSION,
  validateHandoff,
} from "../skills/testador-subagents/scripts/lib/handoff-validator.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT_PATH = join(REPO_ROOT, "skills/testador-subagents/references/handoff-contract.md");
const CLI_SCRIPT = resolve(REPO_ROOT, "skills/testador-subagents/scripts/validate-handoff.mjs");

function validPensadorHandoff(overrides = {}) {
  return {
    handoffVersion: 1, stage: "pensador", slug: "login-social", artifactMode: "prd",
    producer: { plugin: "cc-pensador", version: "2.15.0" },
    artifactRoot: ".pensador/login-social-v1",
    status: "DONE",
    createdAt: "2026-06-18T15:40:00.000Z", updatedAt: "2026-06-18T15:40:00.000Z",
    summary: "PRD, arquitetura e contrato de API para login social.",
    upstream: null,
    artifacts: [{ role: "prd", path: "prd.md", required: true }],
    nextStage: { consumer: "cc-orchestrador-subagents", entrypoint: "/orchestrador" },
    ...overrides,
  };
}

function validOrchestradorHandoff(overrides = {}) {
  return {
    handoffVersion: 1, stage: "orchestrador", slug: "login-social",
    producer: { plugin: "cc-orchestrador-subagents", version: "3.0.0" },
    artifactRoot: ".orchestration/login-social",
    status: "DONE",
    createdAt: "2026-06-19T10:00:00.000Z", updatedAt: "2026-06-19T18:00:00.000Z",
    summary: "Implementacao completa, reviews aprovados.",
    upstream: { stage: "pensador", handoffPath: ".pensador/login-social-v1/handoff.json" },
    artifacts: [{ role: "implementation-report", path: "report/implementation-report.md", required: true }],
    nextStage: { consumer: "cc-testador-subagents", entrypoint: "/testador" },
    ...overrides,
  };
}

function validTestadorHandoff(overrides = {}) {
  return {
    handoffVersion: 1, stage: "testador", slug: "login-social",
    producer: { plugin: "cc-testador-subagents", version: "1.0.0" },
    artifactRoot: ".testador/login-social/artefatos",
    status: "DONE",
    createdAt: "2026-06-20T08:00:00.000Z", updatedAt: "2026-06-20T10:00:00.000Z",
    summary: "Validacao aprovada: 0 achados bloqueantes, cobertura de 3 Scenarios.",
    upstream: { stage: "orchestrador", handoffPath: ".orchestration/login-social/report/handoff.json" },
    artifacts: [
      { role: "test-report", path: "review/test-report.md", required: true },
      { role: "monitoring", path: "run/monitoring.md", required: true },
    ],
    nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor", instructions: "Laudo aprovado — zero achados bloqueantes." },
    ...overrides,
  };
}

function validExecutorHandoff(overrides = {}) {
  return {
    handoffVersion: 1, stage: "executor", slug: "login-social",
    producer: { plugin: "cc-executor-subagents", version: "2.6.0" },
    artifactRoot: ".executor/login-social/artefatos",
    status: "DONE",
    createdAt: "2026-06-20T11:00:00.000Z", updatedAt: "2026-06-20T13:00:00.000Z",
    summary: "Correcoes aplicadas, review plano-vs-entrega aprovado.",
    upstream: { stage: "testador", handoffPath: ".testador/login-social/artefatos/handoff.json" },
    artifacts: [{ role: "implementation-report", path: "report/implementation-report.md", required: true }],
    nextStage: null,
    ...overrides,
  };
}

// --- Positive path ---

test("accepts a well-formed Pensador handoff", () => {
  assert.equal(validateHandoff(validPensadorHandoff()).ok, true);
});

test("accepts a well-formed Orchestrador handoff", () => {
  assert.equal(validateHandoff(validOrchestradorHandoff()).ok, true);
});

test("accepts a well-formed Testador handoff (joint mode)", () => {
  const result = validateHandoff(validTestadorHandoff());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("accepts a Testador handoff with nextStage: null (standalone mode)", () => {
  assert.equal(validateHandoff(validTestadorHandoff({ nextStage: null })).ok, true);
});

test("accepts a well-formed Executor handoff (terminal)", () => {
  assert.equal(validateHandoff(validExecutorHandoff()).ok, true);
});

test("accepts a BLOCKED testador handoff with an explanatory summary", () => {
  const result = validateHandoff(validTestadorHandoff({
    status: "BLOCKED",
    summary: "2 achados bloqueantes: CORS ausente na rota /api/login e token CSS inventado.",
  }));
  assert.equal(result.ok, true);
});

test("accepts every role declared for each stage in HANDOFF_ROLES_BY_STAGE", () => {
  const bases = { pensador: validPensadorHandoff, orchestrador: validOrchestradorHandoff, testador: validTestadorHandoff, executor: validExecutorHandoff };
  for (const stage of HANDOFF_STAGES) {
    for (const role of HANDOFF_ROLES_BY_STAGE[stage]) {
      const result = validateHandoff({ ...bases[stage](), artifacts: [{ role, path: "x", required: true }] });
      assert.equal(result.ok, true, `role "${role}" should be valid for stage "${stage}": ${JSON.stringify(result.errors)}`);
    }
  }
});

// --- Negative path ---

test("rejects a testador handoff with nextStage pointing to something other than cc-executor-subagents", () => {
  const result = validateHandoff(validTestadorHandoff({ nextStage: { consumer: "cc-pensador", entrypoint: "/pensador" } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR"));
});

test("does NOT flag an executor handoff with nextStage: null (executor is the last stage)", () => {
  assert.equal(validateHandoff(validExecutorHandoff({ nextStage: null })).ok, true);
});

test("flags an executor handoff with a non-null nextStage", () => {
  const result = validateHandoff(validExecutorHandoff({ nextStage: { consumer: "x", entrypoint: "/y" } }));
  assert.ok(result.errors.some((e) => e.code === "EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL"));
});

test("rejects a testador artifact role with executor's vocabulary", () => {
  const result = validateHandoff(validTestadorHandoff({ artifacts: [{ role: "plan-vs-output-review", path: "x", required: true }] }));
  assert.ok(result.errors.some((e) => e.code === "UNKNOWN_ARTIFACT_ROLE"));
});

test("rejects a stage outside the enum (including Portuguese spelling)", () => {
  const result = validateHandoff(validPensadorHandoff({ stage: "orquestrador" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_STAGE"));
});

test("rejects a PARTIAL/BLOCKED status with a near-empty summary", () => {
  const result = validateHandoff(validTestadorHandoff({ status: "BLOCKED", summary: "n/a" }));
  assert.ok(result.errors.some((e) => e.code === "SUMMARY_TOO_SHORT_FOR_NON_DONE_STATUS"));
});

test("HANDOFF_STAGES includes testador between orchestrador and executor", () => {
  const stages = [...HANDOFF_STAGES];
  const iOrq = stages.indexOf("orchestrador");
  const iTest = stages.indexOf("testador");
  const iExec = stages.indexOf("executor");
  assert.ok(iOrq < iTest && iTest < iExec, `expected orchestrador < testador < executor in ${stages}`);
});

test("SUPPORTED_HANDOFF_VERSION is 1", () => {
  assert.equal(SUPPORTED_HANDOFF_VERSION, 1);
});

test("HANDOFF_STAGES and HANDOFF_STATUSES are frozen", () => {
  assert.ok(Object.isFrozen(HANDOFF_STAGES));
  assert.ok(Object.isFrozen(HANDOFF_STATUSES));
});

// --- Doc alignment ---

function extractStageRoles(contractText, stageHeading) {
  const start = contractText.indexOf(stageHeading);
  assert.ok(start > -1, `heading not found: ${stageHeading}`);
  const rest = contractText.slice(start);
  const nextHeading = rest.indexOf("\n### ", 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return new Set([...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]));
}

import { readFileSync } from "node:fs";

test("HANDOFF_ROLES_BY_STAGE.testador matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.testador), extractStageRoles(contractText, "### Testador (`stage: testador`)"));
});

test("HANDOFF_ROLES_BY_STAGE.executor matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.executor), extractStageRoles(contractText, "### Executor (`stage: executor`)"));
});

// --- CLI round-trip ---

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "handoff-cli-test-"));
  roots.push(root);
  return root;
}
test.after(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("CLI: exits 0 and reports ok:true for a valid testador handoff", () => {
  const dir = fixture();
  const file = join(dir, "handoff.json");
  writeFileSync(file, JSON.stringify(validTestadorHandoff()));
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("CLI: exits 1 for an invalid testador handoff", () => {
  const dir = fixture();
  const file = join(dir, "handoff.json");
  writeFileSync(file, JSON.stringify(validTestadorHandoff({ nextStage: { consumer: "cc-pensador", entrypoint: "/x" } })));
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((e) => e.code === "TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR"));
});

test("CLI: exits 1 with MISSING_FILE_ARG when --file is omitted", () => {
  const result = spawnSync(process.execPath, [CLI_SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errors[0].code, "MISSING_FILE_ARG");
});

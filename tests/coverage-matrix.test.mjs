/**
 * Matriz de cobertura rastreavel: RF/CA do PRD e Scenarios do OpenSpec
 * viram casos de teste. Sem fonte formal -> degrada e registra, nunca
 * finge cobertura.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildCoverageMatrix,
  entriesFromRequirementsIndex,
  entriesFromOpenSpecScenarios,
  CoverageMatrixError,
} from "../skills/testador-subagents/scripts/lib/coverage-matrix.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coverage-matrix-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

const SAMPLE_REQUIREMENTS_INDEX = {
  requirements: [
    {
      id: "RF-01",
      title: "Autenticacao de usuario",
      criteria: [
        { id: "CA-01", description: "Login com credenciais validas redireciona para o dashboard" },
        { id: "CA-02", description: "Login com credenciais invalidas exibe mensagem de erro" },
      ],
    },
    {
      id: "RF-02",
      title: "Cadastro de produto",
      criteria: [],
    },
  ],
};

test("entriesFromRequirementsIndex creates entries for each RF and CA", () => {
  const root = fixture();
  const path = join(root, "requirements.json");
  writeFileSync(path, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX), "utf8");
  const { entries } = entriesFromRequirementsIndex(path);
  // RF-01 parent + 2 CAs + RF-02 parent = 4
  assert.equal(entries.length, 4);
  const rf01 = entries.find((e) => e.origin.ref === "RF-01");
  assert.ok(rf01, "RF-01 must be present");
  assert.equal(rf01.status, "UNCOVERED");
  const ca01 = entries.find((e) => e.origin.ref === "CA-01");
  assert.ok(ca01, "CA-01 must be present");
  assert.equal(ca01.origin.parentRef, "RF-01");
});

test("entriesFromRequirementsIndex throws REQUIREMENTS_INDEX_NOT_FOUND for missing file", () => {
  assert.throws(
    () => entriesFromRequirementsIndex("/does/not/exist.json"),
    (error) => error instanceof CoverageMatrixError && error.code === "REQUIREMENTS_INDEX_NOT_FOUND",
  );
});

test("entriesFromOpenSpecScenarios creates AUTOMATABLE and MANUAL entries correctly", () => {
  const scenarios = [
    { name: "Login redirect", capability: "auth/login", requirement: "RF-01", automatable: "AUTOMATABLE", when: "user logs in", then: "dashboard renders on screen", file: "spec.md" },
    { name: "Business rule", capability: "pricing", requirement: null, automatable: "MANUAL", when: "order created", then: "discount applied per policy", file: "spec.md" },
  ];
  const { entries } = entriesFromOpenSpecScenarios(scenarios);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, "UNCOVERED");
  assert.equal(entries[1].status, "MANUAL");
});

test("buildCoverageMatrix with both sources produces combined entries", () => {
  const root = fixture();
  const path = join(root, "requirements.json");
  writeFileSync(path, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX), "utf8");
  const scenarios = [
    { name: "Extra flow", capability: "checkout", requirement: null, automatable: "AUTOMATABLE", when: "x", then: "y on screen", file: "spec.md" },
  ];
  const result = buildCoverageMatrix({ requirementsIndexPath: path, openSpecScenarios: scenarios });
  assert.ok(result.entries.length >= 5);
  assert.equal(result.degradationNotes.length, 0);
  assert.ok(result.sources.length >= 2);
});

test("buildCoverageMatrix without any source degrades with a recorded note", () => {
  const result = buildCoverageMatrix({});
  assert.equal(result.entries.length, 0);
  assert.equal(result.summary.degraded, true);
  assert.ok(result.degradationNotes.length > 0, "must record degradation note");
  assert.ok(result.degradationNotes[0].includes("spec-coverage gate will degrade"));
});

test("UNCOVERED requisito sem caso de teste e visivel no summary", () => {
  const root = fixture();
  const path = join(root, "requirements.json");
  writeFileSync(path, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX), "utf8");
  const result = buildCoverageMatrix({ requirementsIndexPath: path });
  assert.ok(result.summary.uncovered > 0, "uncovered count must be > 0 before any specs run");
  assert.equal(result.summary.degraded, false);
});

/**
 * Triagem de achados: regra de corte (requisito explicito = bloqueante,
 * boa pratica = informativo), upgrade de a11y por requisito rastreavel,
 * correlacionador 2xx-sem-efeito-na-UI.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFinding,
  correlate2xxWithoutEffect,
  triageFindings,
} from "../skills/testador-subagents/scripts/lib/finding-triage.mjs";

// --- classifyFinding ---

test("CORS_ERROR is always blocking regardless of requirements", () => {
  const result = classifyFinding({ category: "CORS_ERROR", title: "CORS blocked" }, []);
  assert.equal(result.blocking, true);
  assert.ok(result.blockingReason);
});

test("AI_DESIGN_CLICHE is never blocking", () => {
  const result = classifyFinding({ category: "AI_DESIGN_CLICHE", title: "cream background cliche" }, [
    { id: "RF-01", title: "creme background", criteria: [] },
  ]);
  assert.equal(result.blocking, false);
});

test("A11Y_VIOLATION is informative by default (a11yBlocking: false)", () => {
  const result = classifyFinding({ category: "A11Y_VIOLATION", title: "color-contrast" }, [], false);
  assert.equal(result.blocking, false);
});

test("A11Y_VIOLATION becomes blocking when a11yBlocking: true", () => {
  const result = classifyFinding({ category: "A11Y_VIOLATION", title: "label missing" }, [], true);
  assert.equal(result.blocking, true);
  assert.ok(result.blockingReason.includes("a11yBlocking"));
});

test("A11Y_VIOLATION is promoted to blocking when there is a traceable requirement", () => {
  const requirements = [{ id: "RF-10", title: "contrast must pass WCAG AA", criteria: [] }];
  const finding = { category: "A11Y_VIOLATION", title: "contrast WCAG AA" };
  const result = classifyFinding(finding, requirements, false);
  assert.equal(result.blocking, true);
  assert.ok(result.blockingReason.includes("RF-10"));
});

test("QUALITY_FLOOR is informative without a requirement", () => {
  const result = classifyFinding({ category: "QUALITY_FLOOR", title: "keyboard focus not visible" }, []);
  assert.equal(result.blocking, false);
});

test("QUALITY_FLOOR is blocking when there is a traceable requirement", () => {
  const requirements = [{ id: "RF-05", title: "keyboard focus visible in all interactive elements", criteria: [] }];
  const result = classifyFinding({ category: "QUALITY_FLOOR", title: "keyboard focus visible" }, requirements);
  assert.equal(result.blocking, true);
});

// --- correlate2xxWithoutEffect ---

test("correlate2xxWithoutEffect produces UI_DATA_MISMATCH when API returned 2xx but assertions failed", () => {
  const apiCalls = [{ method: "POST", url: "/api/products", status: 200, ok: true }];
  const domAssertions = [{ title: "product appears in list", status: "failed" }];
  const findings = correlate2xxWithoutEffect(apiCalls, domAssertions);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "UI_DATA_MISMATCH");
  assert.equal(findings[0].severity, "critical");
});

test("correlate2xxWithoutEffect produces no finding when all assertions pass", () => {
  const apiCalls = [{ method: "GET", url: "/api/products", status: 200, ok: true }];
  const domAssertions = [{ title: "product list visible", status: "passed" }];
  const findings = correlate2xxWithoutEffect(apiCalls, domAssertions);
  assert.equal(findings.length, 0);
});

test("correlate2xxWithoutEffect produces no finding when no API calls", () => {
  const findings = correlate2xxWithoutEffect([], [{ title: "x", status: "failed" }]);
  assert.equal(findings.length, 0);
});

// --- triageFindings (run status) ---

test("runStatus is REPROVADO when any finding is blocking", () => {
  const result = triageFindings({
    rawFindings: [{ category: "CORS_ERROR", title: "CORS blocked" }],
  });
  assert.equal(result.runStatus, "REPROVADO");
  assert.equal(result.blockingFindings.length, 1);
});

test("runStatus is APROVADO_COM_RESSALVAS when only informative findings exist", () => {
  const result = triageFindings({
    rawFindings: [{ category: "A11Y_VIOLATION", title: "color-contrast" }],
  });
  assert.equal(result.runStatus, "APROVADO_COM_RESSALVAS");
  assert.equal(result.blockingFindings.length, 0);
});

test("runStatus is APROVADO when no findings at all", () => {
  const result = triageFindings({ rawFindings: [] });
  assert.equal(result.runStatus, "APROVADO");
});

test("summary.total accounts for both raw and correlated findings", () => {
  const apiCalls = [{ method: "POST", url: "/api/x", status: 200, ok: true }];
  const domAssertions = [{ title: "x", status: "failed" }];
  const result = triageFindings({
    rawFindings: [{ category: "A11Y_VIOLATION", title: "contrast" }],
    apiCalls,
    domAssertions,
  });
  assert.equal(result.summary.total, 2); // 1 a11y + 1 correlated UI_DATA_MISMATCH
  assert.equal(result.runStatus, "REPROVADO"); // UI_DATA_MISMATCH is always blocking
});

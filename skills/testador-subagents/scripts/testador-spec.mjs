/**
 * Fonte de verdade doc<->codigo para o cc-testador-subagents.
 *
 * Nao e uma CLI (sem wrapper em scripts/). `tests/docs-consistency.test.mjs`
 * varre o repo e falha se SKILL.md/references/README divergirem destas
 * constantes, ou se um `RETIRED_IDENTIFIERS` reaparecer fora de `tests/` e
 * `CHANGELOG.md`.
 */

export const PHASE_ORDER = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

export const PHASE_NAMES = Object.freeze({
  0: "Preflight",
  1: "Ingestao",
  2: "Descoberta de alvo",
  3: "Plano rastreavel",
  4: "Subida da stack",
  5: "Exploracao MCP",
  6: "Geracao de specs",
  7: "Execucao deterministica",
  8: "Validacao UI/UX",
  9: "Triagem",
  10: "Review do laudo",
  11: "Laudo + handoff",
});

export const FINDING_CATEGORIES = Object.freeze([
  "STACK_DOWN",
  "CORS_ERROR",
  "API_NON_2XX",
  "UI_DATA_MISMATCH",
  "FINAL_EFFECT_MISSING",
  "MULTI_TENANT_RESOLUTION",
  "CONSOLE_ERROR",
  "OPENSPEC_SCENARIO_FAILED",
  "REQUIREMENT_NOT_MET",
  "API_CONTRACT_MISMATCH",
  "DESIGN_TOKEN_LITERAL",
  "DESIGN_TOKEN_INVENTED",
  "DESIGN_ACCENT_OVERUSE",
  "DESIGN_ANTIPATTERN",
  "DESIGN_PREVIEW_DIVERGENCE",
  "A11Y_VIOLATION",
  "QUALITY_FLOOR",
  "AI_DESIGN_CLICHE",
  "UIUX_CRITIQUE",
  "PLAYWRIGHT_TEST_FAILED",
]);

export const SEVERITIES = Object.freeze(["critical", "serious", "moderate", "minor", "info"]);

// N-19: named VERDICT_STATUSES, not RUN_STATUSES, because this is the test
// report's final verdict vocabulary (used to derive handoff.status), not the
// run lifecycle state machine — that one is `RUN_STATUSES` in
// scripts/lib/testador-state.mjs (PENDING/RUNNING/DONE/...), a different,
// incompatible enum that used to share this exact name.
export const VERDICT_STATUSES = Object.freeze([
  "APROVADO",
  "APROVADO_COM_RESSALVAS",
  "REPROVADO",
  "PARCIAL",
]);

export const REQUIRED_SKILLS = Object.freeze([
  "webapp-testing",
  "frontend-design",
  "ui-ux-pro-max",
]);

export const COMPLETION_GATE_IDS = Object.freeze([
  "stack",
  "smoke",
  "deterministic",
  "a11y",
  "uiux",
  "spec-coverage",
  "reports",
]);

/** Identificadores retirados/renomeados durante o desenvolvimento — so podem aparecer em tests/ e CHANGELOG.md. */
export const RETIRED_IDENTIFIERS = Object.freeze([]);

export function nextPhase(current) {
  const index = PHASE_ORDER.indexOf(current);
  if (index === -1 || index === PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[index + 1];
}

import { existsSync, readFileSync } from "node:fs";

/**
 * Gerador de matriz de cobertura rastreavel.
 *
 * Converte fontes de requisito (requirements-index do PRD ou Scenarios do
 * OpenSpec) em entradas de matriz, cada uma com:
 *   - origin rastreavel (RF/CA ou Scenario)
 *   - flow (nome do fluxo de usuario derivado)
 *   - automatable (AUTOMATABLE | MANUAL)
 *   - status inicial (UNCOVERED)
 *
 * Disciplina herdada do Orquestrador: sem requirements-index E sem OpenSpec,
 * o gate spec-coverage DEGRADA e registra a degradacao -- nunca finge
 * cobertura de 100%.
 *
 * Cada entrada da matriz sera posteriormente enriquecida pelo flow-map
 * (secao 5 do fluxo) com seletores e asercoes reais.
 */

export const COVERAGE_ENTRY_STATUSES = Object.freeze([
  "UNCOVERED",
  "COVERED",
  "MANUAL",
  "SKIPPED",
]);

export class CoverageMatrixError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CoverageMatrixError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Converte um requirements-index (requirements.json) em entradas de matriz.
 * O requirements-index tem a forma:
 *   { requirements: [{ id: "RF-01", title: "...", criteria: [{id:"CA-01",...}] }] }
 */
export function entriesFromRequirementsIndex(requirementsIndexPath) {
  if (!existsSync(requirementsIndexPath)) {
    throw new CoverageMatrixError(
      "REQUIREMENTS_INDEX_NOT_FOUND",
      `requirements-index not found: ${requirementsIndexPath}`,
      { path: requirementsIndexPath },
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(requirementsIndexPath, "utf8"));
  } catch (error) {
    throw new CoverageMatrixError(
      "REQUIREMENTS_INDEX_INVALID_JSON",
      `requirements-index contains invalid JSON: ${error.message}`,
      { path: requirementsIndexPath },
    );
  }

  const reqs = data.requirements ?? data.rfs ?? [];
  const entries = [];

  for (const req of reqs) {
    // Requisito pai como entrada propria
    entries.push({
      id: `${req.id}-flow`,
      origin: { kind: "prd-requirement", ref: req.id, title: req.title ?? req.id },
      flow: req.title ?? req.id,
      automatable: "AUTOMATABLE",
      status: "UNCOVERED",
      coveredBy: null,
    });

    // Criterios de aceite como entradas filhas
    for (const ca of req.criteria ?? req.acceptanceCriteria ?? []) {
      entries.push({
        id: `${ca.id ?? `${req.id}-ca`}-flow`,
        origin: { kind: "prd-acceptance-criteria", ref: ca.id ?? `${req.id}-ca`, parentRef: req.id, title: ca.description ?? ca.title ?? ca.id },
        flow: ca.description ?? ca.title ?? ca.id,
        automatable: "AUTOMATABLE",
        status: "UNCOVERED",
        coveredBy: null,
      });
    }
  }

  return { entries, source: "requirements-index", path: requirementsIndexPath };
}

/**
 * Converte Scenarios do OpenSpec em entradas de matriz.
 * Aceita o output de parseOpenSpecChange.scenarios.
 */
export function entriesFromOpenSpecScenarios(scenarios) {
  return {
    entries: scenarios.map((scenario, index) => ({
      id: `scenario-${scenario.capability.replace(/[^a-z0-9]/gi, "-")}-${index}`,
      origin: {
        kind: "openspec-scenario",
        capability: scenario.capability,
        requirement: scenario.requirement ?? null,
        scenario: scenario.name,
        file: scenario.file,
        when: scenario.when,
        then: scenario.then,
      },
      flow: scenario.name,
      automatable: scenario.automatable,
      status: scenario.automatable === "MANUAL" ? "MANUAL" : "UNCOVERED",
      coveredBy: null,
    })),
    source: "openspec-scenarios",
  };
}

/**
 * Ponto de entrada principal: constroi a matriz de cobertura a partir das
 * fontes disponiveis.
 *
 * @param {object} options
 * @param {string|null} options.requirementsIndexPath  Caminho do requirements-index (modo PRD).
 * @param {Array} [options.openSpecScenarios]           Scenarios do OpenSpec (modo Spec).
 * @returns {CoverageMatrixResult}
 */
export function buildCoverageMatrix(options = {}) {
  const { requirementsIndexPath, openSpecScenarios } = options;

  const allEntries = [];
  const sources = [];
  const degradationNotes = [];

  if (requirementsIndexPath) {
    const result = entriesFromRequirementsIndex(requirementsIndexPath);
    allEntries.push(...result.entries);
    sources.push({ source: "requirements-index", count: result.entries.length });
  }

  if (openSpecScenarios && openSpecScenarios.length > 0) {
    const result = entriesFromOpenSpecScenarios(openSpecScenarios);
    allEntries.push(...result.entries);
    sources.push({ source: "openspec-scenarios", count: result.entries.length });
  }

  if (allEntries.length === 0) {
    degradationNotes.push(
      "No requirements-index and no OpenSpec scenarios found. The spec-coverage gate will degrade to N/A. " +
        "Test coverage will be derived from exploration only and cannot be formally traced.",
    );
  }

  const uncoveredCount = allEntries.filter((e) => e.status === "UNCOVERED").length;
  const manualCount = allEntries.filter((e) => e.status === "MANUAL").length;
  const automatableEntries = allEntries.filter((e) => e.automatable === "AUTOMATABLE");

  return {
    entries: allEntries,
    sources,
    degradationNotes,
    summary: {
      total: allEntries.length,
      uncovered: uncoveredCount,
      manual: manualCount,
      automatable: automatableEntries.length,
      degraded: allEntries.length === 0,
    },
  };
}

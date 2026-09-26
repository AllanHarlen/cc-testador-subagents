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

const BROWSER_VERIFIABLE_NFR = /acessib|accessib|a11y|wcag|responsiv|usabil|usability|mobile|desempenho|performance|lcp|core web vitals/i;

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
  // O requirements.json real do Pensador (requirements-extractor.mjs) traz os CAs num array de topo,
  // ligados por `requirementId`/`requirementIds`, e o texto em `text`/`criterion` — nao aninhados em
  // `criteria` com `title`. Lendo so a forma aninhada, a matriz nunca listava um CA sequer e a triagem
  // nao tinha texto de requisito para rastrear um achado (formato legado continua aceito).
  const topLevelCriteria = Array.isArray(data.acceptanceCriteria) ? data.acceptanceCriteria : [];
  const titleOf = (item, fallback) => item.title ?? item.text ?? item.description ?? item.criterion ?? fallback;
  const entries = [];

  for (const req of reqs) {
    // Requisito pai como entrada propria
    entries.push({
      id: `${req.id}-flow`,
      origin: { kind: "prd-requirement", ref: req.id, title: titleOf(req, req.id) },
      flow: titleOf(req, req.id),
      automatable: "AUTOMATABLE",
      status: "UNCOVERED",
      coveredBy: null,
    });

    // Criterios de aceite como entradas filhas
    const linked = topLevelCriteria.filter((ca) => {
      const owners = Array.isArray(ca.requirementIds) && ca.requirementIds.length ? ca.requirementIds : [ca.requirementId];
      return owners.includes(req.id);
    });
    for (const ca of [...(req.criteria ?? req.acceptanceCriteria ?? []), ...linked]) {
      entries.push({
        id: `${ca.id ?? `${req.id}-ca`}-flow`,
        origin: { kind: "prd-acceptance-criteria", ref: ca.id ?? `${req.id}-ca`, parentRef: req.id, title: titleOf(ca, ca.id) },
        flow: titleOf(ca, ca.id),
        automatable: "AUTOMATABLE",
        status: "UNCOVERED",
        coveredBy: null,
      });
    }
  }

  // RNF (cc-pensador >= 2.38.0): os verificaveis no navegador (acessibilidade, responsividade,
  // usabilidade, desempenho de pagina) entram como AUTOMATABLE; os demais (seguranca de back-end,
  // disponibilidade...) ficam MANUAL — cobertos pela evidencia do Orquestrador, visiveis aqui.
  for (const rnf of data.nonFunctionalRequirements ?? []) {
    const title = [rnf.category, rnf.text].filter(Boolean).join(": ") || rnf.id;
    entries.push({
      id: `${rnf.id}-flow`,
      origin: { kind: "prd-nonfunctional", ref: rnf.id, title },
      flow: title,
      automatable: BROWSER_VERIFIABLE_NFR.test(title) ? "AUTOMATABLE" : "MANUAL",
      status: "UNCOVERED",
      coveredBy: null,
    });
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

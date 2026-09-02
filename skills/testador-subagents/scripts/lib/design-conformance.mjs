import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { intelligenceResult } from "./intelligence.mjs";
import { loadDesignSystem, parseTokensCss } from "./design-tokens.mjs";

/**
 * Verificacao de conformidade do Open Design na app materializada.
 *
 * Regras verificadas (todas bloqueantes quando ha requisito explicito):
 * 1. var(--*) obrigatorio: nenhum hex literal onde ha token declarado.
 * 2. Token inventado: nenhum token usado na materializada fora do verbatim.
 *    Regra inviolavel "never invent new tokens".
 * 3. Anti-padroes do DESIGN.md §9.
 * 4. Divergencia estrutural entre screenshots e preview/ (heuristica).
 *
 * Nota: a verificacao real de hex vs var(--*) no DOM exige uma sessao de
 * browser (browser_evaluate). Este modulo prepara os INSUMOS para o subagente
 * de fase 8, que rodara a verificacao via Playwright MCP e alimentara
 * `{artefatos_dir}/review/design-conformance.json`.
 *
 * Aqui preparamos: lista de tokens esperados, anti-padroes da §9, e
 * divergencias de materializacao detectaveis estaticamente (tokens.css
 * verbatim vs materializado).
 */

export class DesignConformanceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DesignConformanceError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Prepara o checklist de conformidade para um design system.
 * Retorna insumos que o subagente de fase 8 usa para direcionar a verificacao
 * via browser_evaluate e browser_find.
 */
export function prepareConformanceChecklist(entry, projectRoot) {
  const ds = loadDesignSystem(entry, resolve(projectRoot));
  const findings = [];

  // 1. Divergencia estatica de tokens (verbatim vs materializado)
  if (ds.materializationDivergence) {
    for (const t of ds.materializationDivergence.missing) {
      findings.push({
        category: "DESIGN_TOKEN_LITERAL",
        severity: "critical",
        title: `Token ${t.name} is declared in verbatim tokens.css but missing from materialized`,
        evidence: { token: t.name, verbatimValue: t.verbatimValue },
        blocking: true,
        blockingReason: "Open Design gate: verbatim token missing from materialized (handoff-contract.md section 6)",
      });
    }
    for (const t of ds.materializationDivergence.invented) {
      findings.push({
        category: "DESIGN_TOKEN_INVENTED",
        severity: "critical",
        title: `Token ${t.name} is present in materialized but was NEVER declared in verbatim (invented token)`,
        evidence: { token: t.name, materializedValue: t.materializedValue },
        blocking: true,
        blockingReason: "Open Design inviolable rule: never invent new tokens",
      });
    }
  }

  // 2. Anti-padroes do DESIGN.md §9 (texto, para inspecao pelo subagente)
  const antipatterns = ds.designMd?.section9
    ? extractAntipatterns(ds.designMd.section9)
    : [];

  return {
    designSystemId: entry.id,
    verbatimTokenCount: ds.verbatimTokens?.length ?? 0,
    materializedTokenCount: ds.materializedTokens?.length ?? 0,
    staticFindings: findings,
    antipatternChecklist: antipatterns,
    expectedTokenNames: (ds.verbatimTokens ?? []).map((t) => t.name),
    previewFiles: ds.previewFiles,
    hasPreview: ds.hasPreview,
    hasDesignMd: ds.hasDesignMd,
  };
}

/** Extrai lista de anti-padroes da secao §9 do DESIGN.md. */
function extractAntipatterns(section9Content) {
  const lines = section9Content.split("\n");
  return lines
    .filter((l) => /^[-*]\s+/.test(l.trim()))
    .map((l) => l.trim().replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Constroi o envelope de intelligence de conformidade com os achados
 * estaticos e a lista de verificacoes a fazer no browser.
 */
export function buildConformanceIntelligence(checklists, options = {}) {
  const allFindings = checklists.flatMap((c) => c.staticFindings);
  const allAntipatterns = checklists.flatMap((c) => c.antipatternChecklist);
  const allTokenNames = [...new Set(checklists.flatMap((c) => c.expectedTokenNames))];

  const summary = {
    designSystemsChecked: checklists.length,
    staticFindings: allFindings.length,
    blockingStaticFindings: allFindings.filter((f) => f.blocking).length,
    antipatternCount: allAntipatterns.length,
    expectedTokenCount: allTokenNames.length,
  };

  return intelligenceResult(
    "design-conformance",
    summary,
    {
      checklists,
      staticFindings: allFindings,
      antipatternChecklist: allAntipatterns,
      expectedTokenNames: allTokenNames,
    },
    options,
  );
}

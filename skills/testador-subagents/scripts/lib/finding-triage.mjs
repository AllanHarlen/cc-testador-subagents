import { FINDING_CATEGORIES } from "../testador-spec.mjs";

/**
 * Triagem de achados do Testador.
 *
 * Aplica a REGRA DE CORTE:
 *   - Requisito explicito e rastreavel violado -> BLOQUEANTE
 *   - Boa pratica nao declarada -> INFORMATIVO
 *
 * O que decide: a existencia do requisito rastreavel, nao a ferramenta.
 * Violacao axe critical sem requisito = ressalva.
 * A mesma violacao com Scenario ou RF correspondente = bloqueante.
 *
 * Categorias de achado (fonte de verdade: testador-spec.mjs/FINDING_CATEGORIES,
 * importado aqui -- nunca duplicado):
 *   STACK_DOWN, CORS_ERROR, API_NON_2XX, UI_DATA_MISMATCH,
 *   FINAL_EFFECT_MISSING, MULTI_TENANT_RESOLUTION, CONSOLE_ERROR,
 *   OPENSPEC_SCENARIO_FAILED, REQUIREMENT_NOT_MET, API_CONTRACT_MISMATCH,
 *   DESIGN_TOKEN_LITERAL, DESIGN_TOKEN_INVENTED, DESIGN_ACCENT_OVERUSE,
 *   DESIGN_ANTIPATTERN, DESIGN_PREVIEW_DIVERGENCE,
 *   A11Y_VIOLATION, QUALITY_FLOOR, AI_DESIGN_CLICHE, UIUX_CRITIQUE
 */

// Categorias sempre bloqueantes independente de requisito formal.
// As 5 categorias DESIGN_* NAO estao aqui: elas so sao always-blocking
// quando `hasOpenDesign: true` (ha um contrato de tokens declarado para
// violar); sem Open Design, "hex literal" ou "accent overuse" e apenas uma
// boa pratica nao pedida e cai na regra generica (bloqueante somente com
// requisito rastreavel) -- ver `classifyFinding`.
const ALWAYS_BLOCKING = new Set([
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
  "PLAYWRIGHT_TEST_FAILED",
]);

// Categorias always-blocking apenas quando ha um contrato de Open Design
// declarado para esta run (`hasOpenDesign: true`). Sem ele, tratadas pela
// regra generica de requisito rastreavel.
const DESIGN_CATEGORIES = new Set([
  "DESIGN_TOKEN_LITERAL",
  "DESIGN_TOKEN_INVENTED",
  "DESIGN_ACCENT_OVERUSE",
  "DESIGN_ANTIPATTERN",
  "DESIGN_PREVIEW_DIVERGENCE",
]);

// Categorias nunca bloqueantes (sem upgrade por requisito)
const NEVER_BLOCKING = new Set([
  "AI_DESIGN_CLICHE",
  "UIUX_CRITIQUE",
]);

const KNOWN_CATEGORIES = new Set(FINDING_CATEGORIES);

/** Palavras curtas demais ou funcionais demais para contar como sinal de correspondencia. */
const STOPWORDS = new Set([
  "a", "o", "os", "as", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
  "com", "para", "por", "que", "nao", "sim", "ser", "sao", "esta", "este", "esse",
  "the", "is", "are", "was", "were", "must", "shall", "should", "and", "or", "not",
  "for", "with", "all", "any", "has", "have", "had", "can", "will", "may",
]);

function significantWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Verifica se um achado tem um requisito rastreavel correspondente.
 *
 * Estrategia: sobreposicao de palavras significativas (stopwords e palavras
 * curtas excluidas) entre o titulo do achado e o titulo/descricao/scenario
 * do requisito, exigindo um numero minimo de palavras em comum -- nunca uma
 * unica palavra qualquer (a antiga heuristica `needle.includes(haystack.split(" ")[0])`
 * casava pelo primeiro token do requisito, o que promovia falsos positivos
 * sempre que esse token fosse uma palavra comum como "o", "a", "the").
 */
function hasTraceableRequirement(finding, requirements) {
  if (!requirements || requirements.length === 0) return false;
  const rawNeedle = finding.title ?? finding.rule ?? "";
  const needleWords = significantWords(rawNeedle);
  if (needleWords.length === 0) return false;
  const minMatches = needleWords.length === 1 ? 1 : Math.max(2, Math.ceil(needleWords.length / 2));

  for (const req of requirements) {
    const haystackWords = significantWords(req.title ?? req.description ?? req.scenario ?? "");
    const overlap = needleWords.filter((word) => haystackWords.includes(word));
    if (overlap.length >= minMatches) {
      return { matched: true, requirementRef: req.id ?? req.ref ?? null, requirementTitle: req.title ?? req.scenario };
    }
    for (const ca of req.criteria ?? []) {
      const caWords = significantWords(ca.description ?? ca.title ?? "");
      const caOverlap = needleWords.filter((word) => caWords.includes(word));
      if (caOverlap.length >= minMatches) {
        return { matched: true, requirementRef: ca.id ?? req.id, requirementTitle: ca.description };
      }
    }
  }
  return false;
}

/**
 * Classifica um achado individualmente:
 *  - always_blocking: bloqueante sem necessidade de requisito
 *  - blocking_by_requirement: informativo, mas com requisito rastreavel -> promovido
 *  - informative: boas praticas, a11y sem requisito
 *  - never_blocking: criticas de estilo/gosto
 *  - fail-closed: categoria ausente ou desconhecida -> bloqueante ate revisao manual
 *
 * @param {object} finding  Achado com `category`, `title`, etc.
 * @param {Array}  requirements  Lista de requisitos (RF/CA ou Scenarios).
 * @param {boolean} a11yBlocking  Se true, violacoes axe bloqueiam por default.
 * @param {object} [options]
 * @param {boolean} [options.hasOpenDesign]  Se true, as 5 categorias DESIGN_* sao always-blocking.
 * @returns {object}  Achado enriquecido com `blocking` e `blockingReason`.
 */
export function classifyFinding(finding, requirements = [], a11yBlocking = false, options = {}) {
  const rawCategory = finding.category;
  const hasOpenDesign = options.hasOpenDesign ?? false;

  // Fail-closed: achado sem categoria, ou com categoria fora do vocabulario
  // conhecido (FINDING_CATEGORIES), nunca cai silenciosamente em
  // "informativo" -- um producer que esqueceu de setar `category`, ou
  // digitou errado, nao deve fazer um achado real desaparecer do laudo.
  // Fica bloqueante ate um humano/subagente de review corrigir a categoria.
  if (rawCategory == null || rawCategory === "") {
    return {
      ...finding,
      blocking: true,
      blockingReason: "MISSING_CATEGORY: finding has no category and is treated as blocking pending manual triage",
    };
  }
  if (!KNOWN_CATEGORIES.has(rawCategory)) {
    return {
      ...finding,
      blocking: true,
      blockingReason: `UNKNOWN_CATEGORY: "${rawCategory}" is not in FINDING_CATEGORIES and is treated as blocking pending manual triage`,
    };
  }
  const category = rawCategory;

  // Nunca bloqueante
  if (NEVER_BLOCKING.has(category)) {
    return { ...finding, blocking: false, blockingReason: null };
  }

  // Sempre bloqueante
  if (ALWAYS_BLOCKING.has(category)) {
    return {
      ...finding,
      blocking: true,
      blockingReason: `${category} is always a blocking finding`,
    };
  }

  // DESIGN_*: always-blocking apenas quando ha um contrato de Open Design
  // declarado (hasOpenDesign: true). Sem ele, cai na regra generica abaixo.
  if (DESIGN_CATEGORIES.has(category)) {
    if (hasOpenDesign) {
      return {
        ...finding,
        blocking: true,
        blockingReason: `${category} violates the Open Design token contract (hasOpenDesign: true) and is always blocking`,
      };
    }
    // sem hasOpenDesign, segue para a regra generica de requisito rastreavel
  }

  // A11Y: default nao bloqueia, a menos que a11yBlocking=true ou haja requisito
  if (category === "A11Y_VIOLATION") {
    if (a11yBlocking) {
      return {
        ...finding,
        blocking: true,
        blockingReason: "a11yBlocking: true in project-config — all axe violations are blocking",
      };
    }
    const req = hasTraceableRequirement(finding, requirements);
    if (req) {
      return {
        ...finding,
        blocking: true,
        blockingReason: `Requirement ${req.requirementRef ?? "?"} explicitly requires: ${req.requirementTitle}`,
      };
    }
    return { ...finding, blocking: false, blockingReason: null };
  }

  // QUALITY_FLOOR: informativo por default, bloqueia se ha requisito
  if (category === "QUALITY_FLOOR") {
    const req = hasTraceableRequirement(finding, requirements);
    if (req) {
      return {
        ...finding,
        blocking: true,
        blockingReason: `Requirement ${req.requirementRef ?? "?"}: ${req.requirementTitle}`,
      };
    }
    return { ...finding, blocking: false, blockingReason: null };
  }

  // Default (inclui DESIGN_* sem hasOpenDesign): bloqueia se ha requisito
  // rastreavel, informativo caso contrario.
  const req = hasTraceableRequirement(finding, requirements);
  if (req) {
    return {
      ...finding,
      blocking: true,
      blockingReason: `Requirement ${req.requirementRef ?? "?"}: ${req.requirementTitle}`,
    };
  }
  return { ...finding, blocking: false, blockingReason: null };
}

/**
 * Detecta o correlacionador 2xx-sem-efeito: API retornou 2xx mas a UI nao
 * reflete o dado. Sinal classico de casing divergente.
 *
 * @param {Array} apiCalls  Chamadas de API registradas pelo network-recorder.
 * @param {Array} domAssertions  Resultados de asercoes DOM do spec (passed/failed).
 */
export function correlate2xxWithoutEffect(apiCalls, domAssertions) {
  const findings = [];
  const successCalls = (apiCalls ?? []).filter((c) => c.ok === true || (c.status >= 200 && c.status < 300));
  const failedAssertions = (domAssertions ?? []).filter((a) => a.status === "failed");
  if (successCalls.length > 0 && failedAssertions.length > 0) {
    findings.push({
      category: "UI_DATA_MISMATCH",
      severity: "critical",
      title: "API returned 2xx but UI did not reflect the expected data",
      evidence: {
        successfulApiCalls: successCalls.map((c) => `${c.method} ${c.url} -> ${c.status}`),
        failedDomAssertions: failedAssertions.map((a) => a.title ?? a.name),
      },
    });
  }
  return findings;
}

/**
 * Ponto de entrada principal.
 *
 * @param {object} options
 * @param {Array} options.rawFindings       Lista de achados nao classificados.
 * @param {Array} [options.requirements]    Lista de requisitos rastreavies.
 * @param {boolean} [options.a11yBlocking]  Default: false.
 * @param {boolean} [options.hasOpenDesign] Default: false. Ver `classifyFinding`.
 * @param {Array} [options.apiCalls]        Para o correlacionador 2xx.
 * @param {Array} [options.domAssertions]   Para o correlacionador 2xx.
 * @returns {TriageResult}
 */
export function triageFindings(options = {}) {
  const {
    rawFindings = [],
    requirements = [],
    a11yBlocking = false,
    hasOpenDesign = false,
    apiCalls = [],
    domAssertions = [],
    flowRecords = [],
  } = options;

  // Correlacionador 2xx-sem-efeito
  const correlatedFindings = flowRecords.length > 0
    ? flowRecords.flatMap((record) => correlate2xxWithoutEffect(record.apiCalls, record.domAssertions).map((finding) => ({
      ...finding,
      evidence: { ...finding.evidence, testTitle: record.testTitle ?? null },
    })))
    : correlate2xxWithoutEffect(apiCalls, domAssertions);

  const all = [...rawFindings, ...correlatedFindings].map((finding) =>
    classifyFinding(finding, requirements, a11yBlocking, { hasOpenDesign }),
  );

  const blockingFindings = all.filter((f) => f.blocking);
  const informativos = all.filter((f) => !f.blocking);

  let runStatus;
  if (all.some((f) => f.blocking)) {
    runStatus = "REPROVADO";
  } else if (informativos.length > 0) {
    runStatus = "APROVADO_COM_RESSALVAS";
  } else {
    runStatus = "APROVADO";
  }

  return {
    all,
    blockingFindings,
    informativos,
    runStatus,
    summary: {
      total: all.length,
      blocking: blockingFindings.length,
      informative: informativos.length,
      byCategory: Object.fromEntries(
        [...new Set(all.map((f) => f.category))].map((cat) => [cat, all.filter((f) => f.category === cat).length]),
      ),
    },
  };
}

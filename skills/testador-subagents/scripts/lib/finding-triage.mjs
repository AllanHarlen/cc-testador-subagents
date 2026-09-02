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
 * Categorias de achado (ver testador-spec.mjs/FINDING_CATEGORIES):
 *   STACK_DOWN, CORS_ERROR, API_NON_2XX, UI_DATA_MISMATCH,
 *   FINAL_EFFECT_MISSING, MULTI_TENANT_RESOLUTION, CONSOLE_ERROR,
 *   OPENSPEC_SCENARIO_FAILED, REQUIREMENT_NOT_MET, API_CONTRACT_MISMATCH,
 *   DESIGN_TOKEN_LITERAL, DESIGN_TOKEN_INVENTED, DESIGN_ACCENT_OVERUSE,
 *   DESIGN_ANTIPATTERN, DESIGN_PREVIEW_DIVERGENCE,
 *   A11Y_VIOLATION, QUALITY_FLOOR, AI_DESIGN_CLICHE, UIUX_CRITIQUE
 */

// Categorias sempre bloqueantes independente de requisito formal
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

/**
 * Verifica se um achado de a11y tem um requisito rastreavel correspondente.
 * Estrategia simples: procura por palavras-chave do achado nos cenarios/RFs.
 */
function hasTraceableRequirement(finding, requirements) {
  if (!requirements || requirements.length === 0) return false;
  const needle = (finding.title ?? finding.rule ?? "").toLowerCase();
  for (const req of requirements) {
    const haystack = (req.title ?? req.description ?? req.scenario ?? "").toLowerCase();
    if (needle && haystack && (haystack.includes(needle) || needle.includes(haystack.split(" ")[0]))) {
      return { matched: true, requirementRef: req.id ?? req.ref ?? null, requirementTitle: req.title ?? req.scenario };
    }
    // Checar criterios de aceite
    for (const ca of req.criteria ?? []) {
      const caText = (ca.description ?? ca.title ?? "").toLowerCase();
      if (needle && caText.includes(needle)) {
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
 *
 * @param {object} finding  Achado com `category`, `title`, etc.
 * @param {Array}  requirements  Lista de requisitos (RF/CA ou Scenarios).
 * @param {boolean} a11yBlocking  Se true, violacoes axe bloqueiam por default.
 * @returns {object}  Achado enriquecido com `blocking` e `blockingReason`.
 */
export function classifyFinding(finding, requirements = [], a11yBlocking = false) {
  const category = finding.category ?? "UIUX_CRITIQUE";

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

  // Default: bloqueia se ha requisito rastreavel, informativo caso contrario
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
 * @param {Array} domAsserions  Resultados de asercoes DOM do spec (passed/failed).
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
 * @param {Array} [options.apiCalls]        Para o correlacionador 2xx.
 * @param {Array} [options.domAssertions]   Para o correlacionador 2xx.
 * @returns {TriageResult}
 */
export function triageFindings(options = {}) {
  const { rawFindings = [], requirements = [], a11yBlocking = false, apiCalls = [], domAssertions = [] } = options;

  // Correlacionador 2xx-sem-efeito
  const correlatedFindings = correlate2xxWithoutEffect(apiCalls, domAssertions);

  const all = [...rawFindings, ...correlatedFindings].map((finding) =>
    classifyFinding(finding, requirements, a11yBlocking),
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

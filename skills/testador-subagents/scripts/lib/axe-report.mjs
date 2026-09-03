import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { intelligenceResult } from "./intelligence.mjs";

/**
 * Parser de resultados do @axe-core/playwright.
 *
 * Converte o JSON de saida do axe.analyze() em envelope de intelligence
 * com resumo por severidade e por tag WCAG.
 *
 * Regra de bloqueio:
 *   - Default: a11yBlocking=false. Violacoes entram no laudo classificadas,
 *     nunca bloqueiam sozinhas.
 *   - Upgrade: violacao que corresponde a um requisito rastreavel explicito
 *     (Scenario ou RF) e promovida a bloqueante pela triagem (lib/finding-triage.mjs),
 *     nao aqui.
 *   - Escape: a11yBlocking=true no Project_Config inverte o default e toda
 *     violacao bloqueia.
 */

export class AxeReportError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AxeReportError";
    this.code = code;
    this.details = details;
  }
}

const SEVERITY_ORDER = ["critical", "serious", "moderate", "minor"];

function parseAxeResult(raw) {
  const records = Array.isArray(raw) ? raw : [raw];
  if (records.length === 0 || records.some((record) => !record || typeof record !== "object" || !Array.isArray(record.violations) || !Array.isArray(record.incomplete))) {
    throw new AxeReportError("AXE_REPORT_INVALID_SHAPE", "Axe report must contain violations and incomplete arrays");
  }
  const violations = records.flatMap((record) => (record?.violations ?? []).map((violation) => ({ ...violation, testTitle: record?.testTitle ?? null, url: record?.url ?? null })));
  const incomplete = records.flatMap((record) => record?.incomplete ?? []);
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const byTag = {};
  const byRule = {};
  const flatViolations = [];

  for (const violation of violations) {
    const impact = violation.impact ?? "minor";
    counts[impact] = (counts[impact] ?? 0) + 1;
    // `+` liga mais forte que `??`: sem os parenteses em torno de
    // `violation.nodes?.length ?? 1`, a expressao era avaliada como
    // `((byRule[id] ?? 0) + violation.nodes?.length) ?? 1` -- quando
    // `violation.nodes` era `undefined`, o resultado era `NaN` (nao `1`,
    // que e o fallback pretendido), e `NaN ?? 1` permanece `NaN` porque
    // `??` so cai no fallback para `null`/`undefined`, nunca para `NaN`.
    byRule[violation.id] = (byRule[violation.id] ?? 0) + (violation.nodes?.length ?? 1);
    for (const tag of violation.tags ?? []) {
      byTag[tag] = (byTag[tag] ?? 0) + 1;
    }
    for (const node of violation.nodes ?? []) {
      flatViolations.push({
        rule: violation.id,
        testTitle: violation.testTitle ?? null,
        url: violation.url ?? null,
        impact,
        description: violation.description,
        tags: violation.tags ?? [],
        wcagCriteria: (violation.tags ?? []).filter((t) => t.startsWith("wcag")),
        target: node.target?.[0] ?? null,
        html: node.html ? node.html.slice(0, 200) : null,
      });
    }
  }

  return { counts, byTag, byRule, violations: flatViolations, incomplete };
}

export function parseAxeReport(resultJsonPath) {
  if (!existsSync(resultJsonPath)) {
    return { found: false, counts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, violations: [], byTag: {}, byRule: {}, incomplete: [] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(resultJsonPath, "utf8"));
  } catch (error) {
    throw new AxeReportError("AXE_REPORT_INVALID_JSON", `Cannot parse axe result: ${error.message}`, { path: resultJsonPath });
  }
  const parsed = parseAxeResult(raw);
  return { found: true, ...parsed };
}

export function collectAxeResults(artefatosDir, options = {}) {
  const reportPath = join(resolve(artefatosDir), "run", "axe-results.json");
  const parsed = parseAxeReport(reportPath);

  const totalViolations = Object.values(parsed.counts).reduce((a, b) => a + b, 0);
  const a11yBlocking = options.a11yBlocking ?? false;

  const summary = {
    scanExecuted: parsed.found,
    routesScanned: options.routesScanned ?? null,
    violations: parsed.counts,
    totalViolations,
    byTag: parsed.byTag,
    byRule: parsed.byRule,
    incomplete: parsed.incomplete?.length ?? 0,
    status: !parsed.found ? "NOT_RUN" : a11yBlocking && totalViolations > 0 ? "FAIL" : "PASS",
  };

  if (parsed.found) {
    const findingsPath = join(resolve(artefatosDir), "run", "axe-findings.json");
    mkdirSync(resolve(artefatosDir, "run"), { recursive: true });
    const findings = parsed.violations.map((violation) => ({
      category: "A11Y_VIOLATION",
      severity: violation.impact,
      title: violation.description ?? `Axe violation: ${violation.rule}`,
      evidence: violation,
    }));
    const temporary = `${findingsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
    renameSync(temporary, findingsPath);
  }

  return intelligenceResult(
    "axe-results",
    summary,
    { violations: parsed.violations, artefatosDir: resolve(artefatosDir) },
    options,
  );
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Gerador deterministico de specs Playwright.
 *
 * Transforma flow-map.json + coverage-matrix.json em arquivos .spec.mjs
 * escritos em {artefatos_dir}/run/specs/. O repo-alvo nunca e tocado:
 * specs vivem exclusivamente dentro de artefatos_dir.
 *
 * Regras de seguranca:
 * - Credenciais: qualquer entrada de flow-map com campo `credential` ou
 *   `password` deve referenciar uma env var (process.env.X), nunca um valor
 *   literal. O gerador valida isso antes de escrever.
 * - A saida e deterministica: mesma entrada -> mesmos bytes de saida.
 *
 * Os templates sao inline neste modulo (sem I/O extra) para manter a
 * geracao testavel sem browser.
 */

export class SpecGeneratorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SpecGeneratorError";
    this.code = code;
    this.details = details;
  }
}

const CREDENTIAL_FIELD_NAMES = new Set(["password", "credential", "token", "secret", "key", "apiKey", "api_key"]);

/** Garante que valores de credencial nao vazem para os specs gerados. */
function validateFlowMapCredentials(flowMap) {
  const violations = [];
  for (const flow of flowMap.flows ?? []) {
    for (const step of flow.steps ?? []) {
      for (const [fieldName, value] of Object.entries(step.input ?? {})) {
        if (CREDENTIAL_FIELD_NAMES.has(fieldName) && typeof value === "string" && !value.startsWith("process.env.")) {
          violations.push({ flow: flow.name, step: step.selector, field: fieldName, value: "[redacted]" });
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new SpecGeneratorError(
      "CREDENTIAL_VALUE_IN_FLOW_MAP",
      "Credential values must be referenced as process.env.X, never as literals",
      { violations },
    );
  }
}

/** Escapa um seletor para uso seguro dentro de template literals. */
function escapeSel(selector) {
  return String(selector ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

/** Escapa um valor de string para uso como argumento literal em spec. */
function escapeStr(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Gera o conteudo de um spec .mjs a partir de um flow + entradas de coverage.
 */
function generateFlowSpec(flow, baseUrl, coverageEntries) {
  const coverageComment = coverageEntries.length > 0
    ? `// Traceable to: ${coverageEntries.map((e) => e.origin?.ref ?? e.origin?.scenario ?? e.id).join(", ")}`
    : "// Exploratory flow (no formal requirement traceability)";

  const steps = (flow.steps ?? []).map((step) => {
    if (step.action === "navigate") {
      return `  await page.goto(\`${escapeSel(baseUrl)}${escapeSel(step.path ?? "")}\`);
  await page.waitForLoadState("networkidle");`;
    }
    if (step.action === "click") {
      return `  await page.click(\`${escapeSel(step.selector)}\`);`;
    }
    if (step.action === "fill") {
      const inputEntries = Object.entries(step.input ?? {});
      return inputEntries.map(([field, value]) => {
        const safeValue = String(value).startsWith("process.env.")
          ? `\${${value}}`
          : escapeStr(value);
        return `  await page.fill(\`${escapeSel(step.selector)}\`, \`${safeValue}\`);`;
      }).join("\n");
    }
    if (step.action === "assert_text") {
      return `  await expect(page.locator(\`${escapeSel(step.selector)}\`)).toContainText('${escapeStr(step.expected ?? "")}');`;
    }
    if (step.action === "assert_visible") {
      return `  await expect(page.locator(\`${escapeSel(step.selector)}\`)).toBeVisible();`;
    }
    if (step.action === "assert_url") {
      return `  await expect(page).toHaveURL(new RegExp('${escapeStr(step.pattern ?? "")}'));`;
    }
    return `  // ${step.action}: ${escapeSel(step.selector ?? step.description ?? "")}`;
  });

  return `import { test, expect } from "@playwright/test";
${coverageComment}

test("${escapeStr(flow.name)}", async ({ page, consoleErrors }) => {
${steps.join("\n")}
});
`;
}

/**
 * Ponto de entrada principal.
 *
 * @param {object} options
 * @param {string} options.artefatosDir  Caminho absoluto do artefatos_dir.
 * @param {string} options.baseUrl       URL base da app (do Project_Config).
 * @param {object} [options.flowMap]     Conteudo de flow-map.json (opcional; le do disco se ausente).
 * @param {object} [options.coverageMatrix]  Conteudo de coverage-matrix.json (opcional).
 * @returns {{ specsDir, generated: string[] }}
 */
export function generateSpecs(options = {}) {
  const artefatosDir = resolve(options.artefatosDir ?? process.cwd());
  const baseUrl = options.baseUrl ?? "http://localhost:3000";

  // Ler flow-map.json
  let flowMap = options.flowMap;
  if (!flowMap) {
    const path = join(artefatosDir, "plan", "flow-map.json");
    if (!existsSync(path)) {
      throw new SpecGeneratorError("FLOW_MAP_NOT_FOUND", `flow-map.json not found: ${path}`, { path });
    }
    flowMap = JSON.parse(readFileSync(path, "utf8"));
  }

  // Validar credenciais
  validateFlowMapCredentials(flowMap);

  // Ler coverage-matrix (opcional)
  let coverageMatrix = options.coverageMatrix;
  if (!coverageMatrix) {
    const path = join(artefatosDir, "plan", "coverage-matrix.json");
    if (existsSync(path)) {
      coverageMatrix = JSON.parse(readFileSync(path, "utf8"));
    }
  }
  const coverageEntries = coverageMatrix?.entries ?? [];

  const specsDir = join(artefatosDir, "run", "specs");
  mkdirSync(specsDir, { recursive: true });

  const generated = [];
  for (const flow of flowMap.flows ?? []) {
    // Associar entradas de coverage relevantes ao fluxo
    const relevant = coverageEntries.filter(
      (e) => e.status !== "MANUAL" && (
        (e.flow && flow.name.toLowerCase().includes(e.flow.toLowerCase())) ||
        (e.origin?.scenario && flow.name.toLowerCase().includes(e.origin.scenario.toLowerCase()))
      ),
    );

    const specContent = generateFlowSpec(flow, baseUrl, relevant);
    const safeName = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const specPath = join(specsDir, `${safeName}.spec.mjs`);
    writeFileSync(specPath, specContent, "utf8");
    generated.push(specPath);
  }

  return { specsDir, generated };
}

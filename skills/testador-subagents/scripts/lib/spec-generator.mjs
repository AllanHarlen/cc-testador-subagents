import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Gerador deterministico de specs Playwright.
 *
 * Transforma flow-map.json + coverage-matrix.json em arquivos .spec.mjs
 * escritos em {artefatos_dir}/run/specs/. O repo-alvo nunca e tocado:
 * specs vivem exclusivamente dentro de artefatos_dir, e artefatos_dir e
 * validado como estando dentro de uma arvore `.testador/` antes de qualquer
 * escrita (ver `assertInsideTestadorRoot`).
 *
 * Regras de seguranca:
 * - Credenciais: qualquer entrada de flow-map com campo de credencial deve
 *   referenciar uma env var (`process.env.NOME_EXATO`, validado por regex
 *   estrita de match completo -- nao apenas `startsWith`), nunca um valor
 *   literal nem uma expressao arbitraria.
 * - Toda string vinda de flow-map.json/coverage-matrix.json e serializada
 *   com `JSON.stringify` antes de entrar no arquivo gerado. Isso produz um
 *   literal de string JS validamente escapado (aspas, backslash, quebras de
 *   linha, backtick, `${`) -- nunca interpolacao de template literal com
 *   `replace()` manual, que e o padrao que permite escape de contexto.
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

const CREDENTIAL_FIELD_NAMES = new Set([
  "password", "senha", "credential", "credentials", "token", "secret",
  "key", "apikey", "api_key", "clientsecret", "client_secret",
  "authtoken", "auth_token", "pin", "otp",
]);

/** `process.env.NOME` -- match completo, nome em MAIUSCULAS/underscore/digitos, nunca uma expressao. */
const ENV_REF_PATTERN = /^process\.env\.[A-Z_][A-Z0-9_]*$/;

function isCredentialField(fieldName) {
  return CREDENTIAL_FIELD_NAMES.has(String(fieldName).toLowerCase());
}

/** Garante que valores de credencial nao vazem para os specs gerados. */
function validateFlowMapCredentials(flowMap) {
  const violations = [];
  for (const flow of flowMap.flows ?? []) {
    for (const step of flow.steps ?? []) {
      for (const [fieldName, value] of Object.entries(step.input ?? {})) {
        if (!isCredentialField(fieldName)) continue;
        if (typeof value === "string" && ENV_REF_PATTERN.test(value)) continue;
        violations.push({ flow: flow.name, step: step.selector, field: fieldName, value: "[redacted]" });
      }
    }
  }
  if (violations.length > 0) {
    throw new SpecGeneratorError(
      "CREDENTIAL_VALUE_IN_FLOW_MAP",
      "Credential values must be referenced as an exact process.env.NAME reference, never as a literal or expression",
      { violations },
    );
  }
}

/**
 * Serializa qualquer valor como literal de string JS seguro. `JSON.stringify`
 * escapa aspas duplas, backslash, controles e quebras de linha -- e o unico
 * mecanismo de escaping usado neste modulo para valores dinamicos.
 */
function jsStringLiteral(value) {
  return JSON.stringify(String(value ?? ""));
}

/** Comentario de linha (`// ...`) seguro: quebras de linha terminam um `//` e injetam codigo, entao sao removidas. */
function toLineComment(text) {
  const sanitized = String(text ?? "").replace(/[\r\n]+/g, " ").trim();
  return sanitized ? `// ${sanitized}` : "// (sem descricao)";
}

/**
 * Garante que `artefatosDir` esta dentro de uma arvore `.testador/`. Escrever
 * specs fora dessa arvore violaria a garantia read-only sobre o repo-alvo --
 * esta funcao e a unica linha de defesa contra um `--dir` incorreto.
 */
function assertInsideTestadorRoot(artefatosDir) {
  const segments = artefatosDir.split(sep).filter(Boolean);
  const marker = segments.lastIndexOf(".testador");
  if (marker < 1) {
    throw new SpecGeneratorError(
      "ARTEFATOS_DIR_OUTSIDE_TESTADOR",
      `artefatosDir must be inside a .testador/ directory tree (never the target repo root): ${artefatosDir}`,
      { artefatosDir },
    );
  }
  let physical;
  let physicalRoot;
  try {
    physical = realpathSync(artefatosDir);
    physicalRoot = realpathSync(join(sep === "\\" ? `${segments[0]}\\` : sep, ...segments.slice(1, marker + 1)));
  } catch (error) {
    throw new SpecGeneratorError("ARTEFATOS_DIR_UNRESOLVABLE", `artefatosDir must already exist and resolve physically: ${artefatosDir}`, { cause: error.code });
  }
  const rel = relative(physicalRoot, physical);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new SpecGeneratorError("ARTEFATOS_DIR_SYMLINK_ESCAPE", `artefatosDir resolves outside its .testador tree: ${artefatosDir}`, { artefatosDir });
  }
}

/**
 * Caminho absoluto de `runner/fixtures/flow-fixture.mjs`, convertido para
 * `file://` URL (import ESM exige URL ou especificador relativo -- caminho
 * absoluto do Windows como string crua nao e um especificador valido).
 * Resolvido a partir de `CLAUDE_PLUGIN_ROOT` quando definido, ou
 * relativamente a este proprio modulo. Este arquivo vive em
 * `skills/testador-subagents/scripts/lib/`; quatro niveis acima
 * (`lib` -> `scripts` -> `testador-subagents` -> `skills` -> raiz do
 * plugin) chega na raiz do plugin, que contem `runner/`.
 */
function resolveFlowFixtureImportUrl() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    ? resolve(process.env.CLAUDE_PLUGIN_ROOT)
    : resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
  const fixturePath = join(pluginRoot, "runner", "fixtures", "flow-fixture.mjs");
  return pathToFileURL(fixturePath).href;
}

/**
 * Gera o conteudo de um spec .mjs a partir de um flow + entradas de coverage.
 */
function generateFlowSpec(flow, baseUrl, coverageEntries, fixtureImportUrl) {
  const coverageComment = coverageEntries.length > 0
    ? toLineComment(`Traceable to: ${coverageEntries.map((e) => e.origin?.ref ?? e.origin?.scenario ?? e.id).join(", ")}`)
    : toLineComment("Exploratory flow (no formal requirement traceability)");

  const steps = (flow.steps ?? []).map((step) => {
    if (step.action === "navigate") {
      const path = step.path ?? "";
      return `  await page.goto(new URL(${jsStringLiteral(path)}, process.env.TESTADOR_BASE_URL ?? ${jsStringLiteral(baseUrl)}).href);
  await page.waitForLoadState("networkidle");`;
    }
    if (step.action === "click") {
      return `  await page.click(${jsStringLiteral(step.selector)});`;
    }
    if (step.action === "fill") {
      const inputEntries = Object.entries(step.input ?? {});
      return inputEntries.map(([field, value]) => {
        const valueExpression = (isCredentialField(field) && typeof value === "string" && ENV_REF_PATTERN.test(value))
          ? `(${value} ?? "")`
          : jsStringLiteral(value);
        return `  await page.fill(${jsStringLiteral(step.selector)}, ${valueExpression});`;
      }).join("\n");
    }
    if (step.action === "assert_text") {
      const title = jsStringLiteral(`assert_text ${step.selector ?? ""}`.trim());
      return `  await recordAssertion(domAssertions, ${title}, () => expect(page.locator(${jsStringLiteral(step.selector)})).toContainText(${jsStringLiteral(step.expected ?? "")}));`;
    }
    if (step.action === "assert_visible") {
      const title = jsStringLiteral(`assert_visible ${step.selector ?? ""}`.trim());
      return `  await recordAssertion(domAssertions, ${title}, () => expect(page.locator(${jsStringLiteral(step.selector)})).toBeVisible());`;
    }
    if (step.action === "assert_url") {
      const title = jsStringLiteral(`assert_url ${step.pattern ?? ""}`.trim());
      return `  await recordAssertion(domAssertions, ${title}, () => expect(page).toHaveURL(new RegExp(${jsStringLiteral(step.pattern ?? "")})));`;
    }
    return `  ${toLineComment(`${step.action}: ${step.selector ?? step.description ?? ""}`)}`;
  });

  return `import { test, expect, recordAssertion, runAxeScan } from ${jsStringLiteral(fixtureImportUrl)};
${coverageComment}

test(${jsStringLiteral(flow.name)}, async ({ page, consoleErrors, apiCalls, domAssertions }) => {
${steps.join("\n")}
  await runAxeScan(page, ${jsStringLiteral(flow.name)});
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
 * @param {string} [options.fixtureImportUrl]  Override para testes (evita resolver runner/ real).
 * @returns {{ specsDir, generated: string[] }}
 */
export function generateSpecs(options = {}) {
  const artefatosDir = resolve(options.artefatosDir ?? process.cwd());
  assertInsideTestadorRoot(artefatosDir);
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const fixtureImportUrl = options.fixtureImportUrl ?? resolveFlowFixtureImportUrl();

  // Ler flow-map.json
  let flowMap = options.flowMap;
  if (!flowMap) {
    const path = join(artefatosDir, "plan", "flow-map.json");
    if (!existsSync(path)) {
      throw new SpecGeneratorError("FLOW_MAP_NOT_FOUND", `flow-map.json not found: ${path}`, { path });
    }
    flowMap = JSON.parse(readFileSync(path, "utf8"));
  }

  for (const flow of flowMap.flows ?? []) {
    if (!flow.name || typeof flow.name !== "string") {
      throw new SpecGeneratorError("FLOW_MISSING_NAME", "Every flow in flow-map.json must have a non-empty string name", { flow });
    }
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

  const usedNames = new Map();
  const generated = [];
  for (const flow of flowMap.flows ?? []) {
    // Associar entradas de coverage relevantes ao fluxo
    const relevant = coverageEntries.filter(
      (e) => e.status !== "MANUAL" && (
        (e.flow && flow.name.toLowerCase().includes(e.flow.toLowerCase())) ||
        (e.origin?.scenario && flow.name.toLowerCase().includes(e.origin.scenario.toLowerCase()))
      ),
    );

    const specContent = generateFlowSpec(flow, baseUrl, relevant, fixtureImportUrl);
    let safeName = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "flow";
    const collisions = usedNames.get(safeName) ?? 0;
    usedNames.set(safeName, collisions + 1);
    if (collisions > 0) safeName = `${safeName}-${collisions + 1}`;

    const specPath = join(specsDir, `${safeName}.spec.mjs`);
    writeFileSync(specPath, specContent, "utf8");
    generated.push(specPath);
  }

  return { specsDir, generated };
}

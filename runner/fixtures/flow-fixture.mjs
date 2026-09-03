/**
 * Fixture combinado usado pelos specs .spec.mjs gerados por
 * lib/spec-generator.mjs (fase 6).
 *
 * Compoe num unico `test.extend`:
 *  - `consoleErrors` (console-guard.mjs): falha o teste se houver erro de
 *    console/pageerror durante a execucao;
 *  - `apiCalls` (network-recorder.mjs): registra chamadas de API;
 *  - `domAssertions`: array que o spec gerado preenche via `recordAssertion`
 *    com o resultado (passed/failed) de cada `assert_*` do flow-map;
 *  - `persistFlowEvidence` (autouse): ao final de cada teste, acrescenta uma
 *    linha NDJSON em `{TESTADOR_ARTIFACTS_DIR}/run/network-calls.jsonl` com
 *    `{ testTitle, apiCalls, domAssertions }`.
 *
 * Essa persistencia e o elo que faltava para o correlacionador
 * 2xx-sem-efeito-na-UI (`lib/finding-triage.mjs::correlate2xxWithoutEffect`)
 * ter dados reais: sem isso, `apiCalls`/`domAssertions` nunca saiam do
 * processo do worker do Playwright e o correlacionador nunca era chamado
 * com argumentos nao-vazios em produção.
 *
 * Specs de a11y usam `axe-fixture.mjs` diretamente (nao precisam de
 * consoleErrors/apiCalls/domAssertions); specs de fluxo usam este arquivo.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { consoleErrorsFixture } from "./console-guard.mjs";
import { apiCallsFixture } from "./network-recorder.mjs";

/**
 * Executa uma asserção Playwright, registra o resultado (passed/failed) em
 * `domAssertions` e relança o erro em caso de falha -- o teste continua
 * reportando a falha normalmente ao Playwright, mas agora com um registro
 * estruturado que o correlacionador pode consumir.
 */
export async function recordAssertion(domAssertions, title, assertionFn) {
  try {
    await assertionFn();
    domAssertions.push({ title, status: "passed" });
  } catch (error) {
    domAssertions.push({ title, status: "failed", error: error?.message ?? String(error) });
    throw error;
  }
}

/** Executa Axe no estado final do fluxo e agrega resultados de todos os projetos. */
export async function runAxeScan(page, testTitle) {
  const tags = (process.env.TESTADOR_WCAG_TAGS ?? "wcag2a,wcag2aa,wcag21a,wcag21aa")
    .split(",").map((tag) => tag.trim()).filter(Boolean);
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  const artifactsDir = process.env.TESTADOR_ARTIFACTS_DIR;
  if (!artifactsDir) return result;
  const path = join(artifactsDir, "run", "axe-results.json");
  mkdirSync(dirname(path), { recursive: true });
  let records = [];
  if (existsSync(path)) {
    try { records = JSON.parse(readFileSync(path, "utf8")); } catch { records = []; }
    if (!Array.isArray(records)) records = [records];
  }
  records.push({ testTitle, ...result });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return result;
}

function networkCallsPath() {
  const artifactsDir = process.env.TESTADOR_ARTIFACTS_DIR;
  if (!artifactsDir) return null;
  return join(artifactsDir, "run", "network-calls.jsonl");
}

export const test = base.extend({
  consoleErrors: consoleErrorsFixture,
  apiCalls: apiCallsFixture,
  domAssertions: async ({}, use) => {
    const assertions = [];
    await use(assertions);
  },
  persistFlowEvidence: [async ({ apiCalls, domAssertions }, use, testInfo) => {
    await use();
    const path = networkCallsPath();
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      testTitle: testInfo.title,
      apiCalls: apiCalls ?? [],
      domAssertions: domAssertions ?? [],
    });
    appendFileSync(path, `${line}\n`, "utf8");
  }, { auto: true }],
});

export { expect } from "@playwright/test";

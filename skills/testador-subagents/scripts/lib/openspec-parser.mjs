import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Parser read-only de change sets do OpenSpec.
 *
 * Extrai requisitos normativos (### Requirement:) e cenarios (#### Scenario:)
 * dos arquivos specs/**\/spec.md de um change set OpenSpec. Cada cenario
 * vira um caso de teste potencial com classificacao AUTOMATABLE ou
 * MANUAL.
 *
 * REGRA ABSOLUTA: este modulo nunca escreve dentro de openspec/. Nunca
 * invoca /opsx:*. O openspec CLI e opcional e so usado como confirmacao
 * de completude -- ausencia do CLI nunca bloqueia a ingestao.
 *
 * Formato que o parser entende:
 *
 *   ### Requirement: <titulo>
 *   ...texto normativo...
 *   #### Scenario: <nome>
 *   - **WHEN** <condicao>
 *   - **THEN** <resultado esperado>
 *
 * Capacidade de automacao: um cenario e AUTOMATABLE quando fala de uma
 * superficie observavel (URL, rota, elemento de UI, requisicao de API, valor
 * computado, conteudo de tela). E MANUAL quando fala de regras de negocio
 * puras sem superficie UI/API.
 */

export class OpenSpecParserError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OpenSpecParserError";
    this.code = code;
    this.details = details;
  }
}

const REQUIREMENT_HEADING = /^### Requirement:\s*(.+)$/;
const SCENARIO_HEADING = /^#### Scenario:\s*(.+)$/;
const WHEN_LINE = /^\s*-\s*\*\*WHEN\*\*\s+(.+)$/;
const THEN_LINE = /^\s*-\s*\*\*THEN\*\*\s+(.+)$/;

/** Palavras-chave que indicam superficies observaveis (tela, rota, API). */
const AUTOMATABLE_SIGNALS = [
  /\bpage\b/i,
  /\bscreen\b/i,
  /\btela\b/i,
  /\bpagina\b/i,
  /\burl\b/i,
  /\brouta?\b/i,
  /\bapi\b/i,
  /\bendpoint\b/i,
  /\brequest\b/i,
  /\bresponse\b/i,
  /\bresposta\b/i,
  /\bbotao\b/i,
  /\bbutton\b/i,
  /\blink\b/i,
  /\bclick\b/i,
  /\bform\b/i,
  /\binput\b/i,
  /\btoken\b/i,
  /\bvar\(--/i,
  /\bhex\b/i,
  /\bcolor\b/i,
  /\bcor\b/i,
  /\brender\b/i,
  /\bdisplay\b/i,
  /\bvisivel\b/i,
  /\bvisible\b/i,
  /\bnaveg/i,
  /\bnovi/i,
];

function classifyScenario(when, then) {
  const combined = `${when} ${then}`.toLowerCase();
  for (const signal of AUTOMATABLE_SIGNALS) {
    if (signal.test(combined)) return "AUTOMATABLE";
  }
  return "MANUAL";
}

/**
 * Varre `specsDir` recursivamente e retorna todos os arquivos `spec.md`
 * encontrados (aninhamento arbitrario: `specs/<area>/<capability>/spec.md`).
 */
function findSpecFiles(specsDir) {
  const results = [];
  if (!existsSync(specsDir)) return results;
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name === "spec.md") {
        results.push(path);
      }
    }
  }
  walk(specsDir);
  return results;
}

/**
 * Extrai requisitos e cenarios de um unico arquivo `spec.md`.
 * Retorna `{ requirements, scenarios, capability }`.
 */
export function parseSpecFile(specPath, changeDir) {
  const content = readFileSync(specPath, "utf8").replace(/\r\n?/g, "\n");
  const lines = content.split("\n");
  const capability = relative(changeDir, specPath).replace(/\\/g, "/").replace(/\/spec\.md$/, "");

  const requirements = [];
  const scenarios = [];

  let currentRequirement = null;
  let currentScenario = null;

  for (const line of lines) {
    const reqMatch = line.match(REQUIREMENT_HEADING);
    if (reqMatch) {
      currentRequirement = { title: reqMatch[1].trim(), capability };
      requirements.push(currentRequirement);
      currentScenario = null;
      continue;
    }

    const scMatch = line.match(SCENARIO_HEADING);
    if (scMatch) {
      currentScenario = {
        name: scMatch[1].trim(),
        requirement: currentRequirement?.title ?? null,
        capability,
        file: specPath,
        when: null,
        then: null,
        automatable: null,
      };
      scenarios.push(currentScenario);
      continue;
    }

    if (currentScenario) {
      const whenMatch = line.match(WHEN_LINE);
      if (whenMatch && currentScenario.when === null) {
        currentScenario.when = whenMatch[1].trim();
        continue;
      }
      const thenMatch = line.match(THEN_LINE);
      if (thenMatch && currentScenario.then === null) {
        currentScenario.then = thenMatch[1].trim();
        // Classificar apos ter WHEN e THEN
        if (currentScenario.when) {
          currentScenario.automatable = classifyScenario(currentScenario.when, currentScenario.then);
        }
        continue;
      }
    }
  }

  // Cenarios sem THEN nao sao automatizaveis
  for (const scenario of scenarios) {
    if (scenario.automatable === null) {
      scenario.automatable = scenario.when && scenario.then ? "AUTOMATABLE" : "MANUAL";
    }
  }

  return { requirements, scenarios, capability: capability || "root", file: specPath };
}

/**
 * Analisa um change set OpenSpec inteiro.
 *
 * @param {string} changePath  Caminho absoluto de `openspec/changes/<nome>/`.
 * @returns {{ changeName, specsDir, specFiles, requirements, scenarios, uiDesignScenarios }}
 *
 * `uiDesignScenarios`: cenarios da capability `ui-design-system` roteados
 * para a fase de validacao UI/UX (nao para specs Playwright).
 */
export function parseOpenSpecChange(changePath) {
  const abs = resolve(changePath);
  if (!existsSync(abs)) {
    throw new OpenSpecParserError("OPENSPEC_CHANGE_NOT_FOUND", `OpenSpec change directory not found: ${abs}`, { path: abs });
  }

  const changeName = abs.split(/[\\/]/).at(-1);
  const specsDir = join(abs, "specs");
  const specFiles = findSpecFiles(specsDir);

  const allRequirements = [];
  const allScenarios = [];

  for (const specFile of specFiles) {
    const parsed = parseSpecFile(specFile, abs);
    allRequirements.push(...parsed.requirements);
    allScenarios.push(...parsed.scenarios);
  }

  // Separar cenarios de design (capability `ui-design-system`) dos demais
  const uiDesignScenarios = allScenarios.filter((s) => s.capability.includes("ui-design-system"));
  const scenarios = allScenarios.filter((s) => !s.capability.includes("ui-design-system"));

  return {
    changeName,
    changePath: abs,
    specsDir,
    specFiles,
    requirements: allRequirements,
    scenarios,
    uiDesignScenarios,
    totalScenarios: allScenarios.length,
    automatableCount: scenarios.filter((s) => s.automatable === "AUTOMATABLE").length,
    manualCount: scenarios.filter((s) => s.automatable === "MANUAL").length,
  };
}

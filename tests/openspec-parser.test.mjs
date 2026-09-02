/**
 * Parser de OpenSpec: extrai Requirement/Scenario dos specs, classifica
 * AUTOMATABLE vs MANUAL, roteia ui-design-system para fase 8.
 *
 * GUARDA: o parser nunca escreve dentro de openspec/ — verificado por
 * openspec-readonly.test.mjs separadamente.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  OpenSpecParserError,
  parseOpenSpecChange,
  parseSpecFile,
} from "../skills/testador-subagents/scripts/lib/openspec-parser.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openspec-parser-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeSpec(dir, relativePath, content) {
  const path = join(dir, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

const SAMPLE_SPEC = `
### Requirement: Token de cor deve usar custom property

#### Scenario: Cor de marca aplicada
- **WHEN** um componente precisa da cor primaria
- **THEN** usa a custom property do tokens.css (ex.: var(--color-accent)), nunca um hex literal

#### Scenario: Regra de negocio pura
- **WHEN** o sistema processa um pedido de compra
- **THEN** aplica a taxa de desconto de acordo com a politica comercial vigente
`;

const UI_DESIGN_SPEC = `
### Requirement: Accent nao pode aparecer mais de 2x por pagina

#### Scenario: Landing nao floda o accent
- **WHEN** a landing e renderizada
- **THEN** o accent aparece so no hero e no CTA do rodape
`;

test("parseSpecFile extracts requirements and scenarios from a spec.md", () => {
  const root = fixture();
  const specPath = writeSpec(root, "specs/auth/login/spec.md", SAMPLE_SPEC);
  const { requirements, scenarios, capability } = parseSpecFile(specPath, root);

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].title, "Token de cor deve usar custom property");
  assert.equal(scenarios.length, 2);
  assert.equal(scenarios[0].name, "Cor de marca aplicada");
  assert.equal(scenarios[0].when, "um componente precisa da cor primaria");
  assert.equal(
    scenarios[0].then,
    "usa a custom property do tokens.css (ex.: var(--color-accent)), nunca um hex literal",
  );
  assert.equal(capability, "specs/auth/login");
});

test("AUTOMATABLE: Scenario mentioning var(--, url or tela is classified automatable", () => {
  const root = fixture();
  const specPath = writeSpec(root, "specs/styles/spec.md", SAMPLE_SPEC);
  const { scenarios } = parseSpecFile(specPath, root);
  assert.equal(scenarios[0].automatable, "AUTOMATABLE", "var(-- should be AUTOMATABLE");
});

test("MANUAL: Scenario with no observable surface is classified as MANUAL", () => {
  const root = fixture();
  const specPath = writeSpec(root, "specs/business/spec.md", SAMPLE_SPEC);
  const { scenarios } = parseSpecFile(specPath, root);
  assert.equal(scenarios[1].automatable, "MANUAL");
});

test("parseOpenSpecChange scans nested specs/ directories recursively", () => {
  const root = fixture();
  writeSpec(root, "specs/auth/login/spec.md", SAMPLE_SPEC);
  writeSpec(
    root,
    "specs/checkout/spec.md",
    `
### Requirement: Carrinho funcional

#### Scenario: Adicionar produto
- **WHEN** o usuario clica em adicionar
- **THEN** o produto aparece no carrinho na tela
`,
  );

  const result = parseOpenSpecChange(root);
  assert.equal(result.specFiles.length, 2);
  assert.ok(result.requirements.length >= 2);
  assert.ok(result.scenarios.length >= 3);
});

test("routes ui-design-system scenarios to uiDesignScenarios, not to main scenarios", () => {
  const root = fixture();
  writeSpec(root, "specs/ui-design-system/spec.md", UI_DESIGN_SPEC);
  writeSpec(root, "specs/auth/login/spec.md", SAMPLE_SPEC);

  const result = parseOpenSpecChange(root);
  assert.ok(result.uiDesignScenarios.length >= 1);
  assert.ok(result.uiDesignScenarios.every((s) => s.capability.includes("ui-design-system")));
  assert.ok(result.scenarios.every((s) => !s.capability.includes("ui-design-system")));
});

test("Scenario without THEN is classified as MANUAL (incomplete)", () => {
  const root = fixture();
  const specPath = writeSpec(
    root,
    "specs/incomplete/spec.md",
    `
### Requirement: Algo

#### Scenario: Incompleto
- **WHEN** algo acontece
`,
  );
  const { scenarios } = parseSpecFile(specPath, root);
  assert.equal(scenarios[0].automatable, "MANUAL");
});

test("parseOpenSpecChange throws OPENSPEC_CHANGE_NOT_FOUND for a missing directory", () => {
  assert.throws(
    () => parseOpenSpecChange("/definitely/does/not/exist"),
    (error) =>
      error instanceof OpenSpecParserError && error.code === "OPENSPEC_CHANGE_NOT_FOUND",
  );
});

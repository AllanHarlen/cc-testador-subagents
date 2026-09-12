/**
 * Guarda de integridade de referencias entre docs e codigo:
 *
 *  1. Toda referencia a arquivos de references/, assets/ ou scripts/ (canonico,
 *     via ${CLAUDE_SKILL_DIR}) citada em SKILL.md, nos dois READMEs e nas
 *     proprias references/ aponta para um arquivo que existe de fato.
 *  2. Bijecao entre `scripts/` (wrappers de compatibilidade) e
 *     `skills/testador-subagents/scripts/` (CLIs canonicos) -- exceto
 *     `testador-spec.mjs`, que e fonte de verdade doc<->codigo e nao e CLI
 *     (documentado no proprio header, sem wrapper por design).
 *  3. Todo `command` de tipo "script" em `lib/gates.mjs::planGates()` aponta
 *     para um CLI canonico que existe de fato.
 *  4. As contagens do bloco "Layout" nos dois READMEs batem com o disco.
 *
 * Esta suite existe porque nenhuma das outras (`docs-consistency.test.mjs`
 * so compara constantes JS entre si, nunca le Markdown) protegia contra os
 * arquivos ausentes / contagens erradas encontrados na revisao original.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_ROOT = join(REPO_ROOT, "skills", "testador-subagents");
const CANONICAL_SCRIPTS_DIR = join(SKILL_ROOT, "scripts");
const WRAPPER_SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const REFERENCES_DIR = join(SKILL_ROOT, "references");
const ASSETS_DIR = join(SKILL_ROOT, "assets");

const DOC_FILES = [
  join(SKILL_ROOT, "SKILL.md"),
  join(REPO_ROOT, "README.md"),
  join(REPO_ROOT, "README.pt-BR.md"),
  join(REPO_ROOT, "commands", "testador.md"),
  ...readdirSync(REFERENCES_DIR).filter((f) => f.endsWith(".md")).map((f) => join(REFERENCES_DIR, f)),
];

function readText(path) {
  return readFileSync(path, "utf8");
}

// --- 1. Todo caminho citado em prosa resolve para um arquivo real ---

test("every references/*.md citation in the docs points to a file that exists", () => {
  const pattern = /references\/([a-z0-9-]+\.md)/g;
  for (const docPath of DOC_FILES) {
    const text = readText(docPath);
    for (const match of text.matchAll(pattern)) {
      const target = join(REFERENCES_DIR, match[1]);
      assert.ok(existsSync(target), `${docPath} cites references/${match[1]}, which does not exist at ${target}`);
    }
  }
});

test("every assets/* citation in the docs points to a file that exists", () => {
  const pattern = /assets\/([a-z0-9.-]+\.(?:json|md))/g;
  for (const docPath of DOC_FILES) {
    // The shared handoff contract intentionally describes paths inside a
    // producer's resolved design package; they are not Testador-owned assets.
    if (docPath.endsWith("handoff-contract.md")) continue;
    const text = readText(docPath);
    for (const match of text.matchAll(pattern)) {
      const target = join(ASSETS_DIR, match[1]);
      assert.ok(existsSync(target), `${docPath} cites assets/${match[1]}, which does not exist at ${target}`);
    }
  }
});

test("every ${CLAUDE_SKILL_DIR}/scripts/*.mjs citation points to a canonical CLI that exists", () => {
  const pattern = /\$\{CLAUDE_SKILL_DIR\}\/scripts\/([a-z0-9-]+\.mjs)/g;
  for (const docPath of DOC_FILES) {
    const text = readText(docPath);
    for (const match of text.matchAll(pattern)) {
      const target = join(CANONICAL_SCRIPTS_DIR, match[1]);
      assert.ok(existsSync(target), `${docPath} cites \${CLAUDE_SKILL_DIR}/scripts/${match[1]}, which does not exist at ${target}`);
    }
  }
});

// --- 2. Bijecao wrapper <-> canonico ---

test("every root scripts/ wrapper has a canonical counterpart in skills/testador-subagents/scripts/", () => {
  const wrappers = readdirSync(WRAPPER_SCRIPTS_DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(wrappers.length > 0, "expected at least one wrapper");
  for (const name of wrappers) {
    const canonical = join(CANONICAL_SCRIPTS_DIR, name);
    assert.ok(existsSync(canonical), `wrapper scripts/${name} has no canonical counterpart at skills/testador-subagents/scripts/${name}`);
  }
});

test("every canonical CLI (except testador-spec.mjs) has a compatibility wrapper in scripts/", () => {
  const canonicalFiles = readdirSync(CANONICAL_SCRIPTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .filter((name) => name !== "testador-spec.mjs");
  assert.ok(canonicalFiles.length > 0, "expected at least one canonical CLI");
  for (const name of canonicalFiles) {
    const wrapper = join(WRAPPER_SCRIPTS_DIR, name);
    assert.ok(existsSync(wrapper), `canonical CLI skills/testador-subagents/scripts/${name} has no compatibility wrapper at scripts/${name}`);
  }
});

test("a wrapper's single import statement points at its own-named canonical file", () => {
  const wrappers = readdirSync(WRAPPER_SCRIPTS_DIR).filter((f) => f.endsWith(".mjs"));
  for (const name of wrappers) {
    const content = readText(join(WRAPPER_SCRIPTS_DIR, name));
    const match = content.match(/import\s+["']\.\.\/skills\/testador-subagents\/scripts\/([a-z0-9-]+\.mjs)["']/);
    assert.ok(match, `wrapper scripts/${name} must import its canonical counterpart by relative path`);
    assert.equal(match[1], name, `wrapper scripts/${name} imports ${match[1]}, expected ${name}`);
  }
});

// --- 3. Todo comando de gate "script" aponta para um CLI que existe ---

test("every script-kind gate command in lib/gates.mjs resolves to a canonical CLI that exists", async () => {
  const { planGates } = await import("../skills/testador-subagents/scripts/lib/gates.mjs");
  const contexts = [
    { scope: "SMOKE", hasFrontend: true },
    { scope: "STANDARD", hasFrontend: true, hasOpenSpec: true, hasOpenDesign: true, jointMode: true },
    { scope: "FULL", hasFrontend: true, hasApi: true, hasOpenSpec: true, hasOpenDesign: true, jointMode: true },
    { scope: "STANDARD", hasFrontend: false },
  ];
  for (const context of contexts) {
    const { gates } = planGates(context);
    for (const gate of gates) {
      if (gate.kind !== "script") continue;
      const scriptToken = gate.command[1];
      const match = scriptToken.match(/\$\{CLAUDE_SKILL_DIR\}\/scripts\/([a-z0-9-]+\.mjs)/);
      assert.ok(match, `gate ${gate.id} command[1] must reference \${CLAUDE_SKILL_DIR}/scripts/<name>.mjs, got "${scriptToken}"`);
      const target = join(CANONICAL_SCRIPTS_DIR, match[1]);
      assert.ok(existsSync(target), `gate ${gate.id} (context ${JSON.stringify(context)}) points at ${match[1]}, which does not exist`);
    }
  }
});

// --- 4. Contagens do Layout nos READMEs batem com o disco ---

function countFiles(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && predicate(e.name)).length;
}

test("README Layout counts match the real file counts on disk", () => {
  const wrapperCount = countFiles(WRAPPER_SCRIPTS_DIR, (n) => n.endsWith(".mjs"));
  const canonicalCliCount = countFiles(CANONICAL_SCRIPTS_DIR, (n) => n.endsWith(".mjs") && n !== "testador-spec.mjs");
  const libModuleCount = countFiles(join(CANONICAL_SCRIPTS_DIR, "lib"), (n) => n.endsWith(".mjs"));
  const referenceCount = countFiles(REFERENCES_DIR, (n) => n.endsWith(".md"));
  const assetCount = readdirSync(ASSETS_DIR, { withFileTypes: true }).filter((e) => e.isFile()).length;

  // Bijecao ja garante wrapperCount === canonicalCliCount; a asserция aqui
  // e sobre o LITERAL escrito no README, para pegar o proximo desvio assim
  // que aparecer (ex.: alguem adiciona um CLI novo e esquece de atualizar o texto).
  for (const readmePath of [join(REPO_ROOT, "README.md"), join(REPO_ROOT, "README.pt-BR.md")]) {
    const text = readText(readmePath);
    assert.match(text, new RegExp(`\\(${wrapperCount} (compatibility wrappers|wrappers de compatibilidade)`), `${readmePath}: wrapper count literal must say ${wrapperCount}`);
    assert.match(text, new RegExp(`\\(${canonicalCliCount} (canonical CLIs|CLIs can[oô]nicos)`), `${readmePath}: canonical CLI count literal must say ${canonicalCliCount}`);
    assert.match(text, new RegExp(`\\(${libModuleCount} (modules|m[oó]dulos)`), `${readmePath}: lib module count literal must say ${libModuleCount}`);
  }

  // As duas contagens tambem devem bater entre si (a asserção de bijeção
  // acima ja garante isso, mas trava explicitamente o invariante aqui).
  assert.equal(wrapperCount, canonicalCliCount);
  assert.ok(referenceCount > 0);
  assert.ok(assetCount > 0);
});

// --- 5. Paridade de secoes entre README.md e README.pt-BR.md ---

function headerCount(text) {
  return (text.match(/^##\s+/gm) ?? []).length;
}

test("README.md and README.pt-BR.md have the same number of ## sections", () => {
  const en = readText(join(REPO_ROOT, "README.md"));
  const pt = readText(join(REPO_ROOT, "README.pt-BR.md"));
  assert.equal(headerCount(en), headerCount(pt), "the English and Portuguese READMEs must document the same set of sections");
});

// --- 6. Nenhum caractere acentuado vaza na convencao "portugues sem acentos" ---

const ACCENTED_PATTERN = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

test("SKILL.md and references/*.md follow the accent-stripped Portuguese convention consistently", () => {
  const filesToCheck = [join(SKILL_ROOT, "SKILL.md"), ...readdirSync(REFERENCES_DIR).map((f) => join(REFERENCES_DIR, f))];
  const offenders = [];
  for (const path of filesToCheck) {
    const lines = readText(path).split(/\r?\n/);
    lines.forEach((line, index) => {
      // Blocos de codigo (``` ou indentados por 4 espacos) podem conter
      // qualquer coisa (comandos, JSON) -- o scan e so sobre prosa.
      if (line.trim().startsWith("```") || /^\s{4,}\S/.test(line)) return;
      if (ACCENTED_PATTERN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `accented characters leaked into the accent-stripped Portuguese convention:\n${offenders.join("\n")}`);
});

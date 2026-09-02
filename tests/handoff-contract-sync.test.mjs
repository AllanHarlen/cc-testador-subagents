/**
 * Trava a invariante byte-identica: `handoff-contract.md`,
 * `handoff-validator.mjs` e `handoff.schema.json` devem ser identicos nos
 * quatro plugins (cc-pensador, cc-orchestrador-subagents, cc-testador-subagents,
 * cc-executor-subagents) quando todos estiverem presentes no workspace.
 *
 * Cada arquivo e comparado contra a copia do TESTADOR (a mais recente,
 * a source-of-truth para a extensao de quatro estagios). Plugins ausentes
 * no workspace sao pulados com um aviso — o teste nao deve falhar so porque
 * o CI so tem um dos repos.
 *
 * NOTA: handoff-validator.mjs do EXECUTOR e um caso especial — ele tem a
 * regra EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL enquanto o testador tem
 * TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR. Sao DIFERENTES por design.
 * O que deve ser identico e o HANDOFF_STAGES, HANDOFF_ROLES_BY_STAGE e o
 * SUPPORTED_HANDOFF_VERSION. Esse arquivo so verifica handoff-contract.md
 * (que deve ser byte-identico) e nao o handoff-validator.mjs (que tem
 * diferencas legitimas por plugin).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKSPACE = fileURLToPath(new URL("../../", import.meta.url));
const TESTADOR_CONTRACT = join(WORKSPACE, "cc-testador-subagents/skills/testador-subagents/references/handoff-contract.md");

const SIBLING_CONTRACTS = [
  { plugin: "cc-executor-subagents", path: "skills/executor-subagents/references/handoff-contract.md" },
  { plugin: "cc-pensador", path: "skills/pensador/references/handoff-contract.md" },
  { plugin: "cc-orchestrador-subagents", path: "skills/orchestrator-multi-agent-development/references/handoff-contract.md" },
];

const SIBLING_VALIDATORS = [
  { plugin: "cc-executor-subagents", path: "skills/executor-subagents/scripts/lib/handoff-validator.mjs" },
  { plugin: "cc-pensador", path: "scripts/lib/handoff-validator.mjs" },
  { plugin: "cc-orchestrador-subagents", path: "skills/orchestrator-multi-agent-development/scripts/lib/handoff-validator.mjs" },
];

test("handoff-contract.md is byte-identical in all four plugins that are present in the workspace", () => {
  if (!existsSync(TESTADOR_CONTRACT)) {
    assert.fail("testador handoff-contract.md not found — this is the source of truth");
  }
  const source = readFileSync(TESTADOR_CONTRACT);
  let checked = 0;
  for (const { plugin, path } of SIBLING_CONTRACTS) {
    const full = join(WORKSPACE, plugin, path);
    if (!existsSync(full)) {
      console.log(`  [skip] ${plugin}/${path} not found in workspace`);
      continue;
    }
    const sibling = readFileSync(full);
    assert.ok(
      source.equals(sibling),
      `handoff-contract.md in ${plugin} differs from cc-testador-subagents — must be byte-identical`,
    );
    checked += 1;
  }
  console.log(`  [ok] handoff-contract.md is byte-identical in ${checked + 1} plugins`);
});

test("all present sibling handoff-validator.mjs export HANDOFF_STAGES that includes testador between orchestrador and executor", async () => {
  for (const { plugin, path } of SIBLING_VALIDATORS) {
    const full = join(WORKSPACE, plugin, path);
    if (!existsSync(full)) {
      console.log(`  [skip] ${plugin}/${path} not found`);
      continue;
    }
    const url = new URL(`file:///${full.replace(/\\/g, "/")}`);
    const { HANDOFF_STAGES } = await import(url.href);
    const stages = [...HANDOFF_STAGES];
    const iOrq = stages.indexOf("orchestrador");
    const iTest = stages.indexOf("testador");
    const iExec = stages.indexOf("executor");
    assert.ok(
      iOrq > -1 && iTest > -1 && iExec > -1 && iOrq < iTest && iTest < iExec,
      `${plugin}: HANDOFF_STAGES does not include testador between orchestrador and executor — got ${stages.join(",")}`,
    );
    console.log(`  [ok] ${plugin}: HANDOFF_STAGES = ${stages.join(",")}`);
  }
});

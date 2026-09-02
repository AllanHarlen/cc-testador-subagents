/**
 * `.testador/checkpoint.json` como indice: `execucao_atual` + `historico[]`.
 * Sem os dois campos `plano_predefinido`/`plano_predefinido_fonte` do
 * executor — o Testador nao trabalha sobre "plano do usuario".
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointPath,
  readCheckpointIndex,
  upsertRunEntry,
  writeCheckpointIndex,
} from "../skills/testador-subagents/scripts/lib/checkpoint-index.mjs";

const roots = [];
function projectRoot() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-checkpoint-index-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("readCheckpointIndex returns a fresh skeleton when no file exists", () => {
  const root = projectRoot();
  const result = readCheckpointIndex(root);
  assert.equal(result.exists, false);
  assert.deepEqual(result.index, {
    version: String(CHECKPOINT_SCHEMA_VERSION),
    execucao_atual: "",
    historico: [],
  });
});

test("writeCheckpointIndex persists atomically and round-trips through readCheckpointIndex", () => {
  const root = projectRoot();
  const written = writeCheckpointIndex(root, { execucao_atual: ".testador/a/artefatos", historico: [] });
  assert.ok(existsSync(written.path));

  const reread = readCheckpointIndex(root);
  assert.equal(reread.index.execucao_atual, ".testador/a/artefatos");
  assert.deepEqual(reread.migrationNotes, []);
});

test("readCheckpointIndex throws CHECKPOINT_UNPARSEABLE on invalid JSON, never overwriting", () => {
  const root = projectRoot();
  const path = checkpointPath(root);
  mkdirSync(join(root, ".testador"), { recursive: true });
  writeFileSync(path, "{ not json", "utf8");
  assert.throws(() => readCheckpointIndex(root), (error) => error.code === "CHECKPOINT_UNPARSEABLE");
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("upsertRunEntry adds a new historico entry and can set/clear execucao_atual", () => {
  let index = { version: "1", execucao_atual: "", historico: [] };
  index = upsertRunEntry(index, { artefatos_dir: ".testador/a/artefatos", status: "RUNNING" }, { active: true });
  assert.equal(index.execucao_atual, ".testador/a/artefatos");
  assert.equal(index.historico.length, 1);

  index = upsertRunEntry(index, { artefatos_dir: ".testador/a/artefatos", status: "DONE" }, { active: false });
  assert.equal(index.execucao_atual, "");
  assert.equal(index.historico.length, 1);
  assert.equal(index.historico[0].status, "DONE");
});

test("upsertRunEntry updates an existing entry in place instead of duplicating it", () => {
  let index = { version: "1", execucao_atual: "", historico: [{ artefatos_dir: ".testador/a/artefatos", status: "RUNNING" }] };
  index = upsertRunEntry(index, { artefatos_dir: ".testador/a/artefatos", status: "BLOCKED" });
  assert.equal(index.historico.length, 1);
  assert.equal(index.historico[0].status, "BLOCKED");
});

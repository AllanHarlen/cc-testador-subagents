/**
 * Contrato de linha de comando dos scripts (copiado do cc-executor-subagents).
 *
 * Regressao de um bug de classe: `parseArgs` transforma uma flag sem valor
 * (`--payload`) em `true`, e `required` so rejeitava `undefined`/`""`. O
 * `true` vazava para o corpo do script e virava um erro cru do Node em vez
 * do `MISSING_ARGUMENT` + exit 2 que o contrato da CLI promete.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { boolArg, jsonArg, numberArg, required } from "../skills/testador-subagents/scripts/lib/cli-utils.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-cli-contract-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("required() rejects a flag passed with no value, not just an absent one", () => {
  assert.throws(() => required({ file: true }, "file"), (error) => error.code === "MISSING_ARGUMENT");
  assert.throws(() => required({}, "file"), (error) => error.code === "MISSING_ARGUMENT");
  assert.throws(() => required({ file: "" }, "file"), (error) => error.code === "MISSING_ARGUMENT");
  assert.equal(required({ file: "x.txt" }, "file"), "x.txt");
});

test("numberArg() rejects a flag with no value instead of coercing true to 1", () => {
  assert.throws(() => numberArg(true), (error) => error.code === "INVALID_NUMBER");
  assert.equal(numberArg(undefined, 42), 42);
  assert.equal(numberArg("7"), 7);
});

test("boolArg() parses common truthy/falsy tokens and rejects garbage", () => {
  assert.equal(boolArg("true"), true);
  assert.equal(boolArg("no"), false);
  assert.equal(boolArg(undefined, false), false);
  assert.throws(() => boolArg("maybe"), (error) => error.code === "INVALID_BOOLEAN");
});

test("jsonArg() parses JSON and rejects malformed input with a structured error", () => {
  assert.deepEqual(jsonArg('{"a":1}'), { a: 1 });
  assert.throws(() => jsonArg("{not json"), (error) => error.code === "INVALID_JSON_ARGUMENT");
});

test("fixture helper creates and cleans up a temp directory", () => {
  const root = fixture();
  assert.ok(root.includes(".tmp-cli-contract-test-"));
});

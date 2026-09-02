#!/usr/bin/env node
/**
 * CLI de validacao de handoff.json para cc-testador-subagents.
 *
 * Uso: node "${CLAUDE_SKILL_DIR}/scripts/validate-handoff.mjs" --file <path>
 * Saida JSON { ok, file, errors[] } no stdout; exit 0 somente quando ok: true.
 *
 * Contrato de saida especial (diferente de executeJsonCli): este CLI usa
 * stdout para TUDO — sucesso e falha — para que possa ser usado como gate
 * shell com `node validate-handoff.mjs --file ... && echo "ok"`. Erros de
 * validacao NAO vao para stderr; exit code 1 sinaliza falha de validacao.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateHandoff } from "./lib/handoff-validator.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
    result[key] = value;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (!args.file || args.file === true) {
  console.log(JSON.stringify({ ok: false, file: null, errors: [{ code: "MISSING_FILE_ARG", message: "Missing --file argument", path: null }] }));
  process.exitCode = 1;
} else {
  const filePath = resolve(String(args.file));
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    console.log(JSON.stringify({ ok: false, file: filePath, errors: [{ code: "FILE_NOT_READABLE", message: error.message?.split(/\r?\n/)[0] ?? "cannot read file", path: null }] }));
    process.exitCode = 1;
    process.exit();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, file: filePath, errors: [{ code: "INVALID_JSON", message: `Invalid JSON: ${error.message?.split(/\r?\n/)[0] ?? "parse error"}`, path: null }] }));
    process.exitCode = 1;
    process.exit();
  }
  const result = validateHandoff(parsed);
  console.log(JSON.stringify({ ok: result.ok, file: filePath, errors: result.errors }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

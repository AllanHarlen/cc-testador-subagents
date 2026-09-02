#!/usr/bin/env node
/**
 * CLI de construcao da matriz de cobertura.
 * build-coverage-matrix.mjs [--requirements-index <path>] [--openspec-change <dir>] [--root .]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildCoverageMatrix } from "./lib/coverage-matrix.mjs";
import { parseOpenSpecChange } from "./lib/openspec-parser.mjs";
import { executeJsonCli, parseArgs } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return {
      name: "build-coverage-matrix",
      commands: { build: "build-coverage-matrix.mjs [--requirements-index <path>] [--openspec-change <dir>] [--root .]" },
    };
  }
  const root = args.root === true ? process.cwd() : (args.root ?? process.cwd());
  // `--requirements-index` (sem valor) vira `true` em `parseArgs`; sem este
  // guard, `resolve(root, String(true))` resolvia para um caminho chamado
  // literalmente "true" em vez de sinalizar o erro de uso.
  if (args["requirements-index"] === true) {
    const error = new Error("--requirements-index requires a path value");
    error.code = "MISSING_ARGUMENT";
    throw error;
  }
  if (args["openspec-change"] === true) {
    const error = new Error("--openspec-change requires a directory path value");
    error.code = "MISSING_ARGUMENT";
    throw error;
  }
  const requirementsIndexPath = args["requirements-index"]
    ? resolve(root, String(args["requirements-index"]))
    : null;

  let openSpecScenarios = null;
  if (args["openspec-change"]) {
    const changePath = resolve(root, String(args["openspec-change"]));
    if (existsSync(changePath)) {
      const parsed = parseOpenSpecChange(changePath);
      openSpecScenarios = parsed.scenarios;
    }
  }

  return { result: buildCoverageMatrix({ requirementsIndexPath, openSpecScenarios }) };
}

executeJsonCli(main);

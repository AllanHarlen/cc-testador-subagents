#!/usr/bin/env node
/**
 * CLI de construcao da matriz de cobertura.
 * build-coverage-matrix.mjs [--requirements-index <path>] [--openspec-change <dir>] [--root .]
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCoverageMatrix, entriesFromOpenSpecScenarios } from "./lib/coverage-matrix.mjs";
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

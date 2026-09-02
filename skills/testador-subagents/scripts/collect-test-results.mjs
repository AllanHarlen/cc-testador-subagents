#!/usr/bin/env node
/**
 * CLI de coleta de resultados Playwright (JSON/JUnit).
 * collect-test-results.mjs --dir <artefatos_dir>
 *
 * Le {artefatos_dir}/run/playwright-report/results.json (gerado por
 * run-specs.mjs) e converte em envelope de intelligence estruturado
 * (lib/playwright-report.mjs).
 */
import { collectPlaywrightResults } from "./lib/playwright-report.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "collect-test-results", commands: { collect: "collect-test-results.mjs --dir <artefatos_dir>" } };
  }
  const dir = required(args, "dir");
  return { result: collectPlaywrightResults(dir) };
}

executeJsonCli(main);

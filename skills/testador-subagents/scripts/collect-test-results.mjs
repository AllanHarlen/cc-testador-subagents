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
import { updateCompletionGate } from "./lib/testador-state.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "collect-test-results", commands: { collect: "collect-test-results.mjs --dir <artefatos_dir>" } };
  }
  const dir = required(args, "dir");
  const result = collectPlaywrightResults(dir);
  if (existsSync(join(resolve(dir), "state.json"))) {
    const status = result.summary.status === "PASS" ? "DONE" : result.summary.status === "FAIL" ? "BLOCKED" : "BLOCKED";
    updateCompletionGate(dir, "deterministic", status, { evidence: [result.evidenceId], reason: `Playwright result: ${result.summary.status}` });
  }
  return { result };
}

executeJsonCli(main);

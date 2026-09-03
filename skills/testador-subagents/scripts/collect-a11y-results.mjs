#!/usr/bin/env node
/**
 * CLI de coleta de resultados axe.
 * collect-a11y-results.mjs --dir <artefatos_dir> [--a11y-blocking bool]
 */
import { collectAxeResults } from "./lib/axe-report.mjs";
import { executeJsonCli, boolArg, parseArgs, required } from "./lib/cli-utils.mjs";
import { updateCompletionGate } from "./lib/testador-state.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "collect-a11y-results", commands: { collect: "collect-a11y-results.mjs --dir <artefatos_dir> [--a11y-blocking bool]" } };
  }
  const dir = required(args, "dir");
  const a11yBlocking = boolArg(args["a11y-blocking"], false);
  const result = collectAxeResults(dir, { a11yBlocking });
  if (existsSync(join(resolve(dir), "state.json"))) {
    const status = result.summary.status === "PASS" ? "DONE" : "BLOCKED";
    updateCompletionGate(dir, "a11y", status, { evidence: [result.evidenceId], reason: `Axe result: ${result.summary.status}` });
  }
  return { result };
}

executeJsonCli(main);

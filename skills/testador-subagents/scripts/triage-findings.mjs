#!/usr/bin/env node
/**
 * CLI de triagem de achados.
 * triage-findings.mjs --dir <artefatos_dir> [--a11y-blocking bool]
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { triageFindings } from "./lib/finding-triage.mjs";
import { executeJsonCli, boolArg, parseArgs, required } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "triage-findings", commands: { triage: "triage-findings.mjs --dir <artefatos_dir> [--a11y-blocking bool]" } };
  }
  const dir = required(args, "dir");
  const artefatosDir = resolve(dir);
  const a11yBlocking = boolArg(args["a11y-blocking"], false);

  // Ler achados brutos de varios relatorios
  const rawFindings = [];

  const playwrightResultsPath = join(artefatosDir, "run", "playwright-report", "findings.json");
  if (existsSync(playwrightResultsPath)) {
    try { rawFindings.push(...JSON.parse(readFileSync(playwrightResultsPath, "utf8"))); } catch { /* opcional */ }
  }

  const axeResultsPath = join(artefatosDir, "run", "axe-findings.json");
  if (existsSync(axeResultsPath)) {
    try { rawFindings.push(...JSON.parse(readFileSync(axeResultsPath, "utf8"))); } catch { /* opcional */ }
  }

  const uiuxResultsPath = join(artefatosDir, "review", "uiux-findings.json");
  if (existsSync(uiuxResultsPath)) {
    try { rawFindings.push(...JSON.parse(readFileSync(uiuxResultsPath, "utf8"))); } catch { /* opcional */ }
  }

  const requirementsPath = join(artefatosDir, "plan", "coverage-matrix.json");
  let requirements = [];
  if (existsSync(requirementsPath)) {
    try {
      const matrix = JSON.parse(readFileSync(requirementsPath, "utf8"));
      requirements = (matrix.entries ?? []).map((e) => ({
        id: e.origin?.ref ?? e.id,
        title: e.flow ?? e.origin?.title,
        scenario: e.origin?.scenario,
        criteria: [],
      }));
    } catch { /* opcional */ }
  }

  return { result: triageFindings({ rawFindings, requirements, a11yBlocking }) };
}

executeJsonCli(main);

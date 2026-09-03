#!/usr/bin/env node
/**
 * CLI de triagem de achados.
 * triage-findings.mjs --dir <artefatos_dir> [--a11y-blocking bool] [--has-open-design bool]
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { triageFindings } from "./lib/finding-triage.mjs";
import { executeJsonCli, boolArg, parseArgs, required } from "./lib/cli-utils.mjs";

/** Le um arquivo NDJSON (uma linha JSON por registro); linhas invalidas sao ignoradas. */
function readNdjson(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // linha corrompida -- ignorada, nao interrompe a leitura das demais
    }
  }
  return records;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return {
      name: "triage-findings",
      commands: { triage: "triage-findings.mjs --dir <artefatos_dir> [--a11y-blocking bool] [--has-open-design bool]" },
    };
  }
  const dir = required(args, "dir");
  const artefatosDir = resolve(dir);
  const a11yBlocking = boolArg(args["a11y-blocking"], false);
  const hasOpenDesign = boolArg(args["has-open-design"], false);

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

  // Alimenta o correlacionador 2xx-sem-efeito com o que os specs gerados
  // gravaram via runner/fixtures/flow-fixture.mjs::persistFlowEvidence
  // durante `run-specs.mjs`. Sem isso, apiCalls/domAssertions ficavam
  // sempre vazios e o correlacionador nunca produzia um achado real.
  const networkCallsPath = join(artefatosDir, "run", "network-calls.jsonl");
  const flowRecords = readNdjson(networkCallsPath);
  return { result: triageFindings({ rawFindings, requirements, a11yBlocking, hasOpenDesign, flowRecords }) };
}

executeJsonCli(main);

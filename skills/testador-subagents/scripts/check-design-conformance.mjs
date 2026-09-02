#!/usr/bin/env node
/**
 * CLI de verificacao de conformidade Open Design.
 * check-design-conformance.mjs --dir <artefatos_dir> [--root .]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareConformanceChecklist, buildConformanceIntelligence } from "./lib/design-conformance.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "check-design-conformance", commands: { check: "check-design-conformance.mjs --dir <artefatos_dir> [--root .]" } };
  }
  const dir = required(args, "dir");
  const projectRoot = args.root === true ? process.cwd() : (args.root ?? process.cwd());
  const artefatosDir = resolve(dir);

  // Ler ingest result para encontrar design system entries
  const designEntriesPath = join(artefatosDir, "plan", "design-systems.json");

  let designEntries = [];
  if (existsSync(designEntriesPath)) {
    try {
      designEntries = JSON.parse(readFileSync(designEntriesPath, "utf8"));
    } catch { /* opcional */ }
  }

  if (designEntries.length === 0) {
    return { result: { message: "No design system entries found — skipping conformance check", checklists: [], staticFindings: [] } };
  }

  const checklists = designEntries.map((entry) => prepareConformanceChecklist(entry, projectRoot));
  return { result: buildConformanceIntelligence(checklists) };
}

executeJsonCli(main);

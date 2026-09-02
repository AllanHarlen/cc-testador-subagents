#!/usr/bin/env node
/**
 * CLI de ingestao de upstream (`ingest-upstream [--root .] [--slug <slug>]`).
 * Read-only: descobre o handoff do Orquestrador, sobe a chain ate o Pensador
 * e relata o modo de operacao e os insumos de validacao encontrados.
 */
import { ingestUpstream } from "./lib/upstream-ingest.mjs";
import { executeJsonCli, parseArgs } from "./lib/cli-utils.mjs";

function help() {
  return {
    name: "ingest-upstream",
    commands: {
      ingest: "ingest-upstream.mjs [--root .] [--slug <slug>]",
    },
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help || args.h) return help();
  const root = args.root === true ? process.cwd() : (args.root ?? process.cwd());
  const slug = args.slug === true ? undefined : args.slug;
  return { result: ingestUpstream({ projectRoot: root, slug }) };
}

executeJsonCli(main);

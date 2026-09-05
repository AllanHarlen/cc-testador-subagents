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

// A shell caller chaining `&&` on this CLI needs to be able to tell "clean
// joint ingest" (exit 0), "ambiguous — needs --slug" (exit 3), and "degraded
// to standalone because the upstream handoff was invalid/corrupt" (exit 4)
// apart — all three previously exited 0 identically.
executeJsonCli(main, {
  resolveExitCode: (result) => {
    const mode = result?.result?.mode;
    if (mode === "ambiguous") return 3;
    if (mode === "standalone" && result?.result?.invalidHandoff) return 4;
    return 0;
  },
});

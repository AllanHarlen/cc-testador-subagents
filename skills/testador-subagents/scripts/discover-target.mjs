#!/usr/bin/env node

/**
 * CLI de descoberta de alvo (`discover-target [--root .]`).
 *
 * Camada fina sobre `lib/target-discovery.mjs`. Read-only: nunca escreve
 * arquivo nenhum, apenas imprime o envelope de intelligence.
 */

import { discoverTarget } from "./lib/target-discovery.mjs";
import { executeJsonCli, parseArgs } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "discover-target", commands: { discover: "discover-target.mjs [--root .]" } };
  }
  // `parseArgs` aceita tanto `--root .` quanto `--root=.`; usar diretamente
  // (em vez do antigo parsing posicional `argv[0] === "--root" ? argv[1] : cwd()`)
  // corrige o caso `--root=/x` sendo ignorado silenciosamente e o caso
  // `discover-target.mjs --dir foo --root /x` caindo em cwd() por engano.
  const root = args.root === true ? process.cwd() : (args.root ?? process.cwd());
  return { result: discoverTarget(root) };
}

executeJsonCli(main);

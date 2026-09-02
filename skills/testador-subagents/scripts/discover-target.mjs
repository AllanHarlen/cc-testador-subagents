#!/usr/bin/env node

/**
 * CLI de descoberta de alvo (`discover-target [--root .]`).
 *
 * Camada fina sobre `lib/target-discovery.mjs`. Read-only: nunca escreve
 * arquivo nenhum, apenas imprime o envelope de intelligence.
 */

import { discoverTarget } from "./lib/target-discovery.mjs";
import { executeJsonCli } from "./lib/cli-utils.mjs";

function help() {
  return {
    name: "discover-target",
    commands: {
      discover: "discover-target.mjs [--root .]",
    },
  };
}

function main(argv) {
  const root = argv[0] === "--root" ? argv[1] : process.cwd();
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") return help();
  return { result: discoverTarget(root ?? process.cwd()) };
}

executeJsonCli(main);

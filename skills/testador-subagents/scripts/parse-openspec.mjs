#!/usr/bin/env node
/**
 * CLI de parse de OpenSpec (`parse-openspec --change-path <dir>`).
 * Read-only: extrai Scenarios do change set sem escrever em openspec/.
 */
import { parseOpenSpecChange } from "./lib/openspec-parser.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

function help() {
  return {
    name: "parse-openspec",
    commands: {
      parse: "parse-openspec.mjs --change-path <dir>",
    },
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) return help();
  const changePath = required(args, "change-path");
  return { result: parseOpenSpecChange(changePath) };
}

executeJsonCli(main);

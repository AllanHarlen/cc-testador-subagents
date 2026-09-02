#!/usr/bin/env node
/**
 * CLI de planejamento de gates.
 * testador-gates.mjs plan --scope <SMOKE|STANDARD|FULL>
 *   [--has-frontend bool] [--has-api bool] [--separate-origin bool]
 *   [--joint-mode bool] [--has-openspec bool] [--has-open-design bool]
 *   [--a11y-blocking bool]
 */
import { GatesError, planGates } from "./lib/gates.mjs";
import { executeJsonCli, boolArg, parseArgs, required } from "./lib/cli-utils.mjs";

function help() {
  return {
    name: "testador-gates",
    commands: {
      plan: "testador-gates.mjs plan --scope <SMOKE|STANDARD|FULL> [--has-frontend bool] [--has-api bool] [--separate-origin bool] [--joint-mode bool] [--has-openspec bool] [--has-open-design bool] [--a11y-blocking bool]",
    },
  };
}

function main(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command !== "plan") {
    const error = new Error(`Unknown command: ${command}`);
    error.code = "UNKNOWN_COMMAND";
    throw error;
  }

  const scope = required(args, "scope");
  return {
    result: planGates({
      scope: String(scope).toUpperCase(),
      hasFrontend: boolArg(args["has-frontend"], true),
      hasApi: boolArg(args["has-api"], true),
      separateOrigin: boolArg(args["separate-origin"], false),
      jointMode: boolArg(args["joint-mode"], false),
      hasOpenSpec: boolArg(args["has-openspec"], false),
      hasOpenDesign: boolArg(args["has-open-design"], false),
      a11yBlocking: boolArg(args["a11y-blocking"], false),
    }),
  };
}

executeJsonCli(main);

#!/usr/bin/env node
/**
 * CLI de geracao de specs Playwright.
 * generate-specs.mjs --dir <artefatos_dir> [--base-url <url>]
 */
import { generateSpecs } from "./lib/spec-generator.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return { name: "generate-specs", commands: { generate: "generate-specs.mjs --dir <artefatos_dir> [--base-url <url>]" } };
  }
  const dir = required(args, "dir");
  const baseUrl = args["base-url"] === true ? undefined : (args["base-url"] ?? undefined);
  return { result: generateSpecs({ artefatosDir: dir, baseUrl }) };
}

executeJsonCli(main);

#!/usr/bin/env node

/**
 * CLI da Project_Config do Testador (`/testador project-config`).
 *
 * Camada fina sobre `lib/project-config.mjs`. Subcomandos:
 *
 * - `show [--root .]`          -> `{ config, source, path, exists }`
 * - `write --base-url <url> [--api-base-url <url>] [--start-command <cmd>]
 *          [--ready-timeout-seconds N] [--wcag-tags a,b] [--a11y-blocking bool]
 *          [--viewports WxH,WxH] [--seed-credentials-ref <ref>]
 *          [--server-lifecycle auto|python|node] [--spec-mode hybrid]
 *          [--default-applied campo,campo] [--root .] [--now <iso>]`
 *          -> `{ config, path, changed, previous }`
 * - `validate [--root .]`      -> parse sem gravar
 *
 * O unico caminho que escreve no filesystem e `write`, exclusivamente em
 * `.testador/project-config.md`.
 */

import {
  ProjectConfigError,
  applyProjectConfigDefaults,
  diffProjectConfig,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
} from "./lib/project-config.mjs";
import { executeJsonCli, parseArgs } from "./lib/cli-utils.mjs";

/** Flag de linha de comando que carrega cada campo configuravel. */
const FIELD_FLAGS = Object.freeze({
  baseUrl: "base-url",
  apiBaseUrl: "api-base-url",
  startCommand: "start-command",
  readyTimeoutSeconds: "ready-timeout-seconds",
  wcagTags: "wcag-tags",
  a11yBlocking: "a11y-blocking",
  viewports: "viewports",
  seedCredentialsRef: "seed-credentials-ref",
  serverLifecycle: "server-lifecycle",
  specMode: "spec-mode",
});

function help() {
  return {
    name: "project-config",
    warning: "write is the only mutating command and it only writes .testador/project-config.md.",
    commands: {
      show: "show [--root .]",
      write:
        "write [--base-url <url>] [--api-base-url <url>] [--start-command <cmd>] "
        + "[--ready-timeout-seconds N] [--wcag-tags a,b] [--a11y-blocking bool] "
        + "[--viewports WxH,WxH] [--seed-credentials-ref <ref>] "
        + "[--server-lifecycle auto|python|node] [--spec-mode hybrid] "
        + "[--default-applied field,field] [--root .] [--now <iso-8601>]",
      validate: "validate [--root .]",
    },
    fields: Object.keys(FIELD_FLAGS),
  };
}

function listArg(value) {
  if (value === undefined || value === true) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => String(entry).split(","));
}

function nowArg(value) {
  if (value === undefined || value === true) return new Date();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Expected an ISO 8601 instant for --now, received ${value}`);
    error.code = "INVALID_INSTANT";
    throw error;
  }
  return parsed;
}

function readPreviousConfig(root) {
  try {
    const previous = readProjectConfig(root);
    return { ...previous, error: null };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    return {
      exists: true,
      source: "invalid",
      path: error.details?.path ?? projectConfigPath(root),
      config: null,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
}

function show(root) {
  const { config, source, path, exists } = readProjectConfig(root);
  return { config, source, path, exists };
}

function validate(root) {
  const { config, source, path, exists } = readProjectConfig(root);
  return { valid: true, config, source, path, exists };
}

function write(root, args) {
  const answers = { defaultsApplied: listArg(args["default-applied"]) };
  for (const [field, flag] of Object.entries(FIELD_FLAGS)) {
    if (args[flag] !== undefined && args[flag] !== true) answers[field] = args[flag];
  }

  const now = nowArg(args.now);
  const path = projectConfigPath(root);
  const resolved = applyProjectConfigDefaults(answers, { now, path });

  const previous = readPreviousConfig(root);
  const written = writeProjectConfig(root, resolved, { now });

  return {
    config: written.config,
    path: written.path,
    changed: diffProjectConfig(previous.config, written.config),
    previous: {
      exists: previous.exists,
      source: previous.source,
      config: previous.config,
      error: previous.error,
    },
  };
}

function main(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  const root = args.root === undefined || args.root === true ? process.cwd() : String(args.root);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "show":
      return show(root);
    case "write":
      return write(root, args);
    case "validate":
      return validate(root);
    default: {
      const error = new Error(`Unknown command: ${command}`);
      error.code = "UNKNOWN_COMMAND";
      throw error;
    }
  }
}

executeJsonCli(main);

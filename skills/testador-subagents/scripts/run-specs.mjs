#!/usr/bin/env node
/**
 * CLI de execucao deterministica dos specs gerados.
 * run-specs.mjs --dir <artefatos_dir> [--project-root <root>] [--base-url <url>] [--viewports <WxH,...>] [--wcag-tags <tags>] [--a11y-blocking <bool>] [--grep <pattern>]
 *
 * Roda `@playwright/test` (via node_modules/@playwright/test/cli.js, sem
 * shell e sem depender de `npx` estar no PATH) contra
 * `runner/playwright.config.mjs`, com `TESTADOR_ARTIFACTS_DIR` e
 * `TESTADOR_BASE_URL` no ambiente do processo filho. Nao lanca em caso de
 * falha de teste (`status: "failed"` no exit code do Playwright) -- isso e
 * um resultado valido de run, nao um erro de CLI. So lanca (exit 1) quando
 * a proria execucao nao pode ser tentada (config ausente, specsDir vazio).
 *
 * O parsing do relatorio fica em collect-test-results.mjs; este script
 * apenas executa e devolve exit code + caminho do relatorio.
 */
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeJsonCli, boolArg, parseArgs, required } from "./lib/cli-utils.mjs";
import { readProjectConfig } from "./lib/project-config.mjs";
import { assertArtifactDir } from "./lib/intelligence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class RunSpecsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RunSpecsError";
    this.code = code;
    this.details = details;
  }
}

/**
 * `${CLAUDE_SKILL_DIR}/scripts/run-specs.mjs` -> plugin root e tres niveis
 * acima (`scripts/` -> `testador-subagents/` -> `skills/` -> raiz do
 * plugin). Aceita `CLAUDE_PLUGIN_ROOT` como override explicito quando
 * setado pelo runtime do Claude Code.
 */
export function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return resolve(process.env.CLAUDE_PLUGIN_ROOT);
  return resolve(__dirname, "..", "..", "..");
}

function resolvePlaywrightCli(pluginRoot) {
  const cliPath = join(pluginRoot, "node_modules", "@playwright", "test", "cli.js");
  if (!existsSync(cliPath)) {
    throw new RunSpecsError(
      "PLAYWRIGHT_NOT_INSTALLED",
      `@playwright/test CLI not found at ${cliPath}. Run "npm install" in the plugin root.`,
      { cliPath },
    );
  }
  return cliPath;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return {
      name: "run-specs",
      commands: { run: "run-specs.mjs --dir <artefatos_dir> [--project-root <root>] [--base-url <url>] [--viewports <WxH,...>] [--wcag-tags <tags>] [--a11y-blocking <bool>] [--grep <pattern>]" },
    };
  }
  const dir = required(args, "dir");
  const artefatosDir = resolve(dir);
  const projectRoot = args["project-root"] === true ? process.cwd() : resolve(args["project-root"] ?? process.cwd());
  try { assertArtifactDir(projectRoot, artefatosDir); } catch (error) {
    throw new RunSpecsError(error.code ?? "ARTIFACT_PATH_INVALID", error.message);
  }
  const configured = readProjectConfig(projectRoot).config;
  const baseUrl = args["base-url"] === true ? configured.baseUrl : (args["base-url"] ?? configured.baseUrl);
  const viewports = args.viewports === true ? configured.viewports : (args.viewports ?? configured.viewports);
  const wcagTags = args["wcag-tags"] === true ? configured.wcagTags : (args["wcag-tags"] ?? configured.wcagTags);
  const a11yBlocking = args["a11y-blocking"] === true ? configured.a11yBlocking : boolArg(args["a11y-blocking"], configured.a11yBlocking);
  const grep = args.grep === true ? undefined : (args.grep ?? undefined);
  const updateSnapshots = boolArg(args["update-snapshots"], false);

  const specsDir = join(artefatosDir, "run", "specs");
  if (!existsSync(specsDir)) {
    throw new RunSpecsError("SPECS_DIR_NOT_FOUND", `No specs directory found: ${specsDir}`, { specsDir });
  }
  const specFiles = readdirSync(specsDir).filter((name) => name.endsWith(".spec.mjs"));
  if (specFiles.length === 0) {
    throw new RunSpecsError("NO_SPECS_GENERATED", `No .spec.mjs files found in ${specsDir}. Run generate-specs.mjs first.`, { specsDir });
  }

  const pluginRoot = resolvePluginRoot();
  const configPath = join(pluginRoot, "runner", "playwright.config.mjs");
  if (!existsSync(configPath)) {
    throw new RunSpecsError("CONFIG_NOT_FOUND", `Playwright config not found: ${configPath}`, { configPath });
  }
  const cliPath = resolvePlaywrightCli(pluginRoot);

  const cliArgs = ["test", "--config", configPath];
  if (grep) cliArgs.push("--grep", grep);
  if (updateSnapshots) cliArgs.push("--update-snapshots");

  const env = {
    ...process.env,
    TESTADOR_ARTIFACTS_DIR: artefatosDir,
    ...(baseUrl ? { TESTADOR_BASE_URL: baseUrl } : {}),
    TESTADOR_VIEWPORTS: viewports,
    TESTADOR_WCAG_TAGS: wcagTags,
    TESTADOR_A11Y_BLOCKING: String(a11yBlocking),
  };

  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: pluginRoot,
    env,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw new RunSpecsError("PLAYWRIGHT_SPAWN_FAILED", `Failed to spawn Playwright: ${result.error.message}`, { error: result.error.message });
  }

  const reportDir = join(artefatosDir, "run", "playwright-report");
  const jsonReportPath = join(reportDir, "results.json");

  // Exit code 0/1 do Playwright = execucao completou (com ou sem falhas de teste).
  // Qualquer outro (config invalida, crash) e um erro de CLI de fato.
  const playwrightCompleted = result.status === 0 || result.status === 1;
  if (!playwrightCompleted) {
    throw new RunSpecsError(
      "PLAYWRIGHT_EXECUTION_FAILED",
      `Playwright exited with unexpected status ${result.status}`,
      {
        status: result.status,
        stdout: (result.stdout ?? "").slice(-4000),
        stderr: (result.stderr ?? "").slice(-4000),
      },
    );
  }

  return {
    result: {
      specsDir,
      specFilesCount: specFiles.length,
      exitCode: result.status,
      testsFailed: result.status !== 0,
      jsonReportPath: existsSync(jsonReportPath) ? jsonReportPath : null,
      reportDir,
    },
  };
}

executeJsonCli(main);

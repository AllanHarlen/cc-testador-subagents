/**
 * Configuracao Playwright para o runner do cc-testador-subagents.
 *
 * Specs sao gerados dinamicamente em {artefatos_dir}/run/specs/ e nunca
 * vivem no repo-alvo. A variavel de ambiente TESTADOR_ARTIFACTS_DIR aponta
 * para o artefatos_dir da run corrente.
 *
 * Reporters: JSON (para collect-test-results.mjs) + JUnit (compatibilidade)
 * + HTML (never open -- debug offline).
 */

import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const artifactsDir = process.env.TESTADOR_ARTIFACTS_DIR;
if (!artifactsDir) {
  throw new Error("TESTADOR_ARTIFACTS_DIR env var must be set before running playwright tests");
}

const specsDir = join(artifactsDir, "run", "specs");
const reportDir = join(artifactsDir, "run", "playwright-report");
const baseURL = process.env.TESTADOR_BASE_URL ?? "http://localhost:3000";
const configuredViewports = (process.env.TESTADOR_VIEWPORTS ?? "390x844,1440x900,375x812")
  .split(",").map((entry) => entry.trim().match(/^(\d+)x(\d+)$/i)).filter(Boolean)
  .map(([, width, height]) => ({ width: Number(width), height: Number(height) }));
const viewports = configuredViewports.length > 0 ? configuredViewports : [{ width: 390, height: 844 }, { width: 1440, height: 900 }];
const projects = viewports.map((viewport, index) => ({
  name: `chromium-${viewport.width < 700 ? "mobile" : "desktop"}-${index + 1}`,
  use: { ...(viewport.width < 700 ? devices["iPhone 12"] : {}), browserName: "chromium", viewport },
}));

export default defineConfig({
  testDir: specsDir,
  outputDir: join(reportDir, "test-results"),
  reporter: [
    ["json", { outputFile: join(reportDir, "results.json") }],
    ["junit", { outputFile: join(reportDir, "results.xml") }],
    ["html", { outputFolder: join(reportDir, "html"), open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects,
  // Sem retries em batch de validacao -- achado e achado.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: true,
});

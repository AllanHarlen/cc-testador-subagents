import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeProjectConfig } from "../../skills/testador-subagents/scripts/lib/project-config.mjs";
import { generateSpecs } from "../../skills/testador-subagents/scripts/lib/spec-generator.mjs";
import { collectAxeResults } from "../../skills/testador-subagents/scripts/lib/axe-report.mjs";
import { collectPlaywrightResults } from "../../skills/testador-subagents/scripts/lib/playwright-report.mjs";

const pluginRoot = fileURLToPath(new URL("../..", import.meta.url));

test("generated flow runs in Chromium, persists Axe, and emits Playwright findings", async () => {
  const root = mkdtempSync(join(tmpdir(), "testador-integration-"));
  const artifacts = join(root, ".testador", "run-1", "artefatos");
  mkdirSync(join(artifacts, "plan"), { recursive: true });
  const server = createServer((request, response) => {
    const body = "<!doctype html><html><body><main><h1>Dashboard</h1><button>Refresh</button></main></body></html>";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.setHeader("connection", "close");
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    writeProjectConfig(root, {
      baseUrl,
      apiBaseUrl: "",
      startCommand: "",
      readyTimeoutSeconds: 30,
      wcagTags: "wcag2a,wcag2aa",
      a11yBlocking: false,
      viewports: "390x844",
      seedCredentialsRef: "",
      serverLifecycle: "node",
      specMode: "hybrid",
    }, { now: "2026-09-03T00:00:00Z" });
    generateSpecs({
      artefatosDir: artifacts,
      baseUrl,
      flowMap: { flows: [{ name: "dashboard", route: "/", steps: [{ action: "navigate", path: "/" }, { action: "assert_visible", selector: "h1" }] }] },
      fixtureImportUrl: new URL("../../runner/fixtures/flow-fixture.mjs", import.meta.url).href,
    });
    const script = join(pluginRoot, "skills", "testador-subagents", "scripts", "run-specs.mjs");
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "--dir", artifacts, "--project-root", root], {
        cwd: pluginRoot,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const axe = collectAxeResults(artifacts);
    assert.equal(axe.summary.scanExecuted, true, `${run.stdout}\n${run.stderr}\n${readFileSync(join(artifacts, "run", "playwright-report", "results.json"), "utf8")}`);
    assert.ok(JSON.parse(readFileSync(join(artifacts, "run", "axe-results.json"), "utf8")).length >= 1);
    const results = collectPlaywrightResults(artifacts);
    assert.equal(results.summary.failed, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

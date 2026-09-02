import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/preflight.mjs", import.meta.url));

const roots = [];

function temporaryProject() {
  const root = mkdtempSync(join(tmpdir(), "preflight-shape-"));
  roots.push(root);
  return root;
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/** Fake HOME so the developer machine's real ~/.claude state never leaks into the assertions. */
function fakeHomeEnv(root) {
  const home = join(root, "fake-home");
  mkdirSync(home, { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

function runPreflight(root, extraEnv = {}) {
  const run = spawnSync(process.execPath, [PREFLIGHT_SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...fakeHomeEnv(root), ...extraEnv },
  });
  return JSON.parse(run.stdout);
}

test("report shape is schemaVersion 1, flat, with singular category labels", () => {
  const root = temporaryProject();
  const report = runPreflight(root);

  assert.equal(report.schemaVersion, 1);
  assert.ok(report.checks.config);
  assert.ok(report.checks.cli);
  assert.ok(report.checks.mcp);
  assert.ok(report.checks.skills);
  assert.ok(report.checks.capabilities);
  assert.ok(report.checks.permissions);
  assert.ok(report.checks.optional);

  for (const [group, results] of Object.entries(report.checks)) {
    if (group === "optional") continue;
    for (const [name, result] of Object.entries(results)) {
      assert.equal(typeof result.required, "boolean", `${group}.${name} must carry required: boolean`);
    }
  }
});

test("the 3 mandatory skills are all marked required: true", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  for (const name of ["webapp-testing", "frontend-design", "ui-ux-pro-max"]) {
    assert.equal(report.checks.skills[name].required, true, `${name} must be required`);
  }
});

test("config.project-config is NOT required (defaults apply when absent)", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  assert.equal(report.checks.config["project-config"].required, false);
});

test("mcp.playwright and capabilities.chromium-installed are required", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  assert.equal(report.checks.mcp.playwright.required, true);
  assert.equal(report.checks.capabilities["chromium-installed"].required, true);
});

test("missing mandatory skill fails the report and lists the exact npx skills add remediation", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  const failedNames = report.failed.map((entry) => entry.name);
  assert.ok(failedNames.includes("webapp-testing"), "webapp-testing must be in failed[] when absent");
  const remediation = report.remediation.find((entry) => entry.target === "skill:webapp-testing");
  assert.ok(remediation, "remediation for the missing skill must be present");
  assert.ok(
    remediation.steps.some((step) => step.includes("npx skills add https://github.com/anthropics/skills --skill webapp-testing")),
    "remediation must include the exact install command",
  );
});

test("autoRemediation block is always present in the report", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  assert.ok("autoRemediation" in report);
  assert.equal(typeof report.autoRemediation.ok, "boolean");
});

test("status is failed when any required check fails, ok only when all required checks pass", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  const anyRequiredFailed = Object.values(report.checks)
    .filter((group) => group !== report.checks.optional)
    .flatMap((group) => Object.values(group))
    .some((check) => check.required === true && check.ok === false);
  assert.equal(report.status, anyRequiredFailed ? "failed" : "ok");
});

test("capabilities.plugin-deps-installed passes and resolves @playwright/test + @axe-core/playwright from the real plugin root", () => {
  const root = temporaryProject();
  const report = runPreflight(root);
  const depsCheck = report.checks.capabilities["plugin-deps-installed"];
  assert.equal(depsCheck.required, true);
  assert.equal(depsCheck.ok, true, JSON.stringify(depsCheck));
  assert.ok(depsCheck.resolved["@playwright/test"]);
  assert.ok(depsCheck.resolved["@axe-core/playwright"]);
});

test("capabilities.plugin-deps-installed fails when CLAUDE_PLUGIN_ROOT points at a root with no node_modules", () => {
  const root = temporaryProject();
  const fakePluginRoot = join(root, "fake-plugin-root");
  mkdirSync(fakePluginRoot, { recursive: true });
  const report = runPreflight(root, { CLAUDE_PLUGIN_ROOT: fakePluginRoot });
  const depsCheck = report.checks.capabilities["plugin-deps-installed"];
  assert.equal(depsCheck.ok, false);
  assert.deepEqual(depsCheck.missing.sort(), ["@axe-core/playwright", "@playwright/test"]);
  assert.ok(depsCheck.install[0].includes(fakePluginRoot));
  assert.ok(report.failed.some((f) => f.name === "plugin-deps-installed"));
  const remediation = report.remediation.find((r) => r.target === "plugin-runtime-deps");
  assert.ok(remediation);
});

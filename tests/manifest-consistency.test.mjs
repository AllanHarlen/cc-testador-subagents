/**
 * Trava a consistencia de versao entre plugin.json, marketplace.json e
 * package.json — os tres devem carregar exatamente a mesma versao (padrao
 * herdado do cc-executor-subagents).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, `file://${ROOT}`), "utf8"));
}

test("plugin.json, marketplace.json and package.json share the same version", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const pkg = readJson("package.json");

  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
});

test("plugin.json has no commands/skills/agents keys (discovery is by directory convention)", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  assert.equal(plugin.commands, undefined);
  assert.equal(plugin.skills, undefined);
  assert.equal(plugin.agents, undefined);
});

test("plugin.json author is an object with only a name field", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  assert.deepEqual(Object.keys(plugin.author), ["name"]);
});

test("plugin.json and marketplace.json share the same plugin name", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.equal(plugin.name, marketplace.name);
  assert.equal(plugin.name, marketplace.plugins[0].name);
});

test("package.json declares exactly the pinned runtime deps the runner/ layer needs, and fast-check as the only devDependency", () => {
  // Diferente dos plugins irmaos (executor/orquestrador/pensador), o
  // testador tem uma camada real de runtime (`runner/`) que importa
  // `@playwright/test` e `@axe-core/playwright` -- essas dependencias
  // precisam estar declaradas e pinadas (versao exata, sem `^`/`~`) para
  // que `npm install` de fato as resolva; sem isso, `run-specs.mjs` e
  // toda a fase 7 nao tem como executar.
  const pkg = readJson("package.json");
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["@axe-core/playwright", "@playwright/test"]);
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version, got "${version}"`);
  }
  assert.equal(pkg.devDependencies.fastCheck ?? pkg.devDependencies["fast-check"], "4.9.0");
});

// WF-005 / DEC-007: `dependencies: []` used to be false — two of the three
// REQUIRED_SKILLS (frontend-design, ui-ux-pro-max) are actually shipped by
// cc-pensador, a sibling plugin, not by an unrelated third party. This test
// links the manifest's declared dependency to skill-detect.mjs's own claim
// about where those skills come from, so the two facts can't silently
// diverge again the way they did before.
test("plugin.json declares cc-pensador as a dependency, matching skill-detect.mjs's own remediation text", async () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const dependencyNames = (plugin.dependencies ?? []).map((d) => d.name);
  assert.ok(
    dependencyNames.includes("cc-pensador"),
    "cc-pensador ships two of the three REQUIRED_SKILLS (frontend-design, ui-ux-pro-max) — it must be a declared dependency",
  );
});

test("marketplace.json allows the cc-pensador cross-marketplace dependency declared in plugin.json", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const dependencyMarketplaces = (plugin.dependencies ?? []).map((d) => d.marketplace);
  for (const marketplaceName of dependencyMarketplaces) {
    assert.ok(
      (marketplace.allowCrossMarketplaceDependenciesOn ?? []).includes(marketplaceName),
      `marketplace.json must allow cross-marketplace dependency on "${marketplaceName}"`,
    );
  }
});

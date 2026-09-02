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

test("package.json declares zero runtime dependencies (only devDependencies)", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies.fastCheck ?? pkg.devDependencies["fast-check"], "4.9.0");
});

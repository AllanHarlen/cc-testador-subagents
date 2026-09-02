/**
 * Contrato do CLI `project-config.mjs`: `show`, `write`, `validate`. `write`
 * e o unico comando que muta o filesystem, e so escreve
 * `.testador/project-config.md`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/project-config.mjs", import.meta.url));

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-config-cli-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function run(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", windowsHide: true });
  let json;
  try {
    json = JSON.parse(result.stdout || result.stderr);
  } catch {
    json = undefined;
  }
  return { status: result.status, json };
}

test("show returns the default config with source=default when no file exists", () => {
  const root = fixture();
  const { json } = run(["show", "--root", root], root);
  assert.equal(json.ok, true);
  assert.equal(json.source, "default");
  assert.equal(json.exists, false);
});

test("write creates .testador/project-config.md and show then reads it back with source=file", () => {
  const root = fixture();
  const { json: writeJson } = run(["write", "--root", root, "--base-url", "http://localhost:9999"], root);
  assert.equal(writeJson.ok, true);
  assert.equal(writeJson.config.baseUrl, "http://localhost:9999");
  assert.ok(existsSync(join(root, ".testador", "project-config.md")));

  const { json: showJson } = run(["show", "--root", root], root);
  assert.equal(showJson.source, "file");
  assert.equal(showJson.config.baseUrl, "http://localhost:9999");
});

test("write never touches any file outside .testador/", () => {
  const root = fixture();
  run(["write", "--root", root, "--base-url", "http://localhost:1234"], root);
  const entries = readdirSync(root);
  assert.deepEqual(entries, [".testador"]);
});

test("write reports defaultsApplied for fields not explicitly provided", () => {
  const root = fixture();
  const { json } = run(["write", "--root", root, "--base-url", "http://localhost:1234"], root);
  assert.ok(json.config.defaultsApplied.length > 0);
  assert.ok(json.config.defaultsApplied.includes("serverLifecycle"));
});

test("validate on an invalid file surfaces the parser error with exit 1", () => {
  const root = fixture();
  run(["write", "--root", root, "--base-url", "http://localhost:1234"], root);
  const path = join(root, ".testador", "project-config.md");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("**serverLifecycle**: auto", "**serverLifecycle**: golang"));

  const { status, json } = run(["validate", "--root", root], root);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "PROJECT_CONFIG_INVALID_VALUE");
  assert.equal(status, 1);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/preflight.mjs", import.meta.url));

const roots = [];

function temporaryProject() {
  const root = mkdtempSync(join(tmpdir(), "preflight-autoremediation-"));
  roots.push(root);
  return root;
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function fakeHomeEnv(root) {
  const home = join(root, "fake-home");
  mkdirSync(home, { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

function runPreflight(root, extraEnv = {}) {
  const run = spawnSync(process.execPath, [PREFLIGHT_SCRIPT, "--fix-permissions"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...fakeHomeEnv(root), ...extraEnv },
  });
  return { status: run.status, json: JSON.parse(run.stdout) };
}

test("auto-remediation creates .claude/settings.json with both node and npx rules when missing", () => {
  const root = temporaryProject();
  const { json } = runPreflight(root);

  assert.equal(json.autoRemediation.attempted, true);
  assert.equal(json.autoRemediation.changed, true);
  assert.equal(json.autoRemediation.action, "created-settings-json");
  assert.equal(json.autoRemediation.ok, true);
  assert.equal(json.checks.permissions["bash-node-npx"].ok, true);

  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(node:*)"));
  assert.ok(settings.permissions.allow.includes("Bash(npx:*)"));
});

test("auto-remediation preserves an existing settings.json and appends only the missing rule", () => {
  const root = temporaryProject();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(node:*)"], deny: ["Bash(rm -rf /)"] } }, null, 2),
    "utf8",
  );

  const { json } = runPreflight(root);
  assert.equal(json.autoRemediation.action, "updated-settings-json");
  assert.equal(json.autoRemediation.ok, true);

  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(node:*)", "Bash(npx:*)"]);
  assert.deepEqual(settings.permissions.deny, ["Bash(rm -rf /)"]);
});

test("auto-remediation refuses to touch invalid JSON and leaves the file untouched", () => {
  const root = temporaryProject();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const broken = "{ not valid json";
  writeFileSync(join(root, ".claude", "settings.json"), broken, "utf8");

  const { json } = runPreflight(root);
  assert.equal(json.autoRemediation.attempted, true);
  assert.equal(json.autoRemediation.changed, false);
  assert.equal(json.autoRemediation.action, "blocked-invalid-json");
  assert.equal(json.autoRemediation.ok, false);
  assert.equal(readFileSync(join(root, ".claude", "settings.json"), "utf8"), broken);
});

test("auto-remediation refuses a non-object root", () => {
  const root = temporaryProject();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), "[]", "utf8");

  const { json } = runPreflight(root);
  assert.equal(json.autoRemediation.action, "blocked-non-object-root");
  assert.equal(json.autoRemediation.ok, false);
});

test("auto-remediation refuses a non-array permissions.allow", () => {
  const root = temporaryProject();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: "not-an-array" } }), "utf8");

  const { json } = runPreflight(root);
  assert.equal(json.autoRemediation.action, "blocked-invalid-allow-shape");
  assert.equal(json.autoRemediation.ok, false);
});

test("auto-remediation is a no-op when both rules already exist", () => {
  const root = temporaryProject();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const original = JSON.stringify({ permissions: { allow: ["Bash(node:*)", "Bash(npx:*)"] } }, null, 2);
  writeFileSync(join(root, ".claude", "settings.json"), original, "utf8");

  const { json } = runPreflight(root);
  assert.equal(json.autoRemediation.attempted, false);
  assert.equal(json.autoRemediation.changed, false);
  assert.equal(json.autoRemediation.action, "none");
  assert.equal(readFileSync(join(root, ".claude", "settings.json"), "utf8"), original);
});

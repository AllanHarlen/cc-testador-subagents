/**
 * CLI de testador-state.mjs, a nivel de processo: guarda de --phase/--api-calls
 * numerico contra flag sem valor (bug de `Number(true) === 1`), leitura
 * estruturada de --validations-file, e o novo comando gates-apply.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/testador-state.mjs", import.meta.url));

const roots = [];
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-testador-state-cli-test-"));
  roots.push(root);
  return { root, artifactDir: join(root, ".testador", "demo", "artefatos") };
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
  let json;
  try { json = JSON.parse(result.stdout || result.stderr); } catch { json = undefined; }
  return { status: result.status, json };
}

test("init with --phase passed as a bare flag (no value) fails as INVALID_NUMBER, not silently 1", () => {
  const { artifactDir } = fixture();
  const { status, json } = run(["init", "--dir", artifactDir, "--phase"]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "INVALID_NUMBER");
  assert.equal(status, 1);
});

test("heartbeat with --api-calls passed as a bare flag fails as INVALID_NUMBER, not silently 1", () => {
  const { artifactDir } = fixture();
  run(["init", "--dir", artifactDir]);
  const { status, json } = run(["heartbeat", "--dir", artifactDir, "--task", "t1", "--api-calls"]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "INVALID_NUMBER");
  assert.equal(status, 1);
});

test("task update with a malformed --validations-file fails as a structured INVALID_VALIDATIONS_FILE, not a raw SyntaxError", () => {
  const { root, artifactDir } = fixture();
  run(["init", "--dir", artifactDir]);
  run(["task", "register", "--dir", artifactDir, "--task", "t1"]);
  const badFile = join(root, "bad-validations.json");
  writeFileSync(badFile, "{ not valid json", "utf8");
  const { status, json } = run(["task", "--dir", artifactDir, "--task", "t1", "--status", "RUNNING", "--validations-file", badFile]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "INVALID_VALIDATIONS_FILE");
  assert.equal(status, 1);
});

test("task update with a missing --validations-file fails as INVALID_VALIDATIONS_FILE, not a raw ENOENT", () => {
  const { root, artifactDir } = fixture();
  run(["init", "--dir", artifactDir]);
  run(["task", "register", "--dir", artifactDir, "--task", "t1"]);
  const { status, json } = run(["task", "--dir", artifactDir, "--task", "t1", "--status", "RUNNING", "--validations-file", join(root, "does-not-exist.json")]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "INVALID_VALIDATIONS_FILE");
  assert.equal(status, 1);
});

test("gates-apply applies a testador-gates.mjs plan to an already-initialized run", () => {
  const { root, artifactDir } = fixture();
  run(["init", "--dir", artifactDir]);

  const GATES_SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/testador-gates.mjs", import.meta.url));
  const planResult = spawnSync(process.execPath, [GATES_SCRIPT, "plan", "--scope", "STANDARD", "--has-frontend", "true"], { encoding: "utf8" });
  const plan = JSON.parse(planResult.stdout).result;
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan), "utf8");

  const { status, json } = run(["gates-apply", "--dir", artifactDir, "--gates-plan", planPath]);
  assert.equal(status, 0, JSON.stringify(json));
  assert.equal(json?.ok, true);
  assert.equal(json?.gates?.deterministic?.required, true);
  assert.equal(json?.gates?.a11y?.required, true);
  assert.equal(json?.gates?.uiux?.required, true);
  assert.equal(json?.gates?.["spec-coverage"]?.required, false);
});

test("discover-target --root=<path> is honored (not silently ignored like the old positional-only parsing)", () => {
  const DISCOVER_SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/discover-target.mjs", import.meta.url));
  const { root } = fixture();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 4321" } }), "utf8");

  const withRootEquals = spawnSync(process.execPath, [DISCOVER_SCRIPT, `--root=${root}`], { encoding: "utf8" });
  const jsonEquals = JSON.parse(withRootEquals.stdout);
  assert.equal(jsonEquals.ok, true);
  assert.equal(jsonEquals.result.summary.baseUrl, "http://localhost:4321", "--root=<path> form must be honored, not ignored in favor of cwd");

  const withRootSpace = spawnSync(process.execPath, [DISCOVER_SCRIPT, "--root", root], { encoding: "utf8" });
  const jsonSpace = JSON.parse(withRootSpace.stdout);
  assert.equal(jsonSpace.result.summary.baseUrl, "http://localhost:4321", "--root <path> form must also be honored");
});

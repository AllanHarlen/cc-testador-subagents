/**
 * Guarda de seguranca do flow-map.json:
 * - Credencial como valor literal -> rejeitado
 * - Credencial como process.env.X -> aceito
 * - Schema valido vs invalido
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { generateSpecs, SpecGeneratorError } from "../skills/testador-subagents/scripts/lib/spec-generator.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flow-map-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeDir(root) {
  const dir = join(root, ".testador", "demo", "artefatos");
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "run", "specs"), { recursive: true });
  return dir;
}

function writeFlowMap(dir, flows) {
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify({
    schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", flows,
  }), "utf8");
}

test("flow with credential as literal password is rejected with CREDENTIAL_VALUE_IN_FLOW_MAP", () => {
  const root = fixture();
  const dir = makeDir(root);
  writeFlowMap(dir, [{
    name: "Login",
    route: "/login",
    steps: [{ action: "fill", selector: "#pwd", input: { password: "MyRealPassword123" } }],
  }]);
  assert.throws(
    () => generateSpecs({ artefatosDir: dir }),
    (e) => e instanceof SpecGeneratorError && e.code === "CREDENTIAL_VALUE_IN_FLOW_MAP",
  );
});

test("flow with credential as process.env reference is accepted", () => {
  const root = fixture();
  const dir = makeDir(root);
  writeFlowMap(dir, [{
    name: "Login",
    route: "/login",
    steps: [{ action: "fill", selector: "#pwd", input: { password: "process.env.TEST_PASSWORD" } }],
  }]);
  const { generated } = generateSpecs({ artefatosDir: dir });
  assert.equal(generated.length, 1);
});

test("flow with non-credential field and any value is accepted", () => {
  const root = fixture();
  const dir = makeDir(root);
  writeFlowMap(dir, [{
    name: "Search",
    route: "/search",
    steps: [{ action: "fill", selector: "#q", input: { query: "some search term" } }],
  }]);
  const { generated } = generateSpecs({ artefatosDir: dir });
  assert.equal(generated.length, 1);
});

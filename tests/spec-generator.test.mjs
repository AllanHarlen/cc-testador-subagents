/**
 * Gerador deterministico de specs Playwright: mesma entrada -> mesmos bytes.
 * Guarda contra credencial vazando em spec gerado.
 * Repo-alvo nao e tocado.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { generateSpecs, SpecGeneratorError } from "../skills/testador-subagents/scripts/lib/spec-generator.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-gen-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeArtefatosDir(root) {
  const dir = join(root, ".testador", "demo", "artefatos");
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "run", "specs"), { recursive: true });
  return dir;
}

const SAMPLE_FLOW_MAP = {
  schemaVersion: 1,
  generatedAt: "2026-09-01T00:00:00Z",
  baseUrl: "http://localhost:3000",
  flows: [
    {
      name: "Login flow",
      route: "/login",
      steps: [
        { action: "navigate", path: "/login" },
        { action: "fill", selector: "input[name=email]", input: { email: "user@example.com" } },
        { action: "fill", selector: "input[name=password]", input: { password: "process.env.TEST_PASSWORD" } },
        { action: "click", selector: "button[type=submit]" },
        { action: "assert_url", pattern: "/dashboard" },
      ],
    },
  ],
};

test("generateSpecs creates a .spec.mjs file for each flow in the flow-map", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(SAMPLE_FLOW_MAP), "utf8");

  const { generated, specsDir } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  assert.equal(generated.length, 1);
  assert.ok(generated[0].endsWith("login-flow.spec.mjs"));
});

test("generated spec content is deterministic (same input -> same bytes)", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(SAMPLE_FLOW_MAP), "utf8");

  const { generated: g1 } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  const { generated: g2 } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  const c1 = readFileSync(g1[0], "utf8");
  const c2 = readFileSync(g2[0], "utf8");
  assert.equal(c1, c2, "repeated generation must produce byte-identical output");
});

test("credential in process.env.X form is allowed and emitted as template literal", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(SAMPLE_FLOW_MAP), "utf8");

  const { generated } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  const content = readFileSync(generated[0], "utf8");
  assert.ok(content.includes("process.env.TEST_PASSWORD"), "env var reference must appear in spec");
  assert.ok(!content.includes("supersecretpassword"), "literal password must not appear");
});

test("CREDENTIAL_VALUE_IN_FLOW_MAP: rejects a flow-map with a literal password value", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  const dangerousFlowMap = {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00Z",
    flows: [{
      name: "Login",
      route: "/login",
      steps: [{ action: "fill", selector: "input[name=password]", input: { password: "superSecretLiteral" } }],
    }],
  };
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(dangerousFlowMap), "utf8");

  assert.throws(
    () => generateSpecs({ artefatosDir: dir }),
    (error) => error instanceof SpecGeneratorError && error.code === "CREDENTIAL_VALUE_IN_FLOW_MAP",
  );
});

test("FLOW_MAP_NOT_FOUND: throws when flow-map.json does not exist", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  assert.throws(
    () => generateSpecs({ artefatosDir: dir }),
    (error) => error instanceof SpecGeneratorError && error.code === "FLOW_MAP_NOT_FOUND",
  );
});

test("specs are written inside artefatosDir/run/specs, not in the project root", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(SAMPLE_FLOW_MAP), "utf8");

  const { generated } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  for (const p of generated) {
    assert.ok(p.startsWith(dir), `spec ${p} must be inside artefatosDir`);
    assert.ok(!p.includes("node_modules"), "spec must not go into node_modules");
  }
});

test("spec title includes the origin requirement when coverage-matrix entry is available", () => {
  const root = fixture();
  const dir = makeArtefatosDir(root);
  writeFileSync(join(dir, "plan", "flow-map.json"), JSON.stringify(SAMPLE_FLOW_MAP), "utf8");
  const matrix = {
    entries: [{ id: "RF-01-flow", flow: "Login flow", origin: { ref: "RF-01", scenario: "Login redirect" }, status: "UNCOVERED", automatable: "AUTOMATABLE", coveredBy: null }],
  };
  writeFileSync(join(dir, "plan", "coverage-matrix.json"), JSON.stringify(matrix), "utf8");

  const { generated } = generateSpecs({ artefatosDir: dir, baseUrl: "http://localhost:3000" });
  const content = readFileSync(generated[0], "utf8");
  assert.ok(content.includes("RF-01") || content.includes("Login redirect"), "spec comment must reference the origin requirement");
});

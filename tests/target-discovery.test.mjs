/**
 * Descoberta de alvo: package.json (dev/start + porta), docker-compose
 * (servicos + portas -> separateOrigin), .env* (SO nomes de chave). O caso
 * critico de seguranca: valor de credencial nunca aparece na saida, so o
 * nome da chave.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverTarget } from "../skills/testador-subagents/scripts/lib/target-discovery.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "target-discovery-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("detects a Vite dev server via explicit --port flag with high confidence", () => {
  const root = fixture();
  writeFile(root, "package.json", JSON.stringify({ scripts: { dev: "vite --port 5174" } }));

  const result = discoverTarget(root);
  assert.equal(result.summary.baseUrl, "http://localhost:5174");
  assert.equal(result.summary.confidence, "high");
  assert.equal(result.summary.startCommand, "npm run dev");
});

test("falls back to the framework's conventional port when no explicit flag is present", () => {
  const root = fixture();
  writeFile(root, "package.json", JSON.stringify({ scripts: { dev: "next dev" } }));

  const result = discoverTarget(root);
  assert.equal(result.summary.baseUrl, "http://localhost:3000");
  assert.equal(result.summary.confidence, "medium");
});

test("detects docker-compose services and derives separateOrigin from named services", () => {
  const root = fixture();
  writeFile(
    root,
    "docker-compose.yml",
    [
      "services:",
      "  web:",
      "    build: ./frontend",
      "    ports:",
      '      - "5173:5173"',
      "  api:",
      "    build: ./backend",
      "    ports:",
      '      - "3000:3000"',
      "",
    ].join("\n"),
  );

  const result = discoverTarget(root);
  assert.equal(result.summary.baseUrl, "http://localhost:5173");
  assert.equal(result.summary.apiBaseUrl, "http://localhost:3000");
  assert.equal(result.summary.separateOrigin, true);
  assert.equal(result.summary.startCommand, "docker compose up --build");
});

test("single-service compose does not set separateOrigin", () => {
  const root = fixture();
  writeFile(
    root,
    "docker-compose.yml",
    ["services:", "  app:", "    ports:", '      - "8080:8080"', ""].join("\n"),
  );

  const result = discoverTarget(root);
  assert.equal(result.summary.separateOrigin, false);
  assert.equal(result.summary.apiBaseUrl, null);
});

test("collects only .env key NAMES, never values — the security-critical guarantee", () => {
  const root = fixture();
  writeFile(root, ".env", "DATABASE_URL=postgres://user:supersecret@localhost/db\nAPI_KEY=sk-abc123very-secret\n");
  writeFile(root, ".env.test", "SEED_ADMIN_PASSWORD=CorrectHorseBatteryStaple\n");

  const result = discoverTarget(root);
  assert.deepEqual(result.summary.credentialKeys, ["API_KEY", "DATABASE_URL", "SEED_ADMIN_PASSWORD"]);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("supersecret"), "credential VALUE must never leak into the output");
  assert.ok(!serialized.includes("sk-abc123very-secret"), "credential VALUE must never leak into the output");
  assert.ok(!serialized.includes("CorrectHorseBatteryStaple"), "credential VALUE must never leak into the output");
});

test("collects route hints from a known front-end router file", () => {
  const root = fixture();
  writeFile(
    root,
    "src/App.tsx",
    'const routes = [{ path: "/login" }, { path: "/dashboard" }];\nexport default routes;\n',
  );

  const result = discoverTarget(root);
  assert.deepEqual(result.summary.routes, ["/dashboard", "/login"]);
});

test("returns a low-confidence default baseUrl when nothing is detected", () => {
  const root = fixture();
  const result = discoverTarget(root);
  assert.equal(result.summary.confidence, "low");
  assert.ok(result.summary.baseUrl.startsWith("http://localhost:"));
});

test("emits a well-formed intelligence envelope", () => {
  const root = fixture();
  const result = discoverTarget(root);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, "discover-target");
  assert.ok(result.evidenceId.startsWith("intel-discover-target-"));
  assert.ok(result.generatedAt);
});

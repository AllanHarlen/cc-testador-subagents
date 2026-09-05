/**
 * Contrato de exit code do CLI `ingest-upstream.mjs` (N-16): um chamador
 * encadeando `&&` precisa distinguir ingest conjunto limpo (0), ambiguidade
 * de slug (3) e degradacao para standalone por handoff invalido/corrompido
 * (4) — os tres saiam 0 identicamente antes desta correcao.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/ingest-upstream.mjs", import.meta.url));

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ingest-upstream-cli-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeHandoff(root, relativePath, handoff) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof handoff === "string" ? handoff : JSON.stringify(handoff, null, 2), "utf8");
}

function baseHandoff(slug) {
  return {
    handoffVersion: 1,
    stage: "orchestrador",
    slug,
    producer: { plugin: "cc-orchestrador-subagents", version: "1.0.0" },
    artifactRoot: `.orchestration/${slug}`,
    status: "DONE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    summary: "orchestrador done",
    upstream: null,
    artifacts: [],
    nextStage: null,
  };
}

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

test("exits 0 for a clean joint ingest", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", baseHandoff("login-social"));
  const { status, json } = run(["--root", root], root);
  assert.equal(status, 0);
  assert.equal(json.result.mode, "joint");
});

test("exits 3 for an ambiguous multi-slug result", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", baseHandoff("login-social"));
  writeHandoff(root, ".orchestration/checkout/report/handoff.json", baseHandoff("checkout"));
  const { status, json } = run(["--root", root], root);
  assert.equal(status, 3);
  assert.equal(json.result.mode, "ambiguous");
});

test("exits 4 when degraded to standalone because the upstream handoff was invalid", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", "{ not valid json");
  const { status, json } = run(["--root", root, "--slug", "login-social"], root);
  assert.equal(status, 4);
  assert.equal(json.result.mode, "standalone");
});

test("exits 0 for a genuinely standalone result (no .orchestration/ at all)", () => {
  const root = fixture();
  const { status, json } = run(["--root", root], root);
  assert.equal(status, 0);
  assert.equal(json.result.mode, "standalone");
  assert.equal(json.result.invalidHandoff, undefined);
});

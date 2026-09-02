/**
 * Catalogo de gates do Testador: cada gate so aparece na condicao certa,
 * escopo invalido falha fechado, command[0] === "node" sempre em script gates.
 * Espelha o padrao de cc-executor-subagents/tests/gates-plan.test.mjs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GatesError, VALID_SCOPES, planGates } from "../skills/testador-subagents/scripts/lib/gates.mjs";

const SCRIPT = fileURLToPath(new URL("../skills/testador-subagents/scripts/testador-gates.mjs", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
  let json;
  try { json = JSON.parse(result.stdout || result.stderr); } catch { json = undefined; }
  return { status: result.status, json };
}

test("planGates throws INVALID_SCOPE for an unknown scope value", () => {
  assert.throws(
    () => planGates({ scope: "MAXIMUM" }),
    (error) => error instanceof GatesError && error.code === "INVALID_SCOPE",
  );
});

test("planGates throws INVALID_SCOPE when scope is missing (undefined)", () => {
  assert.throws(
    () => planGates({ scope: undefined }),
    (error) => error instanceof GatesError && error.code === "INVALID_SCOPE",
  );
});

test("SMOKE scope: only stack-up and mcp-smoke action gates, plus handoff-validate", () => {
  const { gates } = planGates({ scope: "SMOKE", hasFrontend: true });
  const ids = gates.map((g) => g.id);
  assert.ok(ids.includes("stack-up"));
  assert.ok(ids.includes("mcp-smoke"));
  assert.ok(ids.includes("handoff-validate"));
  assert.ok(!ids.includes("run-specs"), "run-specs must be skipped in SMOKE");
  assert.ok(!ids.includes("a11y-scan"), "a11y-scan must be skipped in SMOKE");
});

test("STANDARD scope with frontend: includes run-specs, a11y-scan and uiux-review", () => {
  const { gates } = planGates({ scope: "STANDARD", hasFrontend: true });
  const ids = gates.map((g) => g.id);
  assert.ok(ids.includes("run-specs"));
  assert.ok(ids.includes("a11y-scan"));
  assert.ok(ids.includes("uiux-review"));
});

test("design-conformance only appears when hasFrontend AND hasOpenDesign", () => {
  const withBoth = planGates({ scope: "STANDARD", hasFrontend: true, hasOpenDesign: true });
  assert.ok(withBoth.gates.some((g) => g.id === "design-conformance"));

  const noDesign = planGates({ scope: "STANDARD", hasFrontend: true, hasOpenDesign: false });
  assert.ok(!noDesign.gates.some((g) => g.id === "design-conformance"));

  const noFrontend = planGates({ scope: "STANDARD", hasFrontend: false, hasOpenDesign: true });
  assert.ok(!noFrontend.gates.some((g) => g.id === "design-conformance"));
});

test("a11y-scan is skipped when hasFrontend is false", () => {
  const result = planGates({ scope: "STANDARD", hasFrontend: false });
  assert.ok(!result.gates.some((g) => g.id === "a11y-scan"));
  assert.ok(result.skipped.some((s) => s.id === "a11y-scan"));
});

test("coverage-check appears only when hasOpenSpec or jointMode is true", () => {
  const withOpenSpec = planGates({ scope: "FULL", hasFrontend: true, hasOpenSpec: true });
  assert.ok(withOpenSpec.gates.some((g) => g.id === "coverage-check"));

  const withJoint = planGates({ scope: "FULL", hasFrontend: true, jointMode: true });
  assert.ok(withJoint.gates.some((g) => g.id === "coverage-check"));

  const neither = planGates({ scope: "FULL", hasFrontend: true, hasOpenSpec: false, jointMode: false });
  assert.ok(!neither.gates.some((g) => g.id === "coverage-check"));
  assert.ok(neither.skipped.some((s) => s.id === "coverage-check"));
});

test("all script-kind gates have command[0] === 'node'", () => {
  const { gates } = planGates({ scope: "FULL", hasFrontend: true, hasOpenSpec: true, hasOpenDesign: true, jointMode: true });
  for (const gate of gates) {
    if (gate.kind === "script") {
      assert.equal(gate.command[0], "node", `gate ${gate.id} must have command[0] === "node"`);
    }
  }
});

test("all action-kind gates have command === null", () => {
  const { gates } = planGates({ scope: "FULL", hasFrontend: true });
  for (const gate of gates) {
    if (gate.kind === "action") {
      assert.equal(gate.command, null, `action gate ${gate.id} must have command null`);
    }
  }
});

test("all gates have blocking: true", () => {
  const { gates } = planGates({ scope: "FULL", hasFrontend: true, hasOpenSpec: true, hasOpenDesign: true });
  for (const gate of gates) {
    assert.equal(gate.blocking, true, `gate ${gate.id} must be blocking`);
  }
});

test("FULL scope with all options produces the complete catalog", () => {
  const { gates } = planGates({ scope: "FULL", hasFrontend: true, hasApi: true, hasOpenSpec: true, hasOpenDesign: true, jointMode: true });
  const ids = gates.map((g) => g.id);
  for (const expected of ["stack-up", "mcp-smoke", "generate-specs", "run-specs", "a11y-scan",
    "collect-results", "design-conformance", "uiux-review", "coverage-check", "triage", "report-review", "handoff-validate"]) {
    assert.ok(ids.includes(expected), `${expected} must be in FULL scope gates`);
  }
});

// CLI contract
test("CLI: --scope with no value fails as MISSING_ARGUMENT with exit 2", () => {
  const { status, json } = run(["plan", "--scope"]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "MISSING_ARGUMENT");
  assert.equal(status, 2);
});

test("CLI: missing --scope fails as MISSING_ARGUMENT with exit 2", () => {
  const { status, json } = run(["plan"]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "MISSING_ARGUMENT");
  assert.equal(status, 2);
});

test("CLI: invalid --scope value fails as INVALID_SCOPE with exit 1", () => {
  const { status, json } = run(["plan", "--scope", "MAXIMUM"]);
  assert.equal(json?.ok, false);
  assert.equal(json?.error?.code, "INVALID_SCOPE");
  assert.equal(status, 1);
});

test("CLI: plan --scope SMOKE returns ok: true with a non-empty gates list", () => {
  const { status, json } = run(["plan", "--scope", "SMOKE"]);
  assert.equal(json?.ok, true, JSON.stringify(json?.error));
  assert.ok(json?.result?.gates?.length > 0);
  assert.equal(status, 0);
});

test("VALID_SCOPES is frozen", () => {
  assert.ok(Object.isFrozen(VALID_SCOPES));
});

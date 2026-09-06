/**
 * `check-runtime-design.mjs` — a CLI end-to-end: le `plan/design-systems.json`
 * + `run/design-probes.json` ja capturados pelo subagente, roda os cinco
 * analisadores de `lib/runtime-design-probe.mjs` e devolve o veredito.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const CLI = resolve("skills/testador-subagents/scripts/check-runtime-design.mjs");
const roots = [];

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-runtime-design-test-"));
  roots.push(root);
  const artefatosDir = join(root, ".testador", "run");
  mkdirSync(join(artefatosDir, "plan"), { recursive: true });
  mkdirSync(join(artefatosDir, "run"), { recursive: true });
  const designDir = join(root, "design-system");
  mkdirSync(designDir, { recursive: true });
  return { root, artefatosDir, designDir };
}

function writeTokens(designDir, css) {
  writeFileSync(join(designDir, "tokens.css"), css, "utf8");
}

function writeDesignSystemsEntry(artefatosDir, designDir) {
  writeFileSync(
    join(artefatosDir, "plan", "design-systems.json"),
    JSON.stringify([{ id: "default", artifactDir: designDir, materializeInto: "packages/ui/design-systems/default" }]),
    "utf8",
  );
}

function writeProbes(artefatosDir, probes) {
  writeFileSync(join(artefatosDir, "run", "design-probes.json"), JSON.stringify(probes), "utf8");
}

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true });
  return { status: result.status, json: JSON.parse(result.stdout) };
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("no design-systems.json at all: skips explicitly, never invents approval", () => {
  const { artefatosDir, root } = fixture();
  const { status, json } = run(["--dir", artefatosDir, "--root", root]);
  assert.equal(status, 0);
  assert.match(json.result.message, /No design system entries found/);
  assert.deepEqual(json.result.findings, []);
});

test("design-systems.json present but no design-probes.json: degrades explicitly instead of reporting zero findings", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, ":root { --accent: #2563eb; }\n");
  writeDesignSystemsEntry(artefatosDir, designDir);
  const { status, json } = run(["--dir", artefatosDir, "--root", root]);
  assert.equal(status, 0);
  assert.equal(json.result.degraded, true);
  assert.match(json.result.reason, /design-probes\.json not found/);
});

test("a token that never resolves at :root is reported as DESIGN_TOKEN_UNRESOLVED", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, ":root { --accent: #2563eb; }\n");
  writeDesignSystemsEntry(artefatosDir, designDir);
  writeProbes(artefatosDir, [{ route: "/", viewport: { width: 1440 }, probe: { tokens: {} } }]);

  const { status, json } = run(["--dir", artefatosDir, "--root", root]);
  assert.equal(status, 0);
  const findings = json.result.details.findings;
  const finding = findings.find((f) => f.category === "DESIGN_TOKEN_UNRESOLVED");
  assert.ok(finding, "expected a DESIGN_TOKEN_UNRESOLVED finding");
  assert.equal(finding.evidence.route, "/");
});

test("a hex color outside the derived palette is DESIGN_COLOR_OFF_PALETTE, tagged with route and viewport", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, ":root { --accent: #2563eb; }\n");
  writeDesignSystemsEntry(artefatosDir, designDir);
  writeProbes(artefatosDir, [
    {
      route: "/admin/ordens-servico",
      viewport: { width: 375 },
      probe: { tokens: { "--accent": "#2563eb" }, elements: [{ selector: "span.badge", color: "#7c3aed" }] },
    },
  ]);

  const { json } = run(["--dir", artefatosDir, "--root", root]);
  const finding = json.result.details.findings.find((f) => f.category === "DESIGN_COLOR_OFF_PALETTE");
  assert.ok(finding, "expected a DESIGN_COLOR_OFF_PALETTE finding");
  assert.equal(finding.evidence.route, "/admin/ordens-servico");
  assert.equal(finding.evidence.viewport.width, 375);
});

test("a font resolving locally with no delivery link is DESIGN_FONT_NOT_DELIVERED", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, ':root { --font-body: Inter, sans-serif; }\n');
  writeDesignSystemsEntry(artefatosDir, designDir);
  writeProbes(artefatosDir, [
    {
      route: "/",
      viewport: { width: 1440 },
      probe: { tokens: {}, fonts: [{ family: "Inter", status: "loaded" }], stylesheetLinks: [] },
    },
  ]);

  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.ok(json.result.details.findings.some((f) => f.category === "DESIGN_FONT_NOT_DELIVERED"));
});

test("summary aggregates counts across routes and design systems", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, ":root { --accent: #2563eb; }\n");
  writeDesignSystemsEntry(artefatosDir, designDir);
  writeProbes(artefatosDir, [
    { route: "/", viewport: { width: 1440 }, probe: { tokens: { "--accent": "#2563eb" }, scrollWidth: 1440, clientWidth: 1440 } },
    { route: "/", viewport: { width: 375 }, probe: { tokens: {}, scrollWidth: 400, clientWidth: 375 } },
  ]);

  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.equal(json.result.summary.routesChecked, 2);
  assert.equal(json.result.summary.designSystemsChecked, 1);
  assert.ok(json.result.summary.totalFindings >= 2);
});

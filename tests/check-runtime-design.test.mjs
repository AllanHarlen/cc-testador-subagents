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

function writeDesignSystemsEntry(artefatosDir, designDir, extra = {}) {
  writeFileSync(
    join(artefatosDir, "plan", "design-systems.json"),
    JSON.stringify([{ id: "default", artifactDir: designDir, materializeInto: "packages/ui/design-systems/default", ...extra }]),
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

const THEMED_CSS = `:root, [data-theme="light"] { --bg: #ffffff; --accent: #2563eb; }
[data-theme="dark"] { --bg: #0b0b0f; --accent: #6b9cff; }
`;

function writeBrief(root, fields) {
  const path = join(root, "design-brief.json");
  writeFileSync(
    path,
    JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, locked: true }])) }),
    "utf8",
  );
  return path;
}

test("fixture: inverted theme (brief says light, page paints dark) yields a DESIGN_BRIEF_MISMATCH", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "toggle", colorPrimary: "#2563eb" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  writeProbes(artefatosDir, [
    {
      route: "/",
      viewport: { width: 1440 },
      theme: "default",
      probe: { tokens: { "--bg": "#0b0b0f", "--accent": "#2563eb" }, theme: { dataTheme: "dark", prefersDark: false } },
    },
    {
      route: "/",
      viewport: { width: 1440 },
      theme: "dark",
      probe: { tokens: { "--bg": "#0b0b0f", "--accent": "#6b9cff" }, theme: { dataTheme: "dark", prefersDark: false } },
    },
  ]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  const mismatch = json.result.details.findings.filter((f) => f.category === "DESIGN_BRIEF_MISMATCH");
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].evidence.theme, "default");
  assert.equal(json.result.details.warnings.length, 0);
});

test("fixture: broken dark theme (data-theme=dark but tokens/paint stay light) yields DESIGN_BRIEF_MISMATCH and DESIGN_TOKEN_UNRESOLVED", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "toggle" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  writeProbes(artefatosDir, [
    {
      route: "/",
      viewport: { width: 1440 },
      theme: "dark",
      probe: { tokens: { "--bg": "#ffffff", "--accent": "#2563eb" }, theme: { dataTheme: "dark", prefersDark: false } },
    },
  ]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  const categories = json.result.details.findings.map((f) => f.category);
  assert.ok(categories.includes("DESIGN_BRIEF_MISMATCH"));
  assert.ok(categories.includes("DESIGN_TOKEN_UNRESOLVED"), "dark tokens expected from tokens.css, not the light values");
});

test("a healthy light+dark pair passes with no findings", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "toggle", colorPrimary: "#2563eb" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  writeProbes(artefatosDir, [
    { route: "/", viewport: { width: 1440 }, theme: "default", probe: { tokens: { "--bg": "#ffffff", "--accent": "#2563eb" }, theme: {} } },
    { route: "/", viewport: { width: 1440 }, theme: "dark", probe: { tokens: { "--bg": "#0b0b0f", "--accent": "#6b9cff" }, theme: { dataTheme: "dark" } } },
  ]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.deepEqual(json.result.details.findings.filter((f) => f.category !== "DESIGN_TOKEN_DEAD"), []);
  assert.equal(json.result.details.warnings.length, 0);
});

test("brief exposes dark but no dark probe was captured: critical DESIGN_DARK_PROBE_MISSING, never silent approval", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "toggle" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  writeProbes(artefatosDir, [
    { route: "/", viewport: { width: 1440 }, theme: "default", probe: { tokens: { "--bg": "#ffffff", "--accent": "#2563eb" }, theme: {} } },
  ]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  const missing = json.result.details.findings.filter((f) => f.category === "DESIGN_DARK_PROBE_MISSING");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, "critical");
  assert.match(missing[0].title, /dark theme was not verified/);
  assert.equal(json.result.details.checklists[0].darkProbeRequired, true);
});

test("contractSha256 from the handoff that does not match design-contract.json on disk is DESIGN_CONTRACT_HASH_MISMATCH", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  writeFileSync(join(designDir, "design-contract.json"), '{"systemId":"x"}', "utf8");
  writeDesignSystemsEntry(artefatosDir, designDir, { contractSha256: "0".repeat(64) });
  writeProbes(artefatosDir, [{ route: "/", viewport: { width: 1440 }, probe: { tokens: { "--bg": "#ffffff", "--accent": "#2563eb" } } }]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.ok(json.result.details.findings.some((f) => f.category === "DESIGN_CONTRACT_HASH_MISMATCH"));
});

test("brief exposes dark and design-probes.json is absent: the degraded result still carries DESIGN_DARK_PROBE_MISSING", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "toggle" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.equal(json.result.degraded, true);
  assert.ok(json.result.findings.some((f) => f.category === "DESIGN_DARK_PROBE_MISSING"));
});

test("light-only brief never requires a dark probe", () => {
  const { artefatosDir, root, designDir } = fixture();
  writeTokens(designDir, THEMED_CSS);
  const designBriefPath = writeBrief(root, { themeDefault: "light", themeExposure: "light-only" });
  writeDesignSystemsEntry(artefatosDir, designDir, { designBriefPath });
  writeProbes(artefatosDir, [
    { route: "/", viewport: { width: 1440 }, theme: "default", probe: { tokens: { "--bg": "#ffffff", "--accent": "#2563eb" }, theme: {} } },
  ]);
  const { json } = run(["--dir", artefatosDir, "--root", root]);
  assert.ok(!json.result.details.findings.some((f) => f.category === "DESIGN_DARK_PROBE_MISSING"));
});

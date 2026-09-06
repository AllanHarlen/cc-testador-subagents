/**
 * Os cinco analisadores puros do gate de conformidade de design em runtime
 * (Achado 12.10) — sobre fixtures de JSON de probe, sem navegador nenhum.
 * `RUNTIME_DESIGN_PROBE_SCRIPT` (o texto injetado via browser_evaluate) nao
 * e testavel aqui por definicao; so os analisadores puros.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_DESIGN_PROBE_SCRIPT,
  analyzeFontDelivery,
  analyzePaletteScan,
  analyzeTokenCensus,
  analyzeTokenResolution,
  analyzeViewportLayout,
} from "../skills/testador-subagents/scripts/lib/runtime-design-probe.mjs";

test("RUNTIME_DESIGN_PROBE_SCRIPT is a non-empty self-invoking script that never mutates the DOM", () => {
  assert.equal(typeof RUNTIME_DESIGN_PROBE_SCRIPT, "string");
  assert.match(RUNTIME_DESIGN_PROBE_SCRIPT, /getComputedStyle/);
  assert.doesNotMatch(RUNTIME_DESIGN_PROBE_SCRIPT, /\.innerHTML\s*=|\.textContent\s*=|\.setAttribute\(/);
});

/* -------------------------------------------------------------------------- */
/* analyzeTokenResolution                                                     */
/* -------------------------------------------------------------------------- */

test("analyzeTokenResolution: every declared token resolving to the expected value produces no findings", () => {
  const probe = { tokens: { "--accent": "#2563eb", "--radius-md": "16px" } };
  const expected = [{ name: "--accent", value: "#2563eb" }, { name: "--radius-md", value: "16px" }];
  const result = analyzeTokenResolution(probe, expected);
  assert.equal(result.findings.length, 0);
  assert.equal(result.resolved, 2);
});

test("analyzeTokenResolution: a token that never resolves at :root is DESIGN_TOKEN_UNRESOLVED", () => {
  const result = analyzeTokenResolution({ tokens: {} }, [{ name: "--accent", value: "#2563eb" }]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, "DESIGN_TOKEN_UNRESOLVED");
  assert.match(result.findings[0].title, /never resolves/);
});

test("analyzeTokenResolution: a token resolving to a different value is also DESIGN_TOKEN_UNRESOLVED", () => {
  const probe = { tokens: { "--accent": "#111827" } };
  const result = analyzeTokenResolution(probe, [{ name: "--accent", value: "#2563eb" }]);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /different value/);
});

/* -------------------------------------------------------------------------- */
/* analyzePaletteScan                                                         */
/* -------------------------------------------------------------------------- */

test("analyzePaletteScan: a hardcoded hex outside the palette is DESIGN_COLOR_OFF_PALETTE", () => {
  // Achado 12.4: #7c3aed (violeta) e #b45309 hardcoded fora da paleta do Open Design.
  const probe = {
    elements: [
      { selector: "span.badge-faturada", color: "#6d28d9", backgroundColor: "oklab(0.5 0 0 / 0.15)", borderColor: "transparent" },
    ],
  };
  const result = analyzePaletteScan(probe, { paletteHex: ["#2563eb", "#101828", "#f59e0b", "#ef4444"] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, "DESIGN_COLOR_OFF_PALETTE");
  assert.equal(result.findings[0].evidence.value, "#6d28d9");
});

test("analyzePaletteScan: a color in an explicit exception list (e.g. WhatsApp green) is not flagged", () => {
  const probe = { elements: [{ selector: "svg.whatsapp-icon", color: "#25d366" }] };
  const result = analyzePaletteScan(probe, { paletteHex: ["#2563eb"], hexExceptions: ["#25d366"] });
  assert.equal(result.findings.length, 0);
});

test("analyzePaletteScan: a color inside the palette is never flagged", () => {
  const probe = { elements: [{ selector: "div", color: "#2563eb" }] };
  const result = analyzePaletteScan(probe, { paletteHex: ["#2563eb"] });
  assert.equal(result.findings.length, 0);
});

test("analyzePaletteScan: an empty paletteHex disables the color check entirely (no false positives from an unconfigured contract)", () => {
  const probe = { elements: [{ selector: "div", color: "#ff00ff" }] };
  const result = analyzePaletteScan(probe, {});
  assert.equal(result.findings.length, 0);
});

test("analyzePaletteScan: a font-size below the declared scale is flagged (Achado 12.5)", () => {
  const probe = { elements: [{ selector: "span.label", fontSize: "10px" }] };
  const result = analyzePaletteScan(probe, { fontSizes: ["12px", "14px", "16px"] });
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /font-size 10px/);
});

test("analyzePaletteScan: a border-radius outside the declared scale is flagged, 0px is never flagged", () => {
  const probe = {
    elements: [
      { selector: "div.card", borderRadius: "3px" },
      { selector: "span.inline", borderRadius: "0px" },
    ],
  };
  const result = analyzePaletteScan(probe, { radii: ["8px", "16px"] });
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /border-radius 3px/);
});

test("analyzePaletteScan: duplicate off-palette colors on distinct elements are each reported once, not once per field", () => {
  const probe = { elements: [{ selector: "div.x", color: "#ff00ff", backgroundColor: "#ff00ff" }] };
  const result = analyzePaletteScan(probe, { paletteHex: ["#000000"] });
  assert.equal(result.findings.length, 1);
});

/* -------------------------------------------------------------------------- */
/* analyzeFontDelivery                                                        */
/* -------------------------------------------------------------------------- */

test("analyzeFontDelivery: a font that loads only because it's installed locally, with no delivery mechanism, is flagged (Achado 12.3)", () => {
  const probe = {
    fonts: [{ family: "Inter", status: "loaded" }],
    stylesheetLinks: ["/_next/static/css/336e363cfd9dee11.css"],
  };
  const result = analyzeFontDelivery(probe, ["Inter"]);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /renders only because it is installed/);
});

test("analyzeFontDelivery: a font delivered via next/font (a hashed woff2 in _next/static/media) is not flagged", () => {
  const probe = {
    fonts: [{ family: "Inter", status: "loaded" }],
    stylesheetLinks: ["/_next/static/media/e4af272ccee01ff0-s.p.woff2"],
  };
  const result = analyzeFontDelivery(probe, ["Inter"]);
  assert.equal(result.findings.length, 0);
});

test("analyzeFontDelivery: a font delivered via Google Fonts stylesheet is not flagged", () => {
  const probe = {
    fonts: [{ family: "Inter", status: "loaded" }],
    stylesheetLinks: ["https://fonts.googleapis.com/css2?family=Inter"],
  };
  const result = analyzeFontDelivery(probe, ["Inter"]);
  assert.equal(result.findings.length, 0);
});

test("analyzeFontDelivery: a font that never loads at all is a critical finding", () => {
  const result = analyzeFontDelivery({ fonts: [], stylesheetLinks: [] }, ["Inter"]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, "critical");
});

/* -------------------------------------------------------------------------- */
/* analyzeTokenCensus (static, no browser probe)                              */
/* -------------------------------------------------------------------------- */

test("analyzeTokenCensus: a declared token never referenced in the source is DESIGN_TOKEN_DEAD", () => {
  const declared = [{ name: "--space-4" }, { name: "--accent" }];
  const result = analyzeTokenCensus(declared, new Set(["--accent"]));
  assert.equal(result.deadCount, 1);
  assert.equal(result.findings[0].category, "DESIGN_TOKEN_DEAD");
  assert.equal(result.findings[0].evidence.token, "--space-4");
});

test("analyzeTokenCensus: every declared token referenced produces no findings", () => {
  const result = analyzeTokenCensus([{ name: "--accent" }], ["--accent"]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.totalDeclared, 1);
});

/* -------------------------------------------------------------------------- */
/* analyzeViewportLayout                                                      */
/* -------------------------------------------------------------------------- */

test("analyzeViewportLayout: scrollWidth > clientWidth is DESIGN_VIEWPORT_OVERFLOW", () => {
  const probe = { viewport: { width: 375 }, scrollWidth: 420, clientWidth: 375 };
  const result = analyzeViewportLayout(probe);
  assert.equal(result.findings.some((f) => f.category === "DESIGN_VIEWPORT_OVERFLOW"), true);
});

test("analyzeViewportLayout: nav occupying most of the page height before content starts is DESIGN_NAV_DOMINANCE (Achado 12.7)", () => {
  // 668px de nav numa pagina de 2034px == 39% — o caso real do sidebar mobile.
  const probe = {
    viewport: { width: 375 },
    scrollWidth: 375,
    clientWidth: 375,
    pageHeight: 2034,
    navBox: { top: 0, left: 0, right: 375, bottom: 668, height: 668 },
  };
  const result = analyzeViewportLayout(probe);
  const finding = result.findings.find((f) => f.category === "DESIGN_NAV_DOMINANCE");
  assert.ok(finding, "expected a DESIGN_NAV_DOMINANCE finding");
  assert.equal(finding.evidence.navHeightPx, 668);
});

test("analyzeViewportLayout: a small, well-behaved nav is not flagged as dominant", () => {
  const probe = {
    viewport: { width: 375 },
    scrollWidth: 375,
    clientWidth: 375,
    pageHeight: 2000,
    navBox: { top: 0, left: 0, right: 375, bottom: 60, height: 60 },
  };
  const result = analyzeViewportLayout(probe);
  assert.equal(result.findings.some((f) => f.category === "DESIGN_NAV_DOMINANCE"), false);
});

test("analyzeViewportLayout: zero gutter between nav/header and content reads as a collision (Achado 12.8)", () => {
  const probe = {
    viewport: { width: 375 },
    scrollWidth: 375,
    clientWidth: 375,
    pageHeight: 900,
    navBox: { top: 0, left: 56, right: 122, bottom: 40, height: 40 },
    mainBox: { top: 0, left: 122, right: 300, bottom: 40, height: 40 },
  };
  const result = analyzeViewportLayout(probe);
  const finding = result.findings.find((f) => /Zero gutter/.test(f.title));
  assert.ok(finding, "expected a zero-gutter finding");
});

test("analyzeViewportLayout: a healthy viewport (no overflow, no collision, small nav) produces no findings", () => {
  const probe = {
    viewport: { width: 1440 },
    scrollWidth: 1440,
    clientWidth: 1440,
    pageHeight: 2000,
    navBox: { top: 0, left: 0, right: 1440, bottom: 60, height: 60 },
    mainBox: { top: 100, left: 0, right: 1440, bottom: 2000, height: 1900 },
  };
  const result = analyzeViewportLayout(probe);
  assert.equal(result.findings.length, 0);
});

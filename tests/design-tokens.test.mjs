/**
 * Parser de tokens do Open Design: parse de tokens.css, DESIGN.md (9 secoes
 * + anti-padroes §9), comparacao verbatim vs materializado.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseTokensCss, parseDesignMd, diffTokens, loadDesignSystem } from "../skills/testador-subagents/scripts/lib/design-tokens.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "design-tokens-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

const SAMPLE_TOKENS_CSS = `
:root {
  --color-primary: #1a73e8;
  --color-accent: #e91e63;
  --spacing-base: 8px;
  --border-radius-sm: 4px;
}
`;

const SAMPLE_DESIGN_MD = `
# Design System

## 1. Vision

Minimal, accessible.

## 2. Colors

Primary: var(--color-primary).

## 9. Anti-patterns

- Never use hex literals directly in component files.
- Do not override tokens without documentation.
`;

test("parseTokensCss extracts all custom properties from a tokens.css file", () => {
  const root = fixture();
  const path = join(root, "tokens.css");
  writeFileSync(path, SAMPLE_TOKENS_CSS, "utf8");
  const { tokens, found } = parseTokensCss(path);
  assert.equal(found, true);
  assert.equal(tokens.size, 4);
  assert.equal(tokens.get("--color-primary"), "#1a73e8");
  assert.equal(tokens.get("--spacing-base"), "8px");
});

test("parseTokensCss returns empty Map and found:false for missing file", () => {
  const { tokens, found } = parseTokensCss("/does/not/exist/tokens.css");
  assert.equal(found, false);
  assert.equal(tokens.size, 0);
});

test("parseDesignMd finds sections and identifies §9 anti-patterns section", () => {
  const root = fixture();
  const path = join(root, "DESIGN.md");
  writeFileSync(path, SAMPLE_DESIGN_MD, "utf8");
  const { sections, section9, found } = parseDesignMd(path);
  assert.equal(found, true);
  assert.ok(sections.length >= 3);
  assert.ok(section9 !== null, "Section 9 (anti-patterns) must be detected");
  assert.ok(section9.content.includes("Anti-patterns") || section9.content.includes("9."), "section9 content must contain heading");
});

test("diffTokens detects missing, changed and invented tokens", () => {
  const verbatim = new Map([["--color-primary", "#1a73e8"], ["--spacing-base", "8px"]]);
  const materialized = new Map([["--color-primary", "#0000ff"], ["--extra-token", "12px"]]);
  const diff = diffTokens(verbatim, materialized);
  assert.deepEqual(diff.missing, [{ name: "--spacing-base", verbatimValue: "8px" }]);
  assert.deepEqual(diff.changed, [{ name: "--color-primary", verbatimValue: "#1a73e8", materializedValue: "#0000ff" }]);
  assert.deepEqual(diff.invented, [{ name: "--extra-token", materializedValue: "12px" }]);
});

test("diffTokens returns empty arrays when tokens are identical", () => {
  const tokens = new Map([["--color-primary", "#1a73e8"]]);
  const diff = diffTokens(tokens, new Map([["--color-primary", "#1a73e8"]]));
  assert.deepEqual(diff, { missing: [], changed: [], invented: [] });
});

test("loadDesignSystem reports materializationDivergence when tokens differ", () => {
  const root = fixture();
  const verbatimDir = join(root, "design-systems", "default");
  const materializedDir = join(root, "packages", "ui");
  mkdirSync(verbatimDir, { recursive: true });
  mkdirSync(materializedDir, { recursive: true });
  writeFileSync(join(verbatimDir, "tokens.css"), "--color-a: red;", "utf8");
  writeFileSync(join(materializedDir, "tokens.css"), "--color-a: blue;", "utf8");

  const entry = { id: "default", artifactDir: verbatimDir, materializeInto: "packages/ui" };
  const ds = loadDesignSystem(entry, root);
  assert.ok(ds.materializationDivergence !== null);
  assert.ok(ds.materializationDivergence.changed.length > 0);
});

test("loadDesignSystem reports no divergence when verbatim and materialized match", () => {
  const root = fixture();
  const verbatimDir = join(root, "design-systems", "default");
  const materializedDir = join(root, "packages", "ui");
  mkdirSync(verbatimDir, { recursive: true });
  mkdirSync(materializedDir, { recursive: true });
  const content = "--color-a: red;";
  writeFileSync(join(verbatimDir, "tokens.css"), content, "utf8");
  writeFileSync(join(materializedDir, "tokens.css"), content, "utf8");

  const entry = { id: "default", artifactDir: verbatimDir, materializeInto: "packages/ui" };
  const ds = loadDesignSystem(entry, root);
  assert.equal(ds.materializationDivergence, null);
});

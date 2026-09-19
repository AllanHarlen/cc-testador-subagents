/**
 * Gate do probe escuro na triagem: brief que expoe o tema escuro sem probe
 * `theme:"dark"` vira achado critico e reprova o handoff (nao e warning).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { darkProbeGateFindings } from "../skills/testador-subagents/scripts/lib/dark-probe-gate.mjs";

const CLI = resolve("skills/testador-subagents/scripts/triage-findings.mjs");
const roots = [];

function setup({ exposure, probes }) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-dark-gate-test-"));
  roots.push(root);
  const dir = join(root, "run");
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "run"), { recursive: true });
  const briefPath = join(root, "design-brief.json");
  writeFileSync(briefPath, JSON.stringify({ fields: { themeExposure: { value: exposure, locked: true } } }));
  writeFileSync(join(dir, "plan", "design-systems.json"), JSON.stringify([{ id: "ds", designBriefPath: briefPath }]));
  if (probes) writeFileSync(join(dir, "run", "design-probes.json"), JSON.stringify(probes));
  return { root, dir, briefPath };
}

function triage(dir, extra = []) {
  const r = spawnSync(process.execPath, [CLI, "--dir", dir, ...extra], { encoding: "utf8", windowsHide: true });
  return JSON.parse(r.stdout).result;
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("darkProbeGateFindings: toggle + only light probes -> one critical finding; dark probe clears it", () => {
  const { briefPath } = setup({ exposure: "toggle" });
  const entries = [{ id: "ds", designBriefPath: briefPath }];
  const missing = darkProbeGateFindings(entries, [{ theme: "light" }]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].category, "DESIGN_DARK_PROBE_MISSING");
  assert.equal(missing[0].severity, "critical");
  assert.deepEqual(darkProbeGateFindings(entries, [{ theme: "light" }, { theme: "dark" }]), []);
  assert.equal(darkProbeGateFindings(entries, null).length, 1);
});

test("darkProbeGateFindings: light-only and missing brief never require a dark probe", () => {
  const { briefPath } = setup({ exposure: "light-only" });
  assert.deepEqual(darkProbeGateFindings([{ id: "ds", designBriefPath: briefPath }], []), []);
  assert.deepEqual(darkProbeGateFindings([{ id: "ds" }], []), []);
});

test("triage-findings blocks the run when the brief exposes dark and no dark probe exists", () => {
  const { dir } = setup({ exposure: "toggle", probes: [{ route: "/", theme: "default", probe: {} }] });
  const result = triage(dir);
  const finding = JSON.stringify(result).includes("DESIGN_DARK_PROBE_MISSING");
  assert.ok(finding, "triage output must carry DESIGN_DARK_PROBE_MISSING");
  assert.notEqual(result.handoffStatus, "DONE");
});

test("triage-findings does not raise the gate once a dark probe was captured", () => {
  const { dir } = setup({ exposure: "toggle", probes: [{ route: "/", theme: "dark", probe: {} }] });
  assert.ok(!JSON.stringify(triage(dir)).includes("DESIGN_DARK_PROBE_MISSING"));
});

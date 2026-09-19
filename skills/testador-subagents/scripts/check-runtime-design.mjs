#!/usr/bin/env node
/**
 * CLI de conformidade de design em runtime (Achado 12.10).
 * check-runtime-design.mjs --dir <artefatos_dir> [--root .]
 *
 * Le `{artefatos_dir}/run/design-probes.json` — um array de
 * `{ route, viewport, theme?, probe }` (`theme`: "default" | "light" | "dark") que o subagente da Fase 8 ja capturou
 * injetando `RUNTIME_DESIGN_PROBE_SCRIPT` (lib/runtime-design-probe.mjs) via
 * `browser_evaluate`, uma vez por rota-chave/viewport — e roda os cinco
 * analisadores deterministicos sobre cada entrada, contra o design system
 * declarado em `{artefatos_dir}/plan/design-systems.json` (mesmo arquivo que
 * `check-design-conformance.mjs` ja consome).
 *
 * Sem `design-probes.json` (subagente nao rodou o probe, ou nao ha
 * `browser_evaluate` disponivel no ambiente), degrada explicitamente — nunca
 * inventa aprovacao.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadDesignSystem } from "./lib/design-tokens.mjs";
import {
  analyzeBriefConformance,
  analyzeFontDelivery,
  analyzePaletteScan,
  analyzeTokenCensus,
  analyzeTokenResolution,
  analyzeViewportLayout,
  darkThemeRequired,
  parseThemedTokensCss,
} from "./lib/runtime-design-probe.mjs";
import { darkProbeGateFindings, darkProbeMissingFinding } from "./lib/dark-probe-gate.mjs";
import { intelligenceResult } from "./lib/intelligence.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

const HEX_TOKEN_VALUE_RE = /^#[0-9a-f]{3,8}$/i;

/** Deriva paleta/escala/familias do design system a partir dos tokens verbatim ja carregados. */
function deriveContractFromTokens(verbatimTokens = []) {
  const paletteHex = [];
  const radii = [];
  const fontSizes = [];
  const families = new Set();
  for (const token of verbatimTokens) {
    const value = String(token.value ?? "").trim();
    if (HEX_TOKEN_VALUE_RE.test(value)) paletteHex.push(value);
    if (token.name.startsWith("--radius-")) radii.push(value);
    if (token.name.startsWith("--text-")) fontSizes.push(value);
    if (token.name.startsWith("--font-")) {
      const firstFamily = value.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      if (firstFamily) families.add(firstFamily);
    }
  }
  return { paletteHex, radii, fontSizes, families: [...families] };
}

/** Le `design-brief.json` do handoff (`entry.designBriefPath`, absoluto); null se ausente/ilegivel. */
function loadBrief(entry) {
  if (!entry.designBriefPath || !existsSync(entry.designBriefPath)) return null;
  try {
    return JSON.parse(readFileSync(entry.designBriefPath, "utf8"));
  } catch {
    return null;
  }
}

/** Tokens esperados por tema a partir do `tokens.css` resolved/ (claro = base; escuro = base + overrides). */
function loadThemedTokens(entry) {
  const cssPath = join(entry.artifactDir, "tokens.css");
  if (!existsSync(cssPath)) return null;
  const themed = parseThemedTokensCss(readFileSync(cssPath, "utf8"));
  const list = (map) => Object.entries(map).map(([name, value]) => ({ name, value }));
  return { light: list(themed.light), dark: list(themed.dark), hasDark: themed.hasDark };
}

/** `sha256` do design-contract.json em disco x `contractSha256` do handoff. */
function checkContractHash(entry) {
  if (!entry.contractSha256) return [];
  const contractPath = join(entry.artifactDir, "design-contract.json");
  if (!existsSync(contractPath)) return [];
  const actual = createHash("sha256").update(readFileSync(contractPath)).digest("hex");
  if (actual === entry.contractSha256) return [];
  return [
    {
      category: "DESIGN_CONTRACT_HASH_MISMATCH",
      severity: "critical",
      title: `design-contract.json on disk (${actual.slice(0, 12)}…) does not match the handoff contractSha256 (${entry.contractSha256.slice(0, 12)}…)`,
      evidence: { expected: entry.contractSha256, actual, path: contractPath },
    },
  ];
}

/** Nomes de token (`--nome`) referenciados via `var(--nome)` em uma arvore de fonte. */
function collectReferencedTokenNames(sourceGlobRoots = []) {
  const names = new Set();
  const VAR_REF_RE = /var\(\s*(--[a-zA-Z][a-zA-Z0-9-_]*)/g;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(tsx?|jsx?|css|scss)$/.test(entry.name)) {
        let content;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        for (const match of content.matchAll(VAR_REF_RE)) names.add(match[1]);
      }
    }
  };
  for (const root of sourceGlobRoots) walk(root);
  return names;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return {
      name: "check-runtime-design",
      commands: { check: "check-runtime-design.mjs --dir <artefatos_dir> [--root .]" },
    };
  }
  const dir = required(args, "dir");
  const projectRoot = args.root === true ? process.cwd() : (args.root ?? process.cwd());
  const artefatosDir = resolve(dir);

  const designEntriesPath = join(artefatosDir, "plan", "design-systems.json");
  const probesPath = join(artefatosDir, "run", "design-probes.json");

  if (!existsSync(designEntriesPath)) {
    return { result: { message: "No design system entries found — skipping runtime design check", checklists: [], findings: [] } };
  }
  let designEntries = [];
  try {
    designEntries = JSON.parse(readFileSync(designEntriesPath, "utf8"));
  } catch {
    return { result: { message: "design-systems.json is unreadable — skipping runtime design check", checklists: [], findings: [] } };
  }
  if (designEntries.length === 0) {
    return { result: { message: "No design system entries found — skipping runtime design check", checklists: [], findings: [] } };
  }

  const missingDarkFindings = () => darkProbeGateFindings(designEntries, null);

  if (!existsSync(probesPath)) {
    // Nunca inventa aprovacao: sem probe, o gate fica explicitamente
    // degradado, nao silenciosamente "sem achados" (que pareceria aprovado).
    return {
      result: {
        degraded: true,
        reason: "run/design-probes.json not found — the Fase 8 subagent did not capture a runtime probe via browser_evaluate",
        checklists: [],
        findings: missingDarkFindings(),
      },
    };
  }
  let probes;
  try {
    probes = JSON.parse(readFileSync(probesPath, "utf8"));
  } catch (error) {
    return {
      result: {
        degraded: true,
        reason: `run/design-probes.json is unreadable: ${error.message}`,
        checklists: [],
        findings: missingDarkFindings(),
      },
    };
  }

  const findings = [];
  const checklists = [];
  const warnings = [];
  for (const entry of designEntries) {
    const ds = loadDesignSystem(entry, resolve(projectRoot));
    const expectedTokens = ds.verbatimTokens ?? [];
    const contract = deriveContractFromTokens(expectedTokens);
    const referencedTokenNames = collectReferencedTokenNames(
      entry.sourceRoots ?? (entry.materializeInto ? [join(resolve(projectRoot), entry.materializeInto, "..")] : []),
    );

    const censusResult = analyzeTokenCensus(expectedTokens, referencedTokenNames);
    findings.push(...censusResult.findings);

    const brief = loadBrief(entry);
    const themed = loadThemedTokens(entry);
    findings.push(...checkContractHash(entry));

    for (const { route, viewport, theme, probe } of probes) {
      // `theme`: "default" (nada forcado), "light" ou "dark" (forcado por
      // `data-theme` ou `prefers-color-scheme` emulado).
      const mode = theme === "dark" || theme === "light" ? theme : "default";
      const themeTokens = mode === "dark" && themed ? themed.dark : expectedTokens;
      const resolutionResult = analyzeTokenResolution(probe, themeTokens);
      const paletteResult = analyzePaletteScan(probe, contract);
      const fontResult = analyzeFontDelivery(probe, contract.families);
      const layoutResult = analyzeViewportLayout(probe);
      const briefResult = brief ? analyzeBriefConformance(probe, brief, { mode }) : { findings: [] };
      const tagRoute = (f) => ({ ...f, evidence: { ...f.evidence, route, viewport, theme: mode } });
      findings.push(
        ...resolutionResult.findings.map(tagRoute),
        ...paletteResult.findings.map(tagRoute),
        ...fontResult.findings.map(tagRoute),
        ...layoutResult.findings.map(tagRoute),
        ...briefResult.findings.map(tagRoute),
      );
    }

    const darkProbes = probes.filter((p) => p.theme === "dark").length;
    const darkRequired = darkThemeRequired(brief);
    if (darkRequired && darkProbes === 0) {
      findings.push(darkProbeMissingFinding(entry.id));
    }

    checklists.push({
      designSystemId: entry.id,
      expectedTokenCount: expectedTokens.length,
      deadTokenCount: censusResult.deadCount,
      routesChecked: probes.length,
      briefLoaded: Boolean(brief),
      darkProbeRequired: darkRequired,
      darkProbes,
    });
  }

  const summary = {
    designSystemsChecked: checklists.length,
    routesChecked: probes.length,
    totalFindings: findings.length,
    blockingCategoryCounts: Object.fromEntries(
      [...new Set(findings.map((f) => f.category))].map((cat) => [cat, findings.filter((f) => f.category === cat).length]),
    ),
  };

  return { result: intelligenceResult("design-runtime", summary, { checklists, findings, warnings }) };
}

executeJsonCli(main);

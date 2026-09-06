#!/usr/bin/env node
/**
 * CLI de conformidade de design em runtime (Achado 12.10).
 * check-runtime-design.mjs --dir <artefatos_dir> [--root .]
 *
 * Le `{artefatos_dir}/run/design-probes.json` — um array de
 * `{ route, viewport, probe }` que o subagente da Fase 8 ja capturou
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadDesignSystem } from "./lib/design-tokens.mjs";
import {
  analyzeFontDelivery,
  analyzePaletteScan,
  analyzeTokenCensus,
  analyzeTokenResolution,
  analyzeViewportLayout,
} from "./lib/runtime-design-probe.mjs";
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

  if (!existsSync(probesPath)) {
    // Nunca inventa aprovacao: sem probe, o gate fica explicitamente
    // degradado, nao silenciosamente "sem achados" (que pareceria aprovado).
    return {
      result: {
        degraded: true,
        reason: "run/design-probes.json not found — the Fase 8 subagent did not capture a runtime probe via browser_evaluate",
        checklists: [],
        findings: [],
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
        findings: [],
      },
    };
  }

  const findings = [];
  const checklists = [];
  for (const entry of designEntries) {
    const ds = loadDesignSystem(entry, resolve(projectRoot));
    const expectedTokens = ds.verbatimTokens ?? [];
    const contract = deriveContractFromTokens(expectedTokens);
    const referencedTokenNames = collectReferencedTokenNames(
      entry.sourceRoots ?? (entry.materializeInto ? [join(resolve(projectRoot), entry.materializeInto, "..")] : []),
    );

    const censusResult = analyzeTokenCensus(expectedTokens, referencedTokenNames);
    findings.push(...censusResult.findings);

    for (const { route, viewport, probe } of probes) {
      const resolutionResult = analyzeTokenResolution(probe, expectedTokens);
      const paletteResult = analyzePaletteScan(probe, contract);
      const fontResult = analyzeFontDelivery(probe, contract.families);
      const layoutResult = analyzeViewportLayout(probe);
      const tagRoute = (f) => ({ ...f, evidence: { ...f.evidence, route, viewport } });
      findings.push(
        ...resolutionResult.findings.map(tagRoute),
        ...paletteResult.findings.map(tagRoute),
        ...fontResult.findings.map(tagRoute),
        ...layoutResult.findings.map(tagRoute),
      );
    }

    checklists.push({
      designSystemId: entry.id,
      expectedTokenCount: expectedTokens.length,
      deadTokenCount: censusResult.deadCount,
      routesChecked: probes.length,
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

  return { result: intelligenceResult("design-runtime", summary, { checklists, findings }) };
}

executeJsonCli(main);

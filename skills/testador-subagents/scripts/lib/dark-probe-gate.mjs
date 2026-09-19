/**
 * Gate do probe escuro: quando o `design-brief.json` expoe o tema escuro
 * (`themeExposure` != `light-only`), `run/design-probes.json` precisa ter ao
 * menos uma entrada `theme:"dark"`. Sem ela o tema escuro nao foi verificado e
 * o avanco da fase de design e reprovado (achado critico
 * `DESIGN_DARK_PROBE_MISSING`), nunca um aviso.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { darkThemeRequired } from "./runtime-design-probe.mjs";

/** Le o `design-brief.json` da entrada de design system (`designBriefPath` absoluto); null se ausente/ilegivel. */
export function loadBriefForEntry(entry) {
  if (!entry?.designBriefPath || !existsSync(entry.designBriefPath)) return null;
  try {
    return JSON.parse(readFileSync(entry.designBriefPath, "utf8"));
  } catch {
    return null;
  }
}

export function darkProbeMissingFinding(designSystemId) {
  return {
    category: "DESIGN_DARK_PROBE_MISSING",
    severity: "critical",
    title: `${designSystemId}: the brief exposes the dark theme (themeExposure) but run/design-probes.json has no "theme":"dark" probe — the dark theme was not verified`,
    evidence: { designSystemId, field: "themeExposure" },
  };
}

/**
 * @param {Array<object>} designEntries entradas de plan/design-systems.json
 * @param {Array<{theme?: string}>|null} probes conteudo de run/design-probes.json (null = ausente/ilegivel)
 * @returns {object[]} achados criticos, um por design system que exige o probe escuro e nao o tem
 */
export function darkProbeGateFindings(designEntries, probes) {
  const hasDark = Array.isArray(probes) && probes.some((p) => p?.theme === "dark");
  if (hasDark) return [];
  return (designEntries ?? [])
    .filter((entry) => darkThemeRequired(loadBriefForEntry(entry)))
    .map((entry) => darkProbeMissingFinding(entry.id));
}

/** Le os dois arquivos do artefatos_dir e devolve os achados do gate (usado pela triagem). */
export function darkProbeGateForDir(artefatosDir) {
  const entriesPath = join(artefatosDir, "plan", "design-systems.json");
  if (!existsSync(entriesPath)) return [];
  let entries;
  try {
    entries = JSON.parse(readFileSync(entriesPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const probesPath = join(artefatosDir, "run", "design-probes.json");
  let probes = null;
  if (existsSync(probesPath)) {
    try {
      probes = JSON.parse(readFileSync(probesPath, "utf8"));
    } catch {
      probes = null;
    }
  }
  return darkProbeGateFindings(entries, probes);
}

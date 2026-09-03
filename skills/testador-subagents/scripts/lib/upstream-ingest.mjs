import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { validateHandoff } from "./handoff-validator.mjs";

/**
 * Ingestao de upstream: descobre e le o handoff do Orquestrador (ou do
 * Pensador via upstream chain) para determinar o modo de operacao (conjunto
 * vs avulso) e coletar os insumos de validacao.
 *
 * Ordem de descoberta:
 * 1. `.orchestration/<slug>/report/handoff.json` (layout v2 do Orquestrador)
 * 2. `.orchestration/<slug>/handoff.json` (raiz, layout pre-v2)
 * 3. `.orchestration/<slug>/` scan (slug do proprio slug passado)
 * 4. Modo avulso (sem upstream)
 *
 * Ao encontrar um handoff valido, sobe a chain `upstream` ate o Pensador
 * para coletar: `prd`/`requirements-index` (modo PRD), `openspec-change`
 * (modo Spec), `api-contract`, `design-system-files`.
 *
 * Regra absoluta: NUNCA escreve em `openspec/`. NUNCA escreve nos
 * diretórios do Orquestrador ou do Pensador. Apenas le.
 */

export class UpstreamIngestError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "UpstreamIngestError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Le e valida um handoff.json num caminho absoluto. Retorna `null` se o
 * arquivo nao existir. Lanca `UpstreamIngestError` se existir mas estiver
 * quebrado ou com versao incompativel.
 */
function readHandoffSafe(path, label = path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UpstreamIngestError("HANDOFF_INVALID_JSON", `${label} contains invalid JSON: ${error.message}`, { path });
  }
  const result = validateHandoff(raw);
  if (!result.ok) {
    const first = result.errors[0];
    if (first?.code === "UNSUPPORTED_HANDOFF_VERSION") {
      return { handoff: raw, valid: false, version_mismatch: true, errors: result.errors, path };
    }
    return { handoff: raw, valid: false, version_mismatch: false, errors: result.errors, path };
  }
  return { handoff: raw, valid: true, version_mismatch: false, errors: [], path };
}

/** Caminho absoluto de um role no handoff, relativo ao `artifactRoot`. */
function artifactAbsPath(handoff, role, projectRoot) {
  const entry = handoff.artifacts?.find((a) => a.role === role);
  if (!entry) return null;
  const root = resolve(projectRoot, handoff.artifactRoot);
  // openspec-change e relativo ao projeto, nao ao artifactRoot
  if (role === "openspec-change") return resolve(projectRoot, entry.path);
  return join(root, entry.path);
}

/**
 * Sobe a chain `upstream` a partir de um handoff inicial, coletando o
 * handoff do Pensador (o topo da chain, `upstream === null`).
 * Retorna `{ pensadorHandoff, pensadorHandoffPath }` ou `null` quando nao
 * encontrado ou versao incompativel.
 */
function followUpstreamToPensador(startHandoff, projectRoot) {
  let current = startHandoff;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current.upstream === null) break; // chegou ao Pensador
    const upstreamPath = resolve(projectRoot, current.upstream.handoffPath);
    const read = readHandoffSafe(upstreamPath, upstreamPath);
    if (!read) break;
    if (!read.valid) break;
    current = read.handoff;
  }
  // `current` e o handoff mais proximo da origem que conseguimos le
  return current.stage === "pensador" ? current : null;
}

/** Descobre o slug do handoff do Orquestrador escaneando `.orchestration/`. */
function discoverOrchestradorSlugs(projectRoot) {
  const dir = join(projectRoot, ".orchestration");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Tenta ler o handoff do Orquestrador para um dado `slug`:
 * 1. `.orchestration/<slug>/report/handoff.json` (layout v2)
 * 2. `.orchestration/<slug>/handoff.json` (raiz, pre-v2)
 */
function readOrchestradorHandoff(projectRoot, slug) {
  const candidates = [
    join(projectRoot, ".orchestration", slug, "report", "handoff.json"),
    join(projectRoot, ".orchestration", slug, "handoff.json"),
  ];
  for (const path of candidates) {
    const result = readHandoffSafe(path, path);
    if (result) return result;
  }
  return null;
}

/**
 * Ponto de entrada principal. Descobre o handoff upstream e coleta os
 * insumos de validacao do fluxo inteiro.
 *
 * @param {object} options
 * @param {string} options.projectRoot  Raiz do projeto testado.
 * @param {string} [options.slug]       Slug do handoff a ingerir. Sem slug,
 *                                      varre `.orchestration/` e usa o
 *                                      unico candidato disponivel.
 * @returns {IngestResult}
 */
export function ingestUpstream(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  let slug = options.slug ?? null;

  // ---- Descoberta do handoff do Orquestrador ----

  let orchestradorRead = null;
  let discoveredSlug = slug;

  if (slug) {
    orchestradorRead = readOrchestradorHandoff(projectRoot, slug);
    if (!orchestradorRead) {
      // Slug explicito mas sem handoff => modo avulso com aviso
      return buildAvulsoResult(projectRoot, `No Orchestrador handoff found for slug "${slug}" — running in standalone mode.`);
    }
  } else {
    const slugs = discoverOrchestradorSlugs(projectRoot);
    if (slugs.length === 0) {
      return buildAvulsoResult(projectRoot, "No .orchestration/ directory found — running in standalone mode.");
    }
    if (slugs.length > 1) {
      // Varios slugs: o chamador deve confirmar via AskUserQuestion antes de
      // invocar com `slug` explicito. Aqui reportamos a ambiguidade.
      return {
        mode: "ambiguous",
        slugCandidates: slugs,
        warning: `Multiple Orchestrador slugs found (${slugs.join(", ")}); pass --slug <slug> to select one.`,
        orchestradorHandoff: null,
        pensadorHandoff: null,
        ingest: null,
      };
    }
    discoveredSlug = slugs[0];
    orchestradorRead = readOrchestradorHandoff(projectRoot, discoveredSlug);
    if (!orchestradorRead) {
      return buildAvulsoResult(projectRoot, `Could not read Orchestrador handoff for slug "${discoveredSlug}".`);
    }
  }

  // Handoff invalido ou versao incompativel => degrada para avulso
  if (!orchestradorRead.valid) {
    const warning = orchestradorRead.version_mismatch
      ? `Orchestrador handoff version mismatch — degrading to standalone mode (handoff-contract.md section 8).`
      : `Orchestrador handoff failed validation (${orchestradorRead.errors[0]?.code}) — degrading to standalone mode.`;
    return buildAvulsoResult(projectRoot, warning, { invalidHandoff: orchestradorRead });
  }

  const orchestradorHandoff = orchestradorRead.handoff;

  // ---- Upstream chain ate o Pensador ----
  const pensadorHandoff = followUpstreamToPensador(orchestradorHandoff, projectRoot);

  // ---- Coletar insumos de validacao ----
  const ingest = buildIngest(orchestradorHandoff, pensadorHandoff, projectRoot);

  return {
    mode: "joint",
    slug: discoveredSlug,
    orchestradorHandoff,
    orchestradorHandoffPath: orchestradorRead.path,
    pensadorHandoff: pensadorHandoff ?? null,
    ingest,
    warning: null,
  };
}

function buildAvulsoResult(projectRoot, warning, extras = {}) {
  return {
    mode: "standalone",
    slug: null,
    orchestradorHandoff: null,
    pensadorHandoff: null,
    ingest: {
      artifactMode: null,
      hasFrontend: null,
      hasApi: null,
      hasOpenSpec: false,
      hasOpenDesign: false,
      requirementsIndexPath: null,
      openSpecChangeName: null,
      openSpecChangePath: null,
      apiContractPath: null,
      designSystemFilesEntries: [],
      designSystemTokensPaths: [],
      designSystemDesignMdPaths: [],
      designSystemPreviewDirs: [],
    },
    warning,
    ...extras,
  };
}

function buildIngest(orchestradorHandoff, pensadorHandoff, projectRoot) {
  const mode = pensadorHandoff?.artifactMode ?? null;

  // Detectar hasFrontend / hasApi a partir do project-baseline do Pensador
  let hasFrontend = null;
  let hasApi = null;
  const baselinePath = pensadorHandoff
    ? artifactAbsPath(pensadorHandoff, "project-baseline", projectRoot)
    : null;
  if (baselinePath && existsSync(baselinePath)) {
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      hasFrontend = Boolean(baseline.hasFrontend ?? baseline.uiPackageDir);
      hasApi = Boolean(baseline.apiStyle || baseline.hasBackend || baseline.backendConfirmed);
    } catch {
      // nao parseable: deixa null, o testador derivara manualmente
    }
  }

  // OpenSpec: detecta pelo role `openspec-change` no handoff do Pensador
  let hasOpenSpec = false;
  let openSpecChangeName = null;
  let openSpecChangePath = null;
  if (pensadorHandoff) {
    const entry = pensadorHandoff.artifacts?.find((a) => a.role === "openspec-change");
    if (entry) {
      hasOpenSpec = true;
      openSpecChangePath = resolve(projectRoot, entry.path);
      openSpecChangeName = basename(openSpecChangePath) || null;
    }
  }

  // requirements-index (modo PRD)
  let requirementsIndexPath = null;
  if (pensadorHandoff && mode === "prd") {
    const p = artifactAbsPath(pensadorHandoff, "requirements-index", projectRoot);
    if (p && existsSync(p)) requirementsIndexPath = p;
  }

  // api-contract
  let apiContractPath = null;
  if (pensadorHandoff) {
    const p = artifactAbsPath(pensadorHandoff, "api-contract", projectRoot);
    if (p && existsSync(p)) apiContractPath = p;
  }

  // Open Design: coleta entradas `design-system-files` do Pensador
  const designSystemFilesEntries = [];
  const designSystemTokensPaths = [];
  const designSystemDesignMdPaths = [];
  const designSystemPreviewDirs = [];

  if (pensadorHandoff) {
    const entries = (pensadorHandoff.artifacts ?? []).filter((a) => a.role === "design-system-files");
    for (const entry of entries) {
      const absDir = join(resolve(projectRoot, pensadorHandoff.artifactRoot), entry.path);
      designSystemFilesEntries.push({
        id: entry.path.replace(/^design-systems\//, "").replace(/\/$/, ""),
        artifactDir: absDir,
        materializeInto: entry.materializeInto ?? null,
        path: entry.path,
      });
      const tokens = join(absDir, "tokens.css");
      const designMd = join(absDir, "DESIGN.md");
      const preview = join(absDir, "preview");
      if (existsSync(tokens)) designSystemTokensPaths.push(tokens);
      if (existsSync(designMd)) designSystemDesignMdPaths.push(designMd);
      if (existsSync(preview)) designSystemPreviewDirs.push(preview);
    }
  }

  const hasOpenDesign = designSystemFilesEntries.length > 0;

  return {
    artifactMode: mode,
    hasFrontend,
    hasApi,
    hasOpenSpec,
    hasOpenDesign,
    requirementsIndexPath,
    openSpecChangeName,
    openSpecChangePath,
    apiContractPath,
    designSystemFilesEntries,
    designSystemTokensPaths,
    designSystemDesignMdPaths,
    designSystemPreviewDirs,
  };
}

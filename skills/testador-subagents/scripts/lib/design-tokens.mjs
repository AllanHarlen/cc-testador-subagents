import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Parser de tokens do Open Design.
 *
 * Le `tokens.css` (fonte de verdade do estilo), `DESIGN.md` (9 secoes,
 * especialmente a §9 com anti-padroes) e `preview/` de um diretorio
 * `design-systems/<id>/`. Tambem compara a versao verbatim (no repo do
 * Pensador) com a versao materializada (em `materializeInto` do projeto).
 *
 * Read-only: nunca escreve, nunca materializa. A materializacao e trabalho
 * do Orquestrador/Executor.
 */

/** Regex para extrair custom properties de um arquivo CSS. */
const CSS_CUSTOM_PROPERTY = /--([a-zA-Z][a-zA-Z0-9-_]*):\s*([^;}\n]+)/g;

/** Secoes do DESIGN.md (9 ao todo, conforme Open Design spec). */
const DESIGN_MD_SECTION_HEADINGS = /^##\s+(.+)$/gm;

/** Anti-padroes da §9 que o testador deve verificar. */
const SECTION_9_ANTIPATTERNS_HEADING = /^##\s*(?:9|[Aa]nti.?[Pp]adr[aõ]|[Aa]nti.?[Pp]attern)/;

export class DesignTokensError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DesignTokensError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Extrai todas as custom properties de um arquivo `tokens.css`.
 * Retorna `{ tokens: Map<string,string>, raw }`.
 */
export function parseTokensCss(path) {
  if (!existsSync(path)) {
    return { tokens: new Map(), raw: null, found: false };
  }
  const raw = readFileSync(path, "utf8");
  const tokens = new Map();
  for (const match of raw.matchAll(CSS_CUSTOM_PROPERTY)) {
    tokens.set(`--${match[1]}`, match[2].trim());
  }
  return { tokens, raw, found: true };
}

/**
 * Extrai secoes do DESIGN.md. Retorna array de `{ heading, content }`.
 * A §9 (anti-padroes) e identificada por `section9`.
 */
export function parseDesignMd(path) {
  if (!existsSync(path)) {
    return { sections: [], section9: null, raw: null, found: false };
  }
  const raw = readFileSync(path, "utf8");
  const sections = [];
  let section9 = null;

  const headingRegex = /^(#{1,3})\s+(.+)$/gm;
  let match;
  const positions = [];
  while ((match = headingRegex.exec(raw)) !== null) {
    positions.push({ index: match.index, depth: match[1].length, heading: match[2], end: 0 });
  }
  for (let index = 0; index < positions.length; index += 1) {
    positions[index].end = positions[index + 1]?.index ?? raw.length;
  }

  for (const pos of positions) {
    if (pos.depth > 2) continue; // so cabecalhos de nivel 1 e 2
    const content = raw.slice(pos.index, pos.end).trim();
    const section = { heading: pos.heading, content };
    sections.push(section);
    if (SECTION_9_ANTIPATTERNS_HEADING.test(`## ${pos.heading}`)) {
      section9 = section;
    }
  }

  return { sections, section9, raw, found: true };
}

/**
 * Lista arquivos de preview disponíveis num diretorio `preview/`.
 */
function listPreviewFiles(previewDir) {
  if (!existsSync(previewDir)) return [];
  try {
    return readdirSync(previewDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(previewDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Compara dois `tokens.Map` (verbatim vs materializado) e retorna as
 * divergencias: tokens ausentes na materializada, tokens com valor diferente.
 */
export function diffTokens(verbatim, materialized) {
  const missing = [];
  const changed = [];
  for (const [name, value] of verbatim) {
    if (!materialized.has(name)) {
      missing.push({ name, verbatimValue: value });
    } else if (materialized.get(name) !== value) {
      changed.push({ name, verbatimValue: value, materializedValue: materialized.get(name) });
    }
  }
  // Tokens na materializada que nao existem no verbatim = inventados
  const invented = [];
  for (const [name] of materialized) {
    if (!verbatim.has(name)) invented.push({ name, materializedValue: materialized.get(name) });
  }
  return { missing, changed, invented };
}

/**
 * Carrega um design system completo a partir dos diretorios verbatim e
 * materializado (quando disponivel).
 *
 * @param {{ id, artifactDir, materializeInto }} entry Entrada de ingestao.
 * @param {string} projectRoot Raiz do projeto.
 * @returns {DesignSystemData}
 */
export function loadDesignSystem(entry, projectRoot) {
  const verbatimDir = entry.artifactDir;
  const materializedDir = entry.materializeInto ? join(projectRoot, entry.materializeInto) : null;

  const verbatimTokensPath = join(verbatimDir, "tokens.css");
  const verbatimDesignMdPath = join(verbatimDir, "DESIGN.md");
  const verbatimPreviewDir = join(verbatimDir, "preview");

  const verbatimTokens = parseTokensCss(verbatimTokensPath);
  const verbatimDesignMd = parseDesignMd(verbatimDesignMdPath);
  const verbatimPreviewFiles = listPreviewFiles(verbatimPreviewDir);

  let materializedTokens = { tokens: new Map(), found: false };
  let tokenDiff = null;
  let materializationDivergence = null;

  if (materializedDir && existsSync(materializedDir)) {
    const materializedTokensPath = join(materializedDir, "tokens.css");
    materializedTokens = parseTokensCss(materializedTokensPath);
    if (verbatimTokens.found && materializedTokens.found) {
      tokenDiff = diffTokens(verbatimTokens.tokens, materializedTokens.tokens);
      if (tokenDiff.missing.length > 0 || tokenDiff.changed.length > 0 || tokenDiff.invented.length > 0) {
        materializationDivergence = tokenDiff;
      }
    }
  }

  return {
    id: entry.id,
    verbatimDir,
    materializedDir,
    verbatimTokens: verbatimTokens.found ? [...verbatimTokens.tokens.entries()].map(([name, value]) => ({ name, value })) : null,
    materializedTokens: materializedTokens.found ? [...materializedTokens.tokens.entries()].map(([name, value]) => ({ name, value })) : null,
    tokenDiff,
    materializationDivergence,
    designMd: verbatimDesignMd.found ? { sections: verbatimDesignMd.sections.map((s) => s.heading), section9: verbatimDesignMd.section9?.content ?? null } : null,
    previewFiles: verbatimPreviewFiles,
    hasTokens: verbatimTokens.found,
    hasDesignMd: verbatimDesignMd.found,
    hasPreview: verbatimPreviewFiles.length > 0,
  };
}

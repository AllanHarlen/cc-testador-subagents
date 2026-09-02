import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolucao de caminho dos artefatos de uma run do Testador.
 *
 * Layout agrupado por estagio (`plan/`, `run/`, `review/`, `report/`,
 * `evidence/`), no mesmo espirito do layout 2 do `cc-executor-subagents`.
 * Este plugin nasce ja nesse layout — nao ha layout 1 legado aqui.
 *
 * `state.json`, `events.jsonl`, `.state.lock`, `handoff.json` e
 * `ingested-baseline.md` permanecem **sempre** na raiz de `artefatos_dir`:
 * os tres primeiros porque a descoberta de run (`findRunDirectory`, `resume`)
 * depende disso; os dois ultimos porque `references/handoff-contract.md`
 * (byte-identico nos quatro plugins da cadeia) nomeia esses caminhos
 * literalmente como relativos a raiz da pasta de artefatos.
 */

export const ARTIFACT_LAYOUT_VERSION = 2;

export const LAYOUT_ROOT_FILES = Object.freeze([
  "state.json",
  "events.jsonl",
  ".state.lock",
  "handoff.json",
  "ingested-baseline.md",
]);

export const LAYOUT_FILE_DIRECTORIES = Object.freeze({
  "test-plan.md": "plan",
  "coverage-matrix.json": "plan",
  "flow-map.json": "plan",
  "monitoring.md": "run",
  "test-report.md": "review",
  "a11y-report.md": "review",
  "uiux-report.md": "review",
  "coverage-report.md": "review",
  "design-conformance.json": "review",
  "implementation-report.md": "report",
  "workflow-log.md": "report",
  "subagents-context.md": "report",
});

const LAYOUT_TREE_DIRECTORIES = Object.freeze({
  evidence: "evidence",
  specs: "run/specs",
  "playwright-report": "run/playwright-report",
  screenshots: "review/screenshots",
});

const LAYOUT_DIRECTORIES = Object.freeze([
  "plan",
  "run",
  "run/specs",
  "run/playwright-report",
  "review",
  "review/screenshots",
  "report",
  "evidence",
]);

function toAbsolute(artifactDir, relativePath) {
  return join(resolve(artifactDir), ...String(relativePath).split("/"));
}

/** Nome canonico -> caminho relativo dentro do diretorio da run. */
export function artifactRelativePath(name) {
  const file = String(name);
  if (LAYOUT_ROOT_FILES.includes(file)) return file;
  const directory = LAYOUT_FILE_DIRECTORIES[file];
  return directory ? `${directory}/${file}` : file;
}

/** Chave de arvore (`evidence`, `specs`, ...) -> caminho relativo. */
export function artifactTreeRelativePath(key) {
  return LAYOUT_TREE_DIRECTORIES[String(key)] ?? String(key);
}

export function artifactLayoutDirectories() {
  return [...LAYOUT_DIRECTORIES];
}

export function artifactWritePath(artifactDir, name) {
  const relativePath = artifactRelativePath(name);
  return { relativePath, path: toAbsolute(artifactDir, relativePath) };
}

export function resolveArtifact(artifactDir, name) {
  const candidate = artifactWritePath(artifactDir, name);
  return existsSync(candidate.path) ? candidate : null;
}

export function artifactExists(artifactDir, name) {
  return resolveArtifact(artifactDir, name) != null;
}

export function artifactTreePath(artifactDir, key) {
  const relativePath = artifactTreeRelativePath(key);
  return { relativePath, path: toAbsolute(artifactDir, relativePath) };
}

export function ensureArtifactLayout(artifactDir) {
  const root = resolve(artifactDir);
  mkdirSync(root, { recursive: true });
  for (const directory of artifactLayoutDirectories()) {
    mkdirSync(join(root, ...directory.split("/")), { recursive: true });
  }
  return root;
}

/** Le `state.json` (se existir) apenas para checagens leves que nao precisam do modulo de estado completo. */
export function peekStateSnapshot(artifactDir) {
  const path = join(resolve(artifactDir), "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

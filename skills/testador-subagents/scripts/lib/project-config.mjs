import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Fonte da verdade da Project_Config do Testador: campos, valores permitidos,
 * formato do arquivo e derivacoes.
 *
 * Diferente do `cc-executor-subagents` (papeis de agente: backendExecutor,
 * frontendExecutor, ...), a Project_Config do Testador guarda configuracao de
 * *teste* — o stack de agentes e fixo (Claude Code puro, sem Codex/AGY).
 *
 * Gramatica canonica do arquivo `.testador/project-config.md`:
 *
 *   # TESTADOR PROJECT CONFIG
 *
 *   > <linha de contexto>
 *
 *   - **schemaVersion**: 1
 *   - **updatedAt**: 2026-02-14T18:05:31Z
 *   - **baseUrl**: http://localhost:5173
 *   - **apiBaseUrl**: http://localhost:3000
 *   - **startCommand**: docker compose up --build
 *   - **readyTimeoutSeconds**: 120
 *   - **wcagTags**: wcag2a,wcag2aa,wcag21a,wcag21aa
 *   - **a11yBlocking**: false
 *   - **viewports**: 390x844,1440x900
 *   - **seedCredentialsRef**: .env.test
 *   - **serverLifecycle**: auto
 *   - **specMode**: hybrid
 *
 *   ## Notas
 *
 *   - a11yBlocking: default-aplicado
 *
 * Os campos aparecem exatamente uma vez cada, na ordem acima, em linha de
 * lista com o nome do campo em negrito. A secao `## Notas` so existe quando
 * algum campo teve default aplicado. `seedCredentialsRef` guarda uma
 * REFERENCIA (ex: nome de arquivo .env), nunca um valor de credencial —
 * regra de seguranca documentada, nao imposta por este parser.
 *
 * Leitura tolerante (espacamento, ordem, BOM, CRLF, backtick/aspas), estrita
 * em conteudo (campo ausente, valor fora do conjunto permitido,
 * `schemaVersion` acima do suportado -> `ProjectConfigError` com codigo
 * dedicado).
 */

export const PROJECT_CONFIG_SCHEMA_VERSION = 1;

export const SERVER_LIFECYCLE_VALUES = Object.freeze(["auto", "python", "node"]);
export const SPEC_MODE_VALUES = Object.freeze(["hybrid"]);
export const WCAG_TAG_VALUES = Object.freeze([
  "wcag2a",
  "wcag2aa",
  "wcag2aaa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
]);

/** Ordem canonica das linhas de campo do Project_Config_File. */
export const PROJECT_CONFIG_FIELDS = Object.freeze([
  "schemaVersion",
  "updatedAt",
  "baseUrl",
  "apiBaseUrl",
  "startCommand",
  "readyTimeoutSeconds",
  "wcagTags",
  "a11yBlocking",
  "viewports",
  "seedCredentialsRef",
  "serverLifecycle",
  "specMode",
]);

/** Campos alem de schemaVersion/updatedAt — os que podem receber default e entrar em `## Notas`. */
export const CONFIGURABLE_FIELDS = Object.freeze(PROJECT_CONFIG_FIELDS.slice(2));

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  baseUrl: "http://localhost:3000",
  apiBaseUrl: "",
  startCommand: "",
  readyTimeoutSeconds: 120,
  wcagTags: "wcag2a,wcag2aa,wcag21a,wcag21aa",
  a11yBlocking: false,
  viewports: "390x844,1440x900",
  seedCredentialsRef: "",
  serverLifecycle: "auto",
  specMode: "hybrid",
});

export const PROJECT_CONFIG_DIRECTORY = ".testador";
export const PROJECT_CONFIG_FILENAME = "project-config.md";
export const PROJECT_CONFIG_RELATIVE_PATH = `${PROJECT_CONFIG_DIRECTORY}/${PROJECT_CONFIG_FILENAME}`;
export const PROJECT_CONFIG_DEFAULT_APPLIED_MARK = "default-aplicado";

const PROJECT_CONFIG_TITLE = "# TESTADOR PROJECT CONFIG";
const PROJECT_CONFIG_LEAD = "> Configuracao de teste do projeto. Gerada e lida por /testador project-config.";
const PROJECT_CONFIG_NOTES_HEADING = "## Notas";

const UPDATED_AT_FORMAT = "YYYY-MM-DDTHH:MM:SSZ";
const UPDATED_AT_CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UPDATED_AT_ACCEPTED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const FIELD_LINE = /^[\t ]*[-*+][\t ]*\*\*[\t ]*([A-Za-z][A-Za-z0-9_-]*)[\t ]*\*\*[\t ]*:[\t ]*(.*)$/;
const NOTE_LINE = /^[\t ]*[-*+][\t ]*([A-Za-z][A-Za-z0-9_-]*)[\t ]*:[\t ]*(.*)$/;
const VIEWPORT_ENTRY = /^\d+x\d+$/i;

const FIELD_BY_LOWERCASE = new Map(PROJECT_CONFIG_FIELDS.map((field) => [field.toLowerCase(), field]));
const CONFIGURABLE_BY_LOWERCASE = new Map(CONFIGURABLE_FIELDS.map((field) => [field.toLowerCase(), field]));

export class ProjectConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
    this.details = details;
  }
}

export function projectConfigPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot ?? "."), PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FILENAME);
}

function fieldMissing(field, path) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_FIELD_MISSING",
    `Project config field "${field}" is missing in ${path}`,
    { field, path },
  );
}

function invalidValue(field, received, path, accepted) {
  const acceptedList = Array.isArray(accepted) ? accepted : [accepted];
  return new ProjectConfigError(
    "PROJECT_CONFIG_INVALID_VALUE",
    `Project config field "${field}" in ${path} has invalid value ${JSON.stringify(String(received))}; `
      + `accepted: ${acceptedList.join(", ")}`,
    { field, path, received, accepted: acceptedList },
  );
}

function unparseable(path, reason) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_UNPARSEABLE",
    `Project config file ${path} is unparseable: ${reason}`,
    { path, reason },
  );
}

function schemaUnsupported(received, path) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_SCHEMA_UNSUPPORTED",
    `Project config file ${path} declares schemaVersion ${received}, but this plugin supports `
      + `up to ${PROJECT_CONFIG_SCHEMA_VERSION}`,
    { field: "schemaVersion", path, received, accepted: [PROJECT_CONFIG_SCHEMA_VERSION] },
  );
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function cleanValue(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"']+$/, "")
    .trim();
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!UPDATED_AT_ACCEPTED.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatInstant(value, field, path) {
  const date = toDate(value);
  if (!date) throw invalidValue(field, value, path, [UPDATED_AT_FORMAT]);
  const formatted = `${date.toISOString().slice(0, 19)}Z`;
  if (!UPDATED_AT_CANONICAL.test(formatted)) throw invalidValue(field, value, path, [UPDATED_AT_FORMAT]);
  return formatted;
}

function normalizeSchemaVersion(value, path) {
  if (value === undefined || value === null || value === "") return PROJECT_CONFIG_SCHEMA_VERSION;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw invalidValue("schemaVersion", value, path, [String(PROJECT_CONFIG_SCHEMA_VERSION)]);
  }
  if (parsed > PROJECT_CONFIG_SCHEMA_VERSION) throw schemaUnsupported(parsed, path);
  return parsed;
}

function normalizeUrlLike(field, value, path, { allowEmpty }) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (text === "") {
    if (allowEmpty) return "";
    throw fieldMissing(field, path);
  }
  return text;
}

function normalizeStringLike(field, value, path, { allowEmpty }) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (text === "" && !allowEmpty) throw fieldMissing(field, path);
  return text;
}

function normalizePositiveInteger(field, value, path) {
  if (value === undefined || value === null || String(value).trim() === "") throw fieldMissing(field, path);
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalidValue(field, value, path, ["positive integer"]);
  return parsed;
}

function normalizeBoolean(field, value, path) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "1"].includes(text)) return true;
  if (["false", "no", "0"].includes(text)) return false;
  throw invalidValue(field, value, path, ["true", "false"]);
}

function normalizeCommaList(field, value, path, { validEntry, accepted }) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (text === "") throw fieldMissing(field, path);
  const entries = text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) throw fieldMissing(field, path);
  for (const entry of entries) {
    if (!validEntry(entry)) throw invalidValue(field, entry, path, accepted);
  }
  return entries.join(",");
}

function normalizeEnum(field, value, path, allowed) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!allowed.includes(text)) throw invalidValue(field, value, path, allowed);
  return text;
}

/** Normaliza uma Project_Config em memoria: os doze campos canonicos mais `defaultsApplied`. */
function normalizeProjectConfig(config, { now, path } = {}) {
  const target = path ?? PROJECT_CONFIG_RELATIVE_PATH;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw invalidValue("config", config === null ? "null" : typeof config, target, ["object"]);
  }
  const instant = now ?? config.updatedAt ?? new Date();
  const normalized = {
    schemaVersion: normalizeSchemaVersion(config.schemaVersion, target),
    updatedAt: formatInstant(instant, "updatedAt", target),
    baseUrl: normalizeUrlLike("baseUrl", config.baseUrl, target, { allowEmpty: false }),
    apiBaseUrl: normalizeUrlLike("apiBaseUrl", config.apiBaseUrl, target, { allowEmpty: true }),
    startCommand: normalizeStringLike("startCommand", config.startCommand, target, { allowEmpty: true }),
    readyTimeoutSeconds: normalizePositiveInteger("readyTimeoutSeconds", config.readyTimeoutSeconds, target),
    wcagTags: normalizeCommaList("wcagTags", config.wcagTags, target, {
      validEntry: (entry) => WCAG_TAG_VALUES.includes(entry.toLowerCase()),
      accepted: WCAG_TAG_VALUES,
    }),
    a11yBlocking: normalizeBoolean("a11yBlocking", config.a11yBlocking, target),
    viewports: normalizeCommaList("viewports", config.viewports, target, {
      validEntry: (entry) => VIEWPORT_ENTRY.test(entry),
      accepted: ["WIDTHxHEIGHT (e.g. 390x844)"],
    }),
    seedCredentialsRef: normalizeStringLike("seedCredentialsRef", config.seedCredentialsRef, target, { allowEmpty: true }),
    serverLifecycle: normalizeEnum("serverLifecycle", config.serverLifecycle, target, SERVER_LIFECYCLE_VALUES),
    specMode: normalizeEnum("specMode", config.specMode, target, SPEC_MODE_VALUES),
  };
  normalized.defaultsApplied = normalizeDefaultsApplied(config.defaultsApplied, target);
  return normalized;
}

function normalizeDefaultsApplied(value, path) {
  if (value === undefined || value === null || value === "") return [];
  const entries = Array.isArray(value) ? value : String(value).split(",");
  const selected = new Set();
  for (const entry of entries) {
    const normalized = String(entry ?? "").trim().toLowerCase();
    if (normalized === "") continue;
    const field = CONFIGURABLE_BY_LOWERCASE.get(normalized);
    if (!field) throw invalidValue("defaultsApplied", String(entry).trim(), path, CONFIGURABLE_FIELDS);
    selected.add(field);
  }
  return CONFIGURABLE_FIELDS.filter((field) => selected.has(field));
}

/**
 * Serializa uma Project_Config no formato canonico do Project_Config_File.
 * Deterministico dado `config` + `options.now`.
 */
export function renderProjectConfig(config, options = {}) {
  const normalized = normalizeProjectConfig(config, { now: options.now, path: options.path });
  const lines = [
    PROJECT_CONFIG_TITLE,
    "",
    PROJECT_CONFIG_LEAD,
    "",
    `- **schemaVersion**: ${normalized.schemaVersion}`,
    `- **updatedAt**: ${normalized.updatedAt}`,
    ...CONFIGURABLE_FIELDS.map((field) => `- **${field}**: ${normalized[field]}`),
  ];
  if (normalized.defaultsApplied.length > 0) {
    lines.push(
      "",
      PROJECT_CONFIG_NOTES_HEADING,
      "",
      ...normalized.defaultsApplied.map((field) => `- ${field}: ${PROJECT_CONFIG_DEFAULT_APPLIED_MARK}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Le o conteudo de um Project_Config_File e devolve a Project_Config.
 */
export function parseProjectConfig(content, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  const text = stripBom(String(content ?? "")).replace(/\r\n?/g, "\n");

  const fields = new Map();
  const notes = new Set();

  for (const rawLine of text.split("\n")) {
    const fieldMatch = rawLine.match(FIELD_LINE);
    if (fieldMatch) {
      const field = FIELD_BY_LOWERCASE.get(fieldMatch[1].toLowerCase());
      if (!field) continue;
      const value = cleanValue(fieldMatch[2]);
      const previous = fields.get(field);
      if (previous !== undefined && previous.toLowerCase() !== value.toLowerCase()) {
        throw invalidValue(field, `${previous} | ${value}`, path, ["single occurrence"]);
      }
      fields.set(field, value);
      continue;
    }
    const noteMatch = rawLine.match(NOTE_LINE);
    if (noteMatch && cleanValue(noteMatch[2]).toLowerCase() === PROJECT_CONFIG_DEFAULT_APPLIED_MARK) {
      const field = CONFIGURABLE_BY_LOWERCASE.get(noteMatch[1].toLowerCase());
      if (field) notes.add(field);
    }
  }

  if (fields.size === 0) {
    throw unparseable(path, 'no recognizable "- **field**: value" line was found');
  }

  const rawSchemaVersion = fields.get("schemaVersion");
  if (rawSchemaVersion === undefined || rawSchemaVersion === "") throw fieldMissing("schemaVersion", path);
  const schemaVersion = normalizeSchemaVersion(rawSchemaVersion, path);

  const rawUpdatedAt = fields.get("updatedAt");
  if (rawUpdatedAt === undefined || rawUpdatedAt === "") throw fieldMissing("updatedAt", path);

  const parsed = {
    schemaVersion,
    updatedAt: formatInstant(rawUpdatedAt, "updatedAt", path),
    baseUrl: normalizeUrlLike("baseUrl", fields.get("baseUrl"), path, { allowEmpty: false }),
    apiBaseUrl: normalizeUrlLike("apiBaseUrl", fields.get("apiBaseUrl"), path, { allowEmpty: true }),
    startCommand: normalizeStringLike("startCommand", fields.get("startCommand"), path, { allowEmpty: true }),
    readyTimeoutSeconds: normalizePositiveInteger("readyTimeoutSeconds", fields.get("readyTimeoutSeconds"), path),
    wcagTags: normalizeCommaList("wcagTags", fields.get("wcagTags"), path, {
      validEntry: (entry) => WCAG_TAG_VALUES.includes(entry.toLowerCase()),
      accepted: WCAG_TAG_VALUES,
    }),
    a11yBlocking: normalizeBoolean("a11yBlocking", fields.get("a11yBlocking"), path),
    viewports: normalizeCommaList("viewports", fields.get("viewports"), path, {
      validEntry: (entry) => VIEWPORT_ENTRY.test(entry),
      accepted: ["WIDTHxHEIGHT (e.g. 390x844)"],
    }),
    seedCredentialsRef: normalizeStringLike("seedCredentialsRef", fields.get("seedCredentialsRef"), path, { allowEmpty: true }),
    serverLifecycle: normalizeEnum("serverLifecycle", fields.get("serverLifecycle"), path, SERVER_LIFECYCLE_VALUES),
    specMode: normalizeEnum("specMode", fields.get("specMode"), path, SPEC_MODE_VALUES),
  };
  parsed.defaultsApplied = CONFIGURABLE_FIELDS.filter((field) => notes.has(field));
  return parsed;
}

function readFailed(path, error) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_READ_FAILED",
    `Project config file ${path} could not be read: ${error?.message ?? String(error)}`,
    { path, reason: error?.message ?? String(error), cause: error?.code ?? null },
  );
}

function writeFailed(path, error) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_WRITE_FAILED",
    `Project config file ${path} could not be written: ${error?.message ?? String(error)}`,
    { path, reason: error?.message ?? String(error), cause: error?.code ?? null },
  );
}

/** Project_Config padrao em memoria. `updatedAt: null` porque nada foi gravado ainda. */
export function defaultProjectConfig() {
  return {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    updatedAt: null,
    ...DEFAULT_PROJECT_CONFIG,
    defaultsApplied: [],
  };
}

/**
 * Le o Project_Config_File da raiz do projeto.
 * - Ausente: `{ exists: false, source: "default", path, config }`.
 * - Presente e valido: `{ exists: true, source: "file", path, config }`.
 * - Presente e invalido: propaga `ProjectConfigError`. Nunca altera o arquivo.
 */
export function readProjectConfig(projectRoot = process.cwd()) {
  const path = projectConfigPath(projectRoot);
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, source: "default", path, config: defaultProjectConfig() };
    }
    throw readFailed(path, error);
  }
  return { exists: true, source: "file", path, config: parseProjectConfig(content, { path }) };
}

/**
 * Grava o Project_Config_File em `<projectRoot>/.testador/project-config.md`.
 * Escreve por arquivo temporario + rename: falha de I/O nunca deixa o
 * arquivo anterior truncado ou meio gravado.
 */
export function writeProjectConfig(projectRoot, config, options = {}) {
  const path = projectConfigPath(projectRoot);
  const content = renderProjectConfig(config, { now: options.now, path });
  const persisted = parseProjectConfig(content, { path });

  const directory = dirname(path);
  let temporary = null;
  try {
    mkdirSync(directory, { recursive: true });
    temporary = join(directory, `.${PROJECT_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    temporary = null;
  } catch (error) {
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // Temporario orfao nao invalida o arquivo anterior.
      }
    }
    throw writeFailed(path, error);
  }

  return { path, content, config: persisted };
}

/**
 * Resolve as respostas da coleta em uma Project_Config completa. Campo sem
 * resposta recebe o default de `DEFAULT_PROJECT_CONFIG` e entra em
 * `defaultsApplied`.
 */
export function applyProjectConfigDefaults(answers = {}, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw invalidValue("answers", answers === null ? "null" : typeof answers, path, ["object"]);
  }

  const resolved = {};
  const applied = new Set(normalizeDefaultsApplied(answers.defaultsApplied, path));
  for (const field of CONFIGURABLE_FIELDS) {
    const answer = answers[field];
    if (answer === undefined || answer === null || String(answer).trim() === "") {
      resolved[field] = DEFAULT_PROJECT_CONFIG[field];
      applied.add(field);
      continue;
    }
    resolved[field] = answer;
  }

  const instant = options.now ?? answers.updatedAt ?? null;
  const draft = {
    schemaVersion: answers.schemaVersion,
    updatedAt: instant,
    ...resolved,
    defaultsApplied: CONFIGURABLE_FIELDS.filter((field) => applied.has(field)),
  };
  // Reusa a normalizacao completa para validar tudo de uma vez; `updatedAt`
  // nulo (nenhum instante informado) e o unico caso especial preservado.
  if (instant === null) {
    const normalized = normalizeProjectConfig({ ...draft, updatedAt: new Date() }, { path });
    return { ...normalized, updatedAt: null };
  }
  return normalizeProjectConfig(draft, { path });
}

/**
 * Campos configuraveis divergentes entre duas Project_Config (`null` ->
 * tratado como "todos os defaults"). Vazio quando nada mudou.
 */
export function diffProjectConfig(left, right) {
  const a = left ?? defaultProjectConfig();
  const b = right ?? defaultProjectConfig();
  const changed = {};
  for (const field of CONFIGURABLE_FIELDS) {
    if (String(a[field]) !== String(b[field])) changed[field] = { from: a[field], to: b[field] };
  }
  return changed;
}

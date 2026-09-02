import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
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
 * `.testador/checkpoint.json` como INDICE, nao estado detalhado por-run — o
 * detalhe vive em `{artefatos_dir}/state.json` + `events.jsonl`, gerenciado
 * por `testador-state.mjs`.
 *
 * Porte de `cc-executor-subagents/.../lib/checkpoint-index.mjs`. Sem os dois
 * campos `plano_predefinido`/`plano_predefinido_fonte` do executor — o
 * Testador nao trabalha sobre um "plano" do usuario, ele valida uma entrega;
 * a nocao equivalente (baseline de ingestao) vive em
 * `historico[].baseline_fonte`, dentro de cada entrada, nao como campo
 * global do indice.
 */

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_DIRECTORY = ".testador";
export const CHECKPOINT_FILENAME = "checkpoint.json";
export const CHECKPOINT_RELATIVE_PATH = `${CHECKPOINT_DIRECTORY}/${CHECKPOINT_FILENAME}`;

export class CheckpointIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CheckpointIndexError";
    this.code = code;
    this.details = details;
  }
}

export function checkpointPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot ?? "."), CHECKPOINT_DIRECTORY, CHECKPOINT_FILENAME);
}

function freshIndex() {
  return {
    version: String(CHECKPOINT_SCHEMA_VERSION),
    execucao_atual: "",
    historico: [],
  };
}

function isCurrentShaped(raw) {
  return raw != null && typeof raw === "object" && String(raw.version ?? "") === String(CHECKPOINT_SCHEMA_VERSION);
}

/** Le o indice. Nunca escreve o arquivo — gravacao e sempre uma acao explicita de `writeCheckpointIndex`. */
export function readCheckpointIndex(projectRoot = process.cwd()) {
  const path = checkpointPath(projectRoot);
  if (!existsSync(path)) {
    return { exists: false, path, index: freshIndex(), migrationNotes: [] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CheckpointIndexError(
      "CHECKPOINT_UNPARSEABLE",
      `Checkpoint file ${path} is not valid JSON: ${error.message}`,
      { path },
    );
  }
  if (isCurrentShaped(raw)) {
    return {
      exists: true,
      path,
      index: {
        version: String(CHECKPOINT_SCHEMA_VERSION),
        execucao_atual: String(raw.execucao_atual ?? ""),
        historico: Array.isArray(raw.historico) ? raw.historico : [],
      },
      migrationNotes: [],
    };
  }
  // Formato desconhecido: preserva execucao_atual/historico se existirem, sem inventar campo.
  return {
    exists: true,
    path,
    index: {
      version: String(CHECKPOINT_SCHEMA_VERSION),
      execucao_atual: String(raw?.execucao_atual ?? ""),
      historico: Array.isArray(raw?.historico) ? raw.historico : [],
    },
    migrationNotes: ["checkpoint file was not in the expected v1 shape; unrecognized fields were dropped"],
  };
}

/** Grava o indice de forma atomica (arquivo temporario + fsync + rename). */
export function writeCheckpointIndex(projectRoot, index, options = {}) {
  const path = checkpointPath(projectRoot);
  const directory = dirname(path);
  const payload = {
    version: String(CHECKPOINT_SCHEMA_VERSION),
    execucao_atual: String(index.execucao_atual ?? ""),
    historico: Array.isArray(index.historico) ? index.historico : [],
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  let temporary = null;
  try {
    mkdirSync(directory, { recursive: true });
    temporary = join(directory, `.${CHECKPOINT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
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
        // Temporary orphan does not invalidate the previous file.
      }
    }
    throw new CheckpointIndexError(
      "CHECKPOINT_WRITE_FAILED",
      `Checkpoint file ${path} could not be written: ${error.message}`,
      { path, reason: error.message },
    );
  }

  return { path, content, index: payload, now: options.now };
}

/**
 * Adiciona ou atualiza uma entrada de `historico[]` pelo `artefatos_dir`, e
 * opcionalmente aponta `execucao_atual` para ela (ativa) ou limpa
 * `execucao_atual` (entrada terminal que era a execucao ativa).
 */
export function upsertRunEntry(index, entry, options = {}) {
  if (!entry?.artefatos_dir) {
    throw new CheckpointIndexError("CHECKPOINT_INVALID_ENTRY", "entry.artefatos_dir is required");
  }
  const historico = Array.isArray(index.historico) ? [...index.historico] : [];
  const position = historico.findIndex((item) => item.artefatos_dir === entry.artefatos_dir);
  if (position >= 0) historico[position] = { ...historico[position], ...entry };
  else historico.push(entry);

  const active = options.active === true;
  const execucao_atual = active
    ? entry.artefatos_dir
    : index.execucao_atual === entry.artefatos_dir
      ? ""
      : index.execucao_atual ?? "";

  return { ...index, historico, execucao_atual };
}

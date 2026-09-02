#!/usr/bin/env node
/**
 * CLI de montagem do arquivo de probe usado por
 * `testador-state.mjs reconcile|resume --probe-file <json>`.
 *
 * Diferente do Executor (multi-agente, com adaptadores por executor externo
 * -- Codex/AGY), o Testador e Claude Code puro: nao ha processo externo para
 * sondar. O probe aqui normaliza a saida que o proprio agente/subagente
 * relatou sobre uma task (exploracao MCP, execucao determinística, review
 * de UI/UX, review do laudo) no shape exato que `testador-state.mjs`
 * documenta em `probeFileShape` -- sem inferencia heuristica de status a
 * partir de texto livre.
 *
 * Uso:
 *   testador-probe.mjs --task <id> --status <DONE|RUNNING|FAILED|BLOCKED|STALLED|CANCELLED|UNKNOWN>
 *     [--produced-file path]... [--last-activity-at iso] [--output path]
 *   testador-probe.mjs --input <probe-set.json> [--output path]
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { executeJsonCli, parseArgs, readJsonFile, required } from "./lib/cli-utils.mjs";

const CANONICAL_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
]);

export class ProbeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ProbeError";
    this.code = code;
    this.details = details;
  }
}

function normalizeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function normalizeValidations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { command: entry, status: "UNKNOWN" };
    return {
      command: String(entry.command ?? entry.name ?? "validation"),
      status: String(entry.status ?? (entry.passed === true ? "PASS" : entry.passed === false ? "FAIL" : "UNKNOWN")).toUpperCase(),
    };
  });
}

/**
 * Normaliza uma entrada bruta de task para o shape canonico do probe.
 * Status deve ser um dos valores canonicos (mesmo vocabulario do
 * `testador-state.mjs`); nao ha heuristica de inferencia a partir de texto
 * livre -- entrada ambigua vira `UNKNOWN` explicito, nunca um chute.
 */
export function normalizeProbeTask(raw) {
  const rawStatus = String(raw?.executorStatus ?? raw?.status ?? "UNKNOWN").trim().toUpperCase();
  const status = CANONICAL_STATUSES.has(rawStatus) ? rawStatus : "UNKNOWN";
  return {
    executorStatus: status,
    lastActivityAt: raw?.lastActivityAt ?? raw?.last_activity_at ?? null,
    producedFiles: normalizeList(raw?.producedFiles ?? raw?.produced_files),
    validations: normalizeValidations(raw?.validations ?? raw?.checks),
  };
}

export function normalizeProbeSet(input) {
  if (!input || typeof input !== "object") {
    throw new ProbeError("INVALID_PROBE_INPUT", "Probe input must be an object");
  }
  const source = input.tasks ?? input;
  const tasks = {};
  for (const [taskId, raw] of Object.entries(source)) {
    tasks[String(taskId)] = normalizeProbeTask(raw);
  }
  return { schemaVersion: 1, tasks };
}

function writeAtomic(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, absolute);
  return absolute;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args._[0] === "help" || args.help) {
    return {
      name: "testador-probe",
      commands: {
        single: "testador-probe.mjs --task <id> --status <canonical-status> [--produced-file path]... [--last-activity-at iso] [--output path]",
        batch: "testador-probe.mjs --input <probe-set.json> [--output path]",
      },
      canonicalStatuses: [...CANONICAL_STATUSES],
    };
  }

  let probe;
  if (args.input) {
    probe = normalizeProbeSet(readJsonFile(args.input));
  } else {
    const taskId = required(args, "task");
    const status = required(args, "status");
    probe = {
      schemaVersion: 1,
      tasks: {
        [String(taskId)]: normalizeProbeTask({
          executorStatus: status,
          lastActivityAt: args["last-activity-at"],
          producedFiles: args["produced-file"],
          validations: args.validations ? JSON.parse(String(args.validations)) : undefined,
        }),
      },
    };
  }

  return { probe, output: args.output ? writeAtomic(args.output, probe) : null };
}

executeJsonCli(main);

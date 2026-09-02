#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  COMPLETION_GATE_DEFINITIONS,
  TestadorStateError,
  findRunDirectory,
  heartbeatTask,
  initRun,
  reconcileRunAtDirectory,
  registerTask,
  resumeRunAtDirectory,
  statusRun,
  sweepStalledTasks,
  updateCompletionGate,
  updatePhase,
  updateRunStatus,
  updateTaskStatus,
  verifyRun,
} from "./lib/testador-state.mjs";

/**
 * CLI de `testador-state.mjs` (`node "${CLAUDE_SKILL_DIR}/scripts/testador-state.mjs" <comando>`).
 *
 * Camada fina sobre `lib/testador-state.mjs`: nenhuma regra de estado nasce
 * aqui. Contrato de saida: `{ ok: true, ... }` em stdout, ou
 * `{ ok: false, error: { code, message, details } }` em stderr. Exit 2 para
 * `RUN_NOT_FOUND`/`MISSING_ARGUMENT`, exit 1 para o resto.
 */

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : token.slice(equals + 1);
    if (value === undefined && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) value = true;
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function required(args, key, fallback = undefined) {
  const value = args[key] ?? fallback;
  if (value === undefined || value === "" || value === true) {
    throw new TestadorStateError("MISSING_ARGUMENT", `Missing value for required argument --${key}`);
  }
  return value;
}

function number(value, fallback = undefined) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TestadorStateError("INVALID_NUMBER", `Expected a number, received ${value}`);
  return parsed;
}

function bool(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "yes", "1"].includes(String(value).toLowerCase())) return true;
  if (["false", "no", "0"].includes(String(value).toLowerCase())) return false;
  throw new TestadorStateError("INVALID_BOOLEAN", `Expected a boolean, received ${value}`);
}

function commonOptions(args) {
  return {
    actor: args.actor ?? "testador",
    projectRoot: args.root ?? process.cwd(),
    probeFile: args["probe-file"],
    now: args.now,
    staleIdleSeconds: number(args["stale-idle-seconds"]),
    staleInToolSeconds: number(args["stale-in-tool-seconds"]),
    stallGraceSeconds: number(args["stall-grace-seconds"]),
  };
}

function taskOptions(args) {
  const validations = args["validations-file"] ? JSON.parse(readFileSync(args["validations-file"], "utf8")) : undefined;
  return {
    ...commonOptions(args),
    executor: args.executor,
    executorSource: args["executor-source"],
    model: args.model,
    sessionId: args["session-id"],
    conversationId: args["conversation-id"],
    commitBefore: args["commit-before"],
    commitAfter: args["commit-after"],
    reasonCode: args["reason-code"],
    reason: args.reason,
    currentTool: args["current-tool"],
    inTool: bool(args["in-tool"]),
    apiCalls: number(args["api-calls"]),
    toolCalls: number(args["tool-calls"]),
    expectedFiles: args["expected-file"],
    producedFiles: args["produced-file"],
    evidence: args.evidence,
    validations,
    newAttempt: bool(args["new-attempt"]),
  };
}

function artifactDir(args, options = {}) {
  if (args.dir) return args.dir;
  return findRunDirectory({ projectRoot: args.root ?? process.cwd(), runId: options.positionalRunId });
}

function help() {
  return {
    name: "testador-state",
    purpose: "Durable per-run state machine for cc-testador-subagents",
    commands: {
      init: "init [--slug <slug>] --dir <artefatos_dir> [--phase 0]",
      "task register": "task register --dir <dir> --task <id> [--title text] [--expected-file path]... [--allowed-path glob]...",
      task: "task --dir <dir> --task <id> --status <canonical-status> [session/evidence fields]",
      heartbeat: "heartbeat --dir <dir> --task <id> [--api-calls N] [--tool-calls N] [--current-tool name]",
      sweep: "sweep --dir <dir> [--stale-idle-seconds 450] [--stale-in-tool-seconds 1200] [--stall-grace-seconds 120]",
      phase: "phase --dir <dir> --phase <n> --status RUNNING|DONE|FAILED|BLOCKED|CANCELLED|UNKNOWN",
      gate: "gate --dir <dir> --gate stack|smoke|deterministic|a11y|uiux|spec-coverage|reports --status PENDING|DONE|BLOCKED|N/A [--required bool] [--evidence id]... [--reason text]",
      reconcile: "reconcile --dir <dir> [--probe-file <json>]",
      resume: "resume [--dir <dir>] [--root <project>] [--probe-file <json>]",
      run: "run --dir <dir> --status RUNNING|DONE|FAILED|BLOCKED|STALLED|CANCELLED|UNKNOWN",
      status: "status [--dir <dir>] [--root <project>]",
      verify: "verify --dir <dir>",
    },
    completionGateDefinitions: COMPLETION_GATE_DEFINITIONS,
    probeFileShape: {
      tasks: {
        "mcp-explorer": {
          executorStatus: "DONE | RUNNING | FAILED | BLOCKED | STALLED | CANCELLED | UNKNOWN",
          lastActivityAt: "ISO-8601",
          producedFiles: ["relative/path"],
          validations: [{ command: "test command", status: "PASS | FAIL" }],
        },
      },
    },
  };
}

function execute(argv) {
  const [command = "help", subcommand, ...rest] = argv;
  const isTaskRegister = command === "task" && subcommand === "register";
  const args = parseArgs(isTaskRegister ? rest : argv.slice(1));
  const common = commonOptions(args);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "init":
      return initRun({
        ...common,
        slug: args.slug,
        artifactDir: required(args, "dir"),
        runId: args["run-id"],
        phase: number(args.phase, 0),
        lastSafePhase: number(args["last-safe-phase"]),
      });
    case "task":
      if (isTaskRegister) {
        return registerTask(artifactDir(args), required(args, "task"), {
          title: args.title,
          expectedFiles: args["expected-file"],
          validationPlan: args["validation-plan"],
          allowedPaths: args["allowed-path"],
        }, common);
      }
      return updateTaskStatus(artifactDir(args), required(args, "task"), required(args, "status"), taskOptions(args));
    case "heartbeat":
      return heartbeatTask(artifactDir(args), required(args, "task"), {
        ...common,
        apiCalls: number(args["api-calls"]),
        toolCalls: number(args["tool-calls"]),
        currentTool: args["current-tool"],
        inTool: bool(args["in-tool"]),
        progressToken: args["progress-token"],
      });
    case "sweep":
      return sweepStalledTasks(artifactDir(args), common);
    case "phase":
      return updatePhase(artifactDir(args), required(args, "phase"), required(args, "status"), { ...common, reason: args.reason });
    case "gate":
      return updateCompletionGate(artifactDir(args), required(args, "gate"), required(args, "status"), {
        ...common,
        required: bool(args.required),
        evidence: args.evidence,
        reason: args.reason,
      });
    case "reconcile":
      return reconcileRunAtDirectory(artifactDir(args), common);
    case "resume": {
      const directory = artifactDir(args);
      return { artifactDir: directory, ...resumeRunAtDirectory(directory, common) };
    }
    case "run":
      return updateRunStatus(artifactDir(args), required(args, "status"), { ...common, reason: args.reason });
    case "status":
      return statusRun(artifactDir(args));
    case "verify":
      return verifyRun(artifactDir(args));
    default:
      throw new TestadorStateError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }
}

try {
  const result = execute(process.argv.slice(2));
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  const known = error instanceof TestadorStateError;
  console.error(JSON.stringify({
    ok: false,
    error: { code: known ? error.code : "UNEXPECTED_ERROR", message: error.message, details: known ? error.details : undefined },
  }, null, 2));
  process.exit(known && ["RUN_NOT_FOUND", "MISSING_ARGUMENT"].includes(error.code) ? 2 : 1);
}

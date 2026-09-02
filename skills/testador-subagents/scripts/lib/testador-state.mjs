import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { PHASE_NAMES, PHASE_ORDER } from "../testador-spec.mjs";
import { ARTIFACT_LAYOUT_VERSION, ensureArtifactLayout } from "./artifact-layout.mjs";
import { readCheckpointIndex } from "./checkpoint-index.mjs";
import {
  CONFIGURABLE_FIELDS,
  PROJECT_CONFIG_SCHEMA_VERSION as PROJECT_CONFIG_FILE_SCHEMA_VERSION,
  ProjectConfigError,
  diffProjectConfig,
  projectConfigPath,
  readProjectConfig,
} from "./project-config.mjs";

/**
 * Estado persistente por-run do Testador: `state.json` (snapshot) +
 * `events.jsonl` (log de eventos) + `.state.lock` (lock de escrita), sempre
 * na raiz de `{artefatos_dir}`.
 *
 * Porte do nucleo de `cc-executor-subagents/.../lib/executor-state.mjs`:
 * lock, `appendEventDurably`/`writeSnapshotAtomically`/`repairIncompleteEventTail`,
 * `reduceEvent`/`loadRun`/`commitEvent` (write-ahead: evento com fsync ANTES
 * do snapshot atomico), `inspectGit`, transicoes de task/run,
 * heartbeat/sweep com grace period, reconcile/resume (perda de posse ->
 * `UNKNOWN`, nunca `FAILED`/`DONE` presumido), `findRunDirectory`,
 * `verifyRun`, `statusRun`.
 *
 * Diferenca do executor: o snapshot da Project_Config congela os CAMPOS DE
 * TESTE (baseUrl, wcagTags, a11yBlocking, ...), nao papeis de agente — este
 * plugin nao roteia trabalho entre codex/agy/claude-code. E os 7 gates de
 * conclusao (`stack`, `smoke`, `deterministic`, `a11y`, `uiux`,
 * `spec-coverage`, `reports`) substituem os 5 do executor.
 *
 * Task nao tem grade de ID fixa: cada task e criada por delegacao
 * (`task register --task <qualquer-string>`), tipicamente uma por fase que
 * usa subagente (exploracao MCP, execucao deterministica, review UI/UX,
 * review do laudo).
 */

export const STATE_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;

export const TASK_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
]);

export const PHASE_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "UNKNOWN",
]);

export const RUN_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
]);

export const GATE_STATUSES = Object.freeze(["PENDING", "DONE", "BLOCKED", "N/A"]);

/**
 * Gates de conclusao do Testador (ver plano, secao "Gates de conclusao"):
 * `stack`/`smoke`/`reports` nunca sao waivable (sempre exigidos); os demais
 * so se aplicam sob condicao (front-end presente, requisito formal presente)
 * e por isso podem fechar `N/A` quando a condicao nao existir nesta run.
 */
export const COMPLETION_GATE_DEFINITIONS = Object.freeze({
  stack: { phase: 4, label: "Subida da stack (Fase 4)", waivable: false },
  smoke: { phase: 5, label: "Exploracao MCP / smoke (Fase 5)", waivable: false },
  deterministic: { phase: 7, label: "Execucao deterministica Playwright (Fase 7)", waivable: true },
  a11y: { phase: 7, label: "Scan de acessibilidade axe (Fase 7)", waivable: true },
  uiux: { phase: 8, label: "Validacao UI/UX e Open Design (Fase 8)", waivable: true },
  "spec-coverage": { phase: 9, label: "Cobertura de requisitos rastreaveis (Fase 9)", waivable: true },
  reports: { phase: 11, label: "Laudo e handoff finais (Fase 11)", waivable: false },
});
const GATE_STATUS_SET = new Set(GATE_STATUSES);

const TASK_STATUS_SET = new Set(TASK_STATUSES);
const PHASE_STATUS_SET = new Set(PHASE_STATUSES);
const RUN_STATUS_SET = new Set(RUN_STATUSES);
const TERMINAL_TASK_STATUSES = new Set(["DONE", "CANCELLED"]);
const TERMINAL_RUN_STATUSES = new Set(["DONE", "CANCELLED"]);

const RUN_TRANSITIONS = Object.freeze({
  PENDING: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  RUNNING: new Set(["DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED", "UNKNOWN"]),
  DONE: new Set(),
  FAILED: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  BLOCKED: new Set(["RUNNING", "FAILED", "CANCELLED", "UNKNOWN"]),
  STALLED: new Set(["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  CANCELLED: new Set(),
  UNKNOWN: new Set(["RUNNING", "FAILED", "BLOCKED", "STALLED", "CANCELLED"]),
});

const TASK_TRANSITIONS = Object.freeze({
  PENDING: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  RUNNING: new Set(["DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED", "UNKNOWN"]),
  DONE: new Set(),
  FAILED: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  BLOCKED: new Set(["RUNNING", "CANCELLED", "UNKNOWN"]),
  STALLED: new Set(["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  CANCELLED: new Set(),
  UNKNOWN: new Set(["RUNNING", "DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED"]),
});

const RESUMABLE_PHASE_SEQUENCE = Object.freeze(PHASE_ORDER.filter((phase) => phase !== 0));

export class TestadorStateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TestadorStateError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TestadorStateError("INVALID_TIME", `Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function asDate(value = new Date()) {
  return value instanceof Date ? value : new Date(value);
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function safeJsonParse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TestadorStateError("INVALID_JSON", `${label} contains invalid JSON: ${error.message}`);
  }
}

function stateFile(artifactDir) {
  return join(resolve(artifactDir), "state.json");
}

function eventsFile(artifactDir) {
  return join(resolve(artifactDir), "events.jsonl");
}

function lockFile(artifactDir) {
  return join(resolve(artifactDir), ".state.lock");
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireLock(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true });
  const path = lockFile(directory);
  const attempts = Number(options.lockAttempts ?? 40);
  const retryMs = Number(options.lockRetryMs ?? 50);
  const staleMs = Number(options.lockStaleMs ?? 120_000);
  const token = randomUUID();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const payload = JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() });
      writeFileSync(fd, `${payload}\n`, "utf8");
      fsyncSync(fd);
      return { fd, path, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      try {
        const info = safeJsonParse(readFileSync(path, "utf8"), path);
        const ageMs = Date.now() - new Date(info.acquiredAt).getTime();
        if (ageMs > staleMs && !pidIsAlive(Number(info.pid))) {
          unlinkSync(path);
          continue;
        }
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        try {
          const ageMs = Date.now() - statSync(path).mtimeMs;
          if (ageMs > staleMs) {
            unlinkSync(path);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
        }
      }

      if (attempt < attempts - 1) sleepSync(retryMs);
    }
  }

  throw new TestadorStateError("STATE_LOCKED", `Could not acquire testador state lock: ${path}`);
}

function releaseLock(lock) {
  try {
    closeSync(lock.fd);
  } finally {
    try {
      const current = safeJsonParse(readFileSync(lock.path, "utf8"), lock.path);
      if (current.token === lock.token) unlinkSync(lock.path);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A stale lock is safer than deleting a lock now owned by another process.
      }
    }
  }
}

function withLock(artifactDir, callback, options = {}) {
  const lock = acquireLock(artifactDir, options);
  try {
    return callback();
  } finally {
    releaseLock(lock);
  }
}

function appendEventDurably(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeSnapshotAtomically(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.state.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function repairIncompleteEventTail(path) {
  if (!existsSync(path)) return false;
  const contents = readFileSync(path);
  if (contents.length === 0 || contents.at(-1) === 0x0a) return false;

  const lastNewline = contents.lastIndexOf(0x0a);
  const tailStart = lastNewline + 1;
  const tail = contents.subarray(tailStart).toString("utf8").trim();
  let keepTail = false;
  if (tail) {
    try {
      JSON.parse(tail);
      keepTail = true;
    } catch {
      // An incomplete final event was never durable and is safe to discard.
    }
  }

  const fd = openSync(path, keepTail ? "a" : "r+");
  try {
    if (keepTail) writeFileSync(fd, "\n", "utf8");
    else ftruncateSync(fd, tailStart);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readEvents(artifactDir) {
  const path = eventsFile(artifactDir);
  if (!existsSync(path)) return { events: [], truncatedTail: false };
  const contents = readFileSync(path, "utf8");
  const lines = contents.split(/\r?\n/);
  const events = [];
  let truncatedTail = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      const isTruncatedTail = index === lines.length - 1 && !contents.endsWith("\n");
      if (isTruncatedTail) {
        truncatedTail = true;
        break;
      }
      throw new TestadorStateError("INVALID_JSON", `${path}:${index + 1} contains invalid JSON: ${error.message}`);
    }
    if (
      event.eventSchemaVersion !== EVENT_SCHEMA_VERSION ||
      !event.eventId ||
      !Number.isInteger(event.revision) ||
      event.revision < 1 ||
      !event.type
    ) {
      throw new TestadorStateError("INVALID_EVENT", `${path}:${index + 1} is not a valid testador event`, { event });
    }
    events.push(event);
  }
  return { events, truncatedTail };
}

function validateTask(taskId, task) {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new TestadorStateError("INVALID_TASK_ID", `Invalid task id: ${taskId}`);
  }
  if (!TASK_STATUS_SET.has(task.status)) {
    throw new TestadorStateError("INVALID_TASK_STATUS", `Task ${taskId} has invalid status ${task.status}`);
  }
  if (!Number.isInteger(task.attempt) || task.attempt < 0) {
    throw new TestadorStateError("INVALID_ATTEMPT", `Task ${taskId} has invalid attempt ${task.attempt}`);
  }
  for (const field of ["apiCalls", "toolCalls"]) {
    if (!Number.isInteger(task[field]) || task[field] < 0) {
      throw new TestadorStateError("INVALID_ACTIVITY_COUNTER", `Task ${taskId} has invalid ${field} ${task[field]}`);
    }
  }
}

/** Snapshot da Project_Config de teste e opcional: run antiga sem o campo continua valida. */
function validateProjectConfigSnapshot(snapshot) {
  if (snapshot == null) return;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TestadorStateError("INVALID_PROJECT_CONFIG_SNAPSHOT", "state.projectConfig must be an object when present");
  }
  if (typeof snapshot.source !== "string" || snapshot.source === "") {
    throw new TestadorStateError("INVALID_PROJECT_CONFIG_SNAPSHOT", "state.projectConfig.source must be a non-empty string");
  }
  const fields = snapshot.fields;
  if (fields == null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TestadorStateError(
      "INVALID_PROJECT_CONFIG_SNAPSHOT",
      "state.projectConfig.fields must be an object with the configured test fields",
    );
  }
}

function assertRunMutable(state, operation = "mutate") {
  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    throw new TestadorStateError(
      "RUN_TERMINAL",
      `Run ${state.runId} is ${state.status} and cannot ${operation}`,
      { runId: state.runId, status: state.status, operation },
    );
  }
}

function assertRunTransition(state, nextStatus) {
  if (state.status === nextStatus) return;
  if (!RUN_TRANSITIONS[state.status]?.has(nextStatus)) {
    throw new TestadorStateError(
      "INVALID_RUN_TRANSITION",
      `Run ${state.runId} cannot transition from ${state.status} to ${nextStatus}`,
    );
  }
}

function validateCompletionGates(gates) {
  if (gates == null) return;
  if (typeof gates !== "object" || Array.isArray(gates)) {
    throw new TestadorStateError("INVALID_COMPLETION_GATES", "completionGates must be an object");
  }
  for (const [gateId, definition] of Object.entries(COMPLETION_GATE_DEFINITIONS)) {
    const gate = gates[gateId];
    if (!gate || !GATE_STATUS_SET.has(gate.status)) {
      throw new TestadorStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} is missing or has an invalid status`,
      );
    }
    if (typeof gate.required !== "boolean") {
      throw new TestadorStateError("INVALID_COMPLETION_GATE", `Completion gate ${gateId} must declare required`);
    }
    if (gate.requiredOverride != null && typeof gate.requiredOverride !== "boolean") {
      throw new TestadorStateError("INVALID_COMPLETION_GATE", `Completion gate ${gateId} has an invalid requiredOverride`);
    }
    if (gate.requiredOverride === false && !definition.waivable) {
      throw new TestadorStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} cannot override required applicability`,
      );
    }
    if (gate.status === "N/A" && !definition.waivable) {
      throw new TestadorStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} is not waivable and cannot be N/A`,
      );
    }
  }
}

export function validateState(state) {
  if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new TestadorStateError("UNSUPPORTED_STATE_SCHEMA", `Expected state schema ${STATE_SCHEMA_VERSION}`);
  }
  if (!state.runId || !state.slug || !Number.isInteger(state.revision)) {
    throw new TestadorStateError("INVALID_STATE", "state.json is missing run identity fields");
  }
  if (!RUN_STATUS_SET.has(state.status)) {
    throw new TestadorStateError("INVALID_RUN_STATUS", `Run ${state.runId} has invalid status ${state.status}`);
  }
  if (!PHASE_STATUS_SET.has(state.phaseStatus)) {
    throw new TestadorStateError("INVALID_PHASE_STATUS", `Run ${state.runId} has invalid phase status ${state.phaseStatus}`);
  }
  for (const [taskId, task] of Object.entries(state.tasks ?? {})) validateTask(taskId, task);
  validateProjectConfigSnapshot(state.projectConfig);
  validateCompletionGates(state.completionGates);
  return state;
}

function reduceEvent(previousState, event) {
  let state = previousState == null ? null : clone(previousState);
  const payload = event.payload ?? {};

  switch (event.type) {
    case "RUN_INITIALIZED":
      if (state != null) throw new TestadorStateError("DUPLICATE_INIT", "Run is already initialized");
      state = clone(payload.state);
      break;
    case "PHASE_UPDATED":
      state.phase = payload.phase;
      state.phaseStatus = payload.phaseStatus;
      state.lastSafePhase = payload.lastSafePhase;
      state.phaseHistory = clone(payload.phaseHistory);
      state.status = payload.runStatus;
      break;
    case "TASK_UPDATED":
    case "TASK_HEARTBEAT":
      state.tasks[payload.taskId] = clone(payload.task);
      state.status = payload.runStatus;
      break;
    case "STALL_SWEEP_COMPLETED":
      state.tasks = clone(payload.tasks);
      state.status = payload.runStatus;
      state.lifecycle = clone(payload.lifecycle);
      break;
    case "RUN_RESUMED":
      state.tasks = clone(payload.tasks);
      state.status = payload.runStatus;
      state.resume = clone(payload.resume);
      break;
    case "RUN_RECONCILED":
      state.tasks = clone(payload.tasks);
      state.status = payload.runStatus;
      state.repository = clone(payload.repository);
      state.resume = clone(payload.resume);
      break;
    case "RUN_STATUS_UPDATED":
      state.status = payload.runStatus;
      state.statusReason = payload.statusReason ?? null;
      break;
    case "COMPLETION_GATE_UPDATED":
      state.completionGates = { ...(state.completionGates ?? {}), [payload.gateId]: clone(payload.gate) };
      break;
    default:
      throw new TestadorStateError("UNKNOWN_EVENT_TYPE", `Unknown testador event type: ${event.type}`);
  }

  state.revision = event.revision;
  state.lastEventId = event.eventId;
  state.updatedAt = event.occurredAt;
  validateState(state);
  return state;
}

function replayEvents(events) {
  let state = null;
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

function loadSnapshot(artifactDir) {
  const path = stateFile(artifactDir);
  if (!existsSync(path)) return { state: null, error: null };
  try {
    return { state: safeJsonParse(readFileSync(path, "utf8"), path), error: null };
  } catch (error) {
    return { state: null, error };
  }
}

export function loadRun(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  const eventLogPath = eventsFile(directory);
  const eventTailRecovered = options.repairSnapshot ? repairIncompleteEventTail(eventLogPath) : false;
  const snapshot = loadSnapshot(directory);
  const eventRead = readEvents(directory);
  const events = eventRead.events;

  if (snapshot.state == null && events.length === 0) {
    if (snapshot.error) throw snapshot.error;
    throw new TestadorStateError("RUN_NOT_FOUND", `No state.json or events.jsonl found in ${directory}`);
  }

  let state = snapshot.state;
  let snapshotError = snapshot.error;
  let snapshotRecovered = snapshot.error != null || state == null;
  let startRevision = 0;

  if (state != null) {
    try {
      validateState(state);
      startRevision = state.revision;
    } catch (error) {
      if (events.length === 0) throw error;
      snapshotError = error;
      snapshotRecovered = true;
      state = null;
    }
  }

  const seenRevisions = new Set();
  let maximumEventRevision = 0;
  let eventRunId = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (seenRevisions.has(event.revision)) {
      throw new TestadorStateError("DUPLICATE_EVENT_REVISION", `events.jsonl contains revision ${event.revision} more than once`);
    }
    const expectedRevision = index + 1;
    if (event.revision !== expectedRevision) {
      throw new TestadorStateError("EVENT_REVISION_GAP", `Expected event revision ${expectedRevision}, found ${event.revision}`);
    }
    seenRevisions.add(event.revision);
    maximumEventRevision = Math.max(maximumEventRevision, event.revision);
    eventRunId ??= event.runId;
    if (event.runId !== eventRunId) {
      throw new TestadorStateError("RUN_ID_MISMATCH", `Event ${event.eventId} belongs to another run`);
    }
    if (index === 0 && event.type !== "RUN_INITIALIZED") {
      throw new TestadorStateError("MISSING_INIT_EVENT", "events.jsonl must begin with RUN_INITIALIZED");
    }
  }

  if (state != null && state.revision > maximumEventRevision) {
    throw new TestadorStateError(
      "SNAPSHOT_AHEAD_OF_LOG",
      `state.json revision ${state.revision} is ahead of events.jsonl revision ${maximumEventRevision}`,
    );
  }

  if (state == null) {
    state = replayEvents(events);
  } else {
    const pending = events.filter((event) => event.revision > startRevision);
    for (let index = 0; index < pending.length; index += 1) {
      const expected = startRevision + index + 1;
      if (pending[index].revision !== expected) {
        throw new TestadorStateError("EVENT_REVISION_GAP", `Expected event revision ${expected}, found ${pending[index].revision}`);
      }
      if (pending[index].runId !== state.runId) {
        throw new TestadorStateError("RUN_ID_MISMATCH", `Event ${pending[index].eventId} belongs to another run`);
      }
      state = reduceEvent(state, pending[index]);
      snapshotRecovered = true;
    }
  }

  let snapshotDiverged = false;
  if (options.verifyReplay) {
    const replayed = replayEvents(events);
    if (!isDeepStrictEqual(state, replayed)) {
      state = replayed;
      snapshotRecovered = true;
      snapshotDiverged = true;
    }
  }

  if (options.repairSnapshot && snapshotRecovered) {
    writeSnapshotAtomically(stateFile(directory), state);
  }

  return {
    artifactDir: directory,
    state,
    events,
    snapshotRecovered,
    snapshotError: snapshotError?.message ?? null,
    eventTailRecovered,
    eventTailIncomplete: eventRead.truncatedTail,
    snapshotDiverged,
  };
}

function commitEvent(artifactDir, currentState, type, payload, options = {}) {
  const directory = resolve(artifactDir);
  const occurredAt = iso(options.now);
  const event = {
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    runId: currentState?.runId ?? payload?.state?.runId,
    revision: (currentState?.revision ?? 0) + 1,
    occurredAt,
    type,
    actor: options.actor ?? "testador",
    payload: clone(payload),
  };

  const nextState = reduceEvent(currentState, event);
  appendEventDurably(eventsFile(directory), event);
  writeSnapshotAtomically(stateFile(directory), nextState);
  return { state: nextState, event };
}

function runGit(projectRoot, args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 10_000,
    });
    return options.preserveLeadingWhitespace ? output.trimEnd() : output.trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

export function inspectGit(projectRoot) {
  const root = resolve(projectRoot);
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!gitRoot) {
    return { available: false, observedAt: new Date().toISOString(), error: "not-a-git-repository" };
  }

  const head = runGit(root, ["rev-parse", "HEAD"], { allowFailure: true });
  const branch = runGit(root, ["branch", "--show-current"], { allowFailure: true });
  const porcelain = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
    allowFailure: true,
    preserveLeadingWhitespace: true,
  });
  const changedFiles = (porcelain ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => (path.includes(" -> ") ? path.split(" -> ").at(-1) : path));

  return {
    available: true,
    root: toPosix(relative(root, resolve(gitRoot)) || "."),
    head,
    branch: branch || null,
    dirty: changedFiles.length > 0,
    changedFiles: [...new Set(changedFiles)].sort(),
    observedAt: new Date().toISOString(),
  };
}

function changedFilesSince(projectRoot, commitBefore, currentGit) {
  const files = new Set(currentGit.changedFiles ?? []);
  if (commitBefore && currentGit.available && currentGit.head && commitBefore !== currentGit.head) {
    const committed = runGit(projectRoot, ["diff", "--name-only", `${commitBefore}..${currentGit.head}`], {
      allowFailure: true,
    });
    for (const path of (committed ?? "").split(/\r?\n/).filter(Boolean)) files.add(path.trim());
  }
  return [...files].sort();
}

function phaseName(phase) {
  return PHASE_NAMES[phase] ?? `fase-${phase}`;
}

function nextSafeResumePhase(lastSafePhase) {
  const completed = Number(lastSafePhase ?? 0);
  return RESUMABLE_PHASE_SEQUENCE.find((phase) => phase > completed) ?? RESUMABLE_PHASE_SEQUENCE.at(-1);
}

function normalizeSlug(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new TestadorStateError("INVALID_SLUG", "A non-empty slug is required");
  return slug;
}

function deriveRunStatus(tasks, fallback = "RUNNING") {
  const values = Object.values(tasks ?? {});
  if (values.length === 0) return fallback;
  for (const status of ["RUNNING", "STALLED", "UNKNOWN", "BLOCKED", "FAILED"]) {
    if (values.some((task) => task.status === status)) return status;
  }
  if (values.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) return fallback;
  if (TERMINAL_RUN_STATUSES.has(fallback)) return fallback;
  return "RUNNING";
}

function runSummary(state) {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const task of Object.values(state.tasks ?? {})) counts[task.status] += 1;
  return {
    runId: state.runId,
    slug: state.slug,
    status: state.status,
    phase: state.phase,
    phaseStatus: state.phaseStatus,
    lastSafePhase: state.lastSafePhase,
    revision: state.revision,
    counts,
    updatedAt: state.updatedAt,
  };
}

function projectConfigSnapshot(config, source) {
  const fields = {};
  for (const field of CONFIGURABLE_FIELDS) fields[field] = config[field];
  return {
    schemaVersion: Number(config.schemaVersion ?? PROJECT_CONFIG_FILE_SCHEMA_VERSION),
    source: source ?? "default",
    updatedAt: config.updatedAt ?? null,
    fields,
  };
}

function readProjectConfigForDrift(projectRoot) {
  try {
    const read = readProjectConfig(projectRoot);
    return { ...read, error: null };
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return {
        exists: true,
        source: "invalid",
        path: error.details?.path ?? projectConfigPath(projectRoot),
        config: null,
        error: { code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

function computeProjectConfigDrift(state, projectRoot) {
  const snapshot = state.projectConfig ?? null;
  const file = readProjectConfigForDrift(projectRoot);
  const base = { path: file.path, fileSource: file.source, error: file.error };

  if (snapshot == null) {
    return {
      ...base,
      changed: false,
      source: "legacy",
      differences: [],
      snapshotUpdatedAt: null,
      fileUpdatedAt: file.config?.updatedAt ?? null,
      reason: "This run has no project configuration snapshot and is treated as a legacy run",
    };
  }
  if (file.config == null) {
    return {
      ...base,
      changed: false,
      source: snapshot.source ?? "file",
      differences: [],
      snapshotUpdatedAt: snapshot.updatedAt ?? null,
      fileUpdatedAt: null,
      reason: "The current project config file is invalid; the run keeps its snapshot",
    };
  }
  const diff = diffProjectConfig(snapshot.fields ?? null, file.config);
  const differences = Object.entries(diff).map(([field, delta]) => ({ field, ...delta }));
  return {
    ...base,
    changed: differences.length > 0,
    source: file.source,
    differences,
    snapshotUpdatedAt: snapshot.updatedAt ?? null,
    fileUpdatedAt: file.config.updatedAt ?? null,
    reason: differences.length > 0
      ? "The project config file diverges from the snapshot recorded for this run"
      : "The project config file matches the snapshot recorded for this run",
  };
}

/**
 * `completionGateRequirements` vem de lib/gates.mjs::completionGateRequirements(planGates(...)) --
 * um mapa `{ deterministic: bool, a11y: bool, uiux: bool, spec-coverage: bool }`
 * computado a partir do plano de gates da fase 3 (ver
 * `references/workflow.md` fase 3). Quando fornecido, os 4 completion gates
 * waivable nascem `required: true`/`false` de acordo com o que a run
 * efetivamente planejou -- em vez de sempre `required: false` por default
 * (o que fazia `updateCompletionGate(..., "N/A")` nunca registrar um
 * waiver real e `RUN_GATES_WAIVED` nunca disparar, mesmo quando um gate
 * planejado como obrigatorio era pulado sem justificativa).
 * Sem o parametro (chamadas legadas, testes), o comportamento e idempotente
 * ao anterior: todo gate waivable nasce `required: false`.
 */
function initialCompletionGates(now, completionGateRequirements = {}) {
  const gates = {};
  for (const [gateId, definition] of Object.entries(COMPLETION_GATE_DEFINITIONS)) {
    const plannedRequired = definition.waivable ? Boolean(completionGateRequirements[gateId]) : true;
    gates[gateId] = {
      id: gateId,
      phase: definition.phase,
      required: plannedRequired,
      requiredOverride: null,
      status: "PENDING",
      evidence: [],
      updatedAt: now,
    };
  }
  return gates;
}

export function initRun(options) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const slug = normalizeSlug(options.slug ?? basename(resolve(options.artifactDir ?? "")));
  const artifactDir = resolve(options.artifactDir ?? join(projectRoot, ".testador", slug, "artefatos"));

  return withLock(artifactDir, () => {
    if (existsSync(stateFile(artifactDir)) || existsSync(eventsFile(artifactDir))) {
      const loaded = loadRun(artifactDir, { repairSnapshot: true });
      if (TERMINAL_RUN_STATUSES.has(loaded.state.status)) {
        throw new TestadorStateError(
          "RUN_TERMINAL",
          `Run ${loaded.state.runId} is already ${loaded.state.status}; initialize a new artifactDir`,
        );
      }
      return { created: false, artifactDir, state: loaded.state, summary: runSummary(loaded.state) };
    }

    const now = iso(options.now);
    const phase = Number(options.phase ?? 0);
    const git = inspectGit(projectRoot);
    ensureArtifactLayout(artifactDir);
    const runId = options.runId ?? (
      basename(artifactDir) === "artefatos" ? basename(dirname(artifactDir)) : basename(artifactDir)
    );
    const resolvedConfig = readProjectConfig(projectRoot);
    const initial = {
      schemaVersion: STATE_SCHEMA_VERSION,
      layoutVersion: ARTIFACT_LAYOUT_VERSION,
      runId,
      slug,
      projectConfig: projectConfigSnapshot(resolvedConfig.config, resolvedConfig.source),
      artifactRoot: toPosix(relative(projectRoot, artifactDir) || "."),
      status: "RUNNING",
      statusReason: null,
      phase,
      phaseStatus: "RUNNING",
      lastSafePhase: Math.max(0, Number(options.lastSafePhase ?? phase - 1)),
      tasks: {},
      completionGates: initialCompletionGates(now, options.completionGateRequirements),
      phaseHistory: {
        [String(phase)]: { name: phaseName(phase), status: "RUNNING", startedAt: now, completedAt: null },
      },
      repository: {
        ...git,
        headAtStart: git.head ?? null,
        dirtyAtStart: git.dirty ?? null,
        lastObservedHead: git.head ?? null,
      },
      lifecycle: {
        staleIdleSeconds: Number(options.staleIdleSeconds ?? 450),
        staleInToolSeconds: Number(options.staleInToolSeconds ?? 1200),
        stallGraceSeconds: Number(options.stallGraceSeconds ?? 120),
        lastSweepAt: null,
      },
      resume: {
        count: 0,
        lastResumedAt: null,
        lastReconciledAt: null,
        resumeFromPhase: phase,
        pendingExternalProbes: [],
        recommendations: [],
      },
      createdAt: now,
      updatedAt: now,
      revision: 0,
      lastEventId: null,
    };

    const committed = commitEvent(artifactDir, null, "RUN_INITIALIZED", { state: initial }, options);
    return {
      created: true,
      artifactDir,
      state: committed.state,
      event: committed.event,
      summary: runSummary(committed.state),
    };
  }, options);
}

function ensureTask(state, taskId) {
  const normalized = String(taskId ?? "").trim();
  if (!normalized || !state.tasks[normalized]) {
    throw new TestadorStateError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }
  return normalized;
}

function normalizeList(value) {
  if (value == null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function initialTask(metadata, now) {
  return {
    executorSource: null,
    title: null,
    ...clone(metadata),
    status: "PENDING",
    attempt: 0,
    attemptHistory: [],
    sessionId: null,
    conversationId: null,
    commitBefore: null,
    commitAfter: null,
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    apiCalls: 0,
    toolCalls: 0,
    currentTool: null,
    inTool: false,
    expectedFiles: normalizeList(metadata.expectedFiles) ?? [],
    producedFiles: [],
    validationPlan: normalizeList(metadata.validationPlan) ?? [],
    validations: [],
    allowedPaths: normalizeList(metadata.allowedPaths) ?? [],
    evidence: [],
    reasonCode: null,
    reason: null,
    reconciliation: null,
    sourcePresent: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function registerTask(artifactDir, taskId, metadata = {}, options = {}) {
  const normalizedId = String(taskId ?? "").trim();
  if (!normalizedId) throw new TestadorStateError("INVALID_TASK_ID", "A non-empty task id is required");

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "register a task");
    if (state.tasks[normalizedId]) {
      throw new TestadorStateError("TASK_ALREADY_EXISTS", `Task ${normalizedId} already exists`);
    }
    const now = iso(options.now);
    const task = initialTask({ id: normalizedId, ...metadata }, now);
    const tasks = { ...state.tasks, [normalizedId]: task };
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_UPDATED",
      { taskId: normalizedId, task, runStatus },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedId],
      summary: runSummary(committed.state),
    };
  }, options);
}

function mergeTaskFields(previous, status, options, now, git) {
  const task = clone(previous);
  const previousStatus = task.status;
  const sameStatus = previousStatus === status;
  if (!sameStatus && !TASK_TRANSITIONS[previousStatus]?.has(status)) {
    throw new TestadorStateError("INVALID_TASK_TRANSITION", `Task ${task.id} cannot transition from ${previousStatus} to ${status}`);
  }

  task.status = status;
  task.updatedAt = now;
  if (options.executor !== undefined) task.executor = options.executor;
  if (options.executorSource !== undefined) task.executorSource = options.executorSource || null;
  if (options.model !== undefined) task.model = options.model || null;
  if (options.sessionId !== undefined) task.sessionId = options.sessionId || null;
  if (options.conversationId !== undefined) task.conversationId = options.conversationId || null;
  if (options.reasonCode !== undefined) task.reasonCode = options.reasonCode || null;
  if (options.reason !== undefined) task.reason = options.reason || null;
  if (options.currentTool !== undefined) task.currentTool = options.currentTool || null;
  if (options.inTool !== undefined) task.inTool = Boolean(options.inTool);
  if (options.apiCalls !== undefined) task.apiCalls = Number(options.apiCalls);
  if (options.toolCalls !== undefined) task.toolCalls = Number(options.toolCalls);

  const expectedFiles = normalizeList(options.expectedFiles);
  if (expectedFiles) task.expectedFiles = expectedFiles;
  const producedFiles = normalizeList(options.producedFiles);
  if (producedFiles) task.producedFiles = [...new Set([...(task.producedFiles ?? []), ...producedFiles])];
  const evidence = normalizeList(options.evidence);
  if (evidence) task.evidence = [...new Set([...(task.evidence ?? []), ...evidence])];
  if (Array.isArray(options.validations)) task.validations = clone(options.validations);

  if (!Array.isArray(task.attemptHistory)) task.attemptHistory = [];
  if (status === "RUNNING") {
    const recoveringSameAttempt = ["STALLED", "UNKNOWN"].includes(previousStatus) &&
      Number(task.attempt ?? 0) > 0 && options.newAttempt !== true;
    const newAttempt = !sameStatus && !recoveringSameAttempt;
    if (newAttempt) task.attempt = Number(task.attempt ?? 0) + 1;
    task.startedAt = sameStatus || recoveringSameAttempt ? task.startedAt ?? now : now;
    task.completedAt = null;
    task.lastActivityAt = now;
    task.commitBefore = options.commitBefore ?? task.commitBefore ?? git.head ?? null;
    task.commitAfter = null;
    task.stall = null;
    task.reconciliation = null;
    const attemptIndex = task.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(task.attempt));
    const attemptRecord = {
      ...(attemptIndex >= 0 ? task.attemptHistory[attemptIndex] : {}),
      attempt: Number(task.attempt),
      executor: task.executor ?? null,
      executorSource: task.executorSource ?? null,
      model: task.model ?? null,
      status: "RUNNING",
      startedAt: attemptIndex >= 0 ? task.attemptHistory[attemptIndex].startedAt ?? task.startedAt : task.startedAt,
      completedAt: null,
      durationMs: null,
      reasonCode: null,
      sessionId: task.sessionId ?? null,
      conversationId: task.conversationId ?? null,
      commitBefore: task.commitBefore ?? null,
      commitAfter: null,
    };
    if (attemptIndex >= 0) task.attemptHistory[attemptIndex] = attemptRecord;
    else task.attemptHistory.push(attemptRecord);
  } else if (status === "DONE") {
    task.completedAt = now;
    task.lastActivityAt = now;
    task.commitAfter = options.commitAfter ?? git.head ?? task.commitAfter ?? null;
  } else if (status === "STALLED") {
    task.stall = { ...(task.stall ?? {}), detectedAt: now, reason: options.reason ?? "No observable progress" };
  } else if (status === "UNKNOWN") {
    task.unknownAt = now;
  } else if (["FAILED", "BLOCKED", "CANCELLED"].includes(status)) {
    task.completedAt = status === "BLOCKED" ? null : now;
  }

  if (["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(status) && Number(task.attempt ?? 0) > 0) {
    const attemptIndex = task.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(task.attempt));
    const previousAttempt = attemptIndex >= 0 ? task.attemptHistory[attemptIndex] : {
      attempt: Number(task.attempt),
      executor: task.executor ?? null,
      model: task.model ?? null,
      startedAt: task.startedAt ?? now,
    };
    const completedAt = task.completedAt ?? now;
    const startedMs = Date.parse(previousAttempt.startedAt ?? "");
    const completedMs = Date.parse(completedAt);
    const record = {
      ...previousAttempt,
      executor: task.executor ?? previousAttempt.executor ?? null,
      executorSource: task.executorSource ?? previousAttempt.executorSource ?? null,
      model: task.model ?? previousAttempt.model ?? null,
      status,
      completedAt,
      durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null,
      reasonCode: task.reasonCode ?? null,
      commitAfter: task.commitAfter ?? null,
    };
    if (attemptIndex >= 0) task.attemptHistory[attemptIndex] = record;
    else task.attemptHistory.push(record);
  }

  return task;
}

function pathEvidence(projectRoot, paths) {
  const checked = [];
  for (const path of normalizeList(paths) ?? []) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
    const rel = relative(projectRoot, absolute);
    const inside = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
    checked.push({ path: toPosix(path), exists: inside && existsSync(absolute), insideProject: inside });
  }
  return checked;
}

function allValidationsPass(validations) {
  if (!Array.isArray(validations) || validations.length === 0) return null;
  return validations.every((item) => {
    const value = typeof item === "object" ? item.status ?? item.passed : item;
    if (value === true) return true;
    return ["PASS", "PASSED", "SUCCESS", "OK"].includes(String(value).toUpperCase());
  });
}

function assertTaskDoneEvidence(task, projectRoot, git) {
  const expected = pathEvidence(projectRoot, task.expectedFiles ?? []);
  const missingExpected = expected.filter((entry) => !entry.exists || !entry.insideProject);
  if (missingExpected.length > 0) {
    throw new TestadorStateError(
      "TASK_EXPECTED_FILES_MISSING",
      `Task ${task.id} cannot be DONE while expected files are missing`,
      { files: missingExpected },
    );
  }
  const produced = pathEvidence(projectRoot, task.producedFiles ?? []);
  const fileEvidence = [...expected, ...produced].some((entry) => entry.exists && entry.insideProject);
  const validationEvidence = allValidationsPass(task.validations) === true;
  const recordedEvidence = Array.isArray(task.evidence) && task.evidence.length > 0;
  const commitEvidence = Boolean(
    task.commitBefore && (task.commitAfter ?? git.head) && task.commitBefore !== (task.commitAfter ?? git.head),
  );
  if (!fileEvidence && !validationEvidence && !recordedEvidence && !commitEvidence) {
    throw new TestadorStateError(
      "TASK_DONE_REQUIRES_EVIDENCE",
      `Task ${task.id} cannot be DONE without produced files, passing validation, commit delta, or recorded evidence`,
    );
  }
}

function resolveProjectRoot(artifactDir, options = {}, state = null) {
  if (options.projectRoot) return resolve(options.projectRoot);
  const artifactRoot = typeof state?.artifactRoot === "string" ? state.artifactRoot.trim() : "";
  if (artifactRoot) {
    const segments = artifactRoot.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (!segments.includes("..")) return resolve(artifactDir, ...segments.map(() => ".."));
  }
  return resolve(process.cwd());
}

export function updateTaskStatus(artifactDir, taskId, status, options = {}) {
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!TASK_STATUS_SET.has(normalizedStatus)) {
    throw new TestadorStateError("INVALID_TASK_STATUS", `Invalid task status: ${status}`);
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a task");
    const normalizedTaskId = ensureTask(state, taskId);
    const now = iso(options.now);
    const projectRoot = resolveProjectRoot(artifactDir, options, state);
    const git = inspectGit(projectRoot);
    const task = mergeTaskFields(state.tasks[normalizedTaskId], normalizedStatus, options, now, git);
    if (normalizedStatus === "DONE") assertTaskDoneEvidence(task, projectRoot, git);
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(artifactDir, state, "TASK_UPDATED", { taskId: normalizedTaskId, task, runStatus }, options);
    return {
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedTaskId],
      summary: runSummary(committed.state),
    };
  }, options);
}

export function heartbeatTask(artifactDir, taskId, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "record a heartbeat");
    const normalizedTaskId = ensureTask(state, taskId);
    const previous = state.tasks[normalizedTaskId];
    if (!["RUNNING", "STALLED"].includes(previous.status)) {
      throw new TestadorStateError(
        "HEARTBEAT_NOT_ALLOWED",
        `Task ${normalizedTaskId} is ${previous.status}; heartbeat requires RUNNING or STALLED`,
      );
    }

    const now = iso(options.now);
    const apiCalls = options.apiCalls === undefined ? previous.apiCalls : Number(options.apiCalls);
    const toolCalls = options.toolCalls === undefined ? previous.toolCalls : Number(options.toolCalls);
    const currentTool = options.currentTool === undefined ? previous.currentTool : options.currentTool || null;
    const inTool = options.inTool === undefined ? previous.inTool : Boolean(options.inTool);
    const progressToken = options.progressToken === undefined
      ? previous.progressToken ?? null
      : String(options.progressToken);
    const observedProgress =
      (options.apiCalls !== undefined && apiCalls !== previous.apiCalls) ||
      (options.toolCalls !== undefined && toolCalls !== previous.toolCalls) ||
      (options.currentTool !== undefined && currentTool !== previous.currentTool) ||
      (options.inTool !== undefined && inTool !== previous.inTool) ||
      (options.progressToken !== undefined && progressToken !== (previous.progressToken ?? null));

    if (!observedProgress) {
      return { changed: false, state, task: previous, summary: runSummary(state) };
    }

    const task = {
      ...clone(previous),
      status: "RUNNING",
      lastActivityAt: now,
      updatedAt: now,
      apiCalls,
      toolCalls,
      currentTool,
      inTool,
      progressToken,
      stall: previous.status === "STALLED" ? { ...(previous.stall ?? {}), recoveredAt: now } : previous.stall ?? null,
    };
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(artifactDir, state, "TASK_HEARTBEAT", { taskId: normalizedTaskId, task, runStatus }, options);
    return {
      changed: true,
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedTaskId],
      summary: runSummary(committed.state),
    };
  }, options);
}

export function sweepStalledTasks(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "sweep stalled tasks");
    const nowDate = asDate(options.now);
    const now = iso(nowDate);
    const idleSeconds = Number(options.staleIdleSeconds ?? state.lifecycle?.staleIdleSeconds ?? 450);
    const inToolSeconds = Number(options.staleInToolSeconds ?? state.lifecycle?.staleInToolSeconds ?? 1200);
    const graceSeconds = Number(options.stallGraceSeconds ?? state.lifecycle?.stallGraceSeconds ?? 120);
    const tasks = clone(state.tasks);
    const stalled = [];
    const graceExpired = [];

    for (const task of Object.values(tasks)) {
      if (task.status === "RUNNING") {
        const last = task.lastActivityAt ?? task.startedAt;
        if (!last) continue;
        const quietSeconds = Math.max(0, (nowDate.getTime() - new Date(last).getTime()) / 1000);
        const thresholdSeconds = task.inTool ? inToolSeconds : idleSeconds;
        if (quietSeconds >= thresholdSeconds) {
          task.status = "STALLED";
          task.updatedAt = now;
          task.stall = {
            detectedAt: now,
            quietSeconds: Math.round(quietSeconds * 100) / 100,
            thresholdSeconds,
            phase: task.inTool ? "in_tool" : "idle",
            graceSeconds,
            graceUntil: new Date(nowDate.getTime() + graceSeconds * 1000).toISOString(),
            recommendation: "INTERRUPT_THEN_RECONCILE",
          };
          stalled.push(task.id);
        }
      } else if (task.status === "STALLED" && task.stall?.graceUntil) {
        if (nowDate.getTime() >= new Date(task.stall.graceUntil).getTime() && !task.stall.graceExpiredAt) {
          task.updatedAt = now;
          task.stall.graceExpiredAt = now;
          task.stall.recommendation = "CANCEL_OR_RETRY_AFTER_RECONCILIATION";
          graceExpired.push(task.id);
        }
      }
    }

    const changed = stalled.length > 0 || graceExpired.length > 0;
    if (!changed) {
      return { changed: false, state, stalled, graceExpired, summary: runSummary(state) };
    }

    const runStatus = deriveRunStatus(tasks, state.status);
    const lifecycle = { staleIdleSeconds: idleSeconds, staleInToolSeconds: inToolSeconds, stallGraceSeconds: graceSeconds, lastSweepAt: now };
    const committed = commitEvent(artifactDir, state, "STALL_SWEEP_COMPLETED", { tasks, runStatus, lifecycle, stalled, graceExpired }, options);
    return {
      changed: true,
      state: committed.state,
      event: committed.event,
      stalled,
      graceExpired,
      summary: runSummary(committed.state),
    };
  }, options);
}

export function updatePhase(artifactDir, phase, phaseStatus, options = {}) {
  const numericPhase = Number(phase);
  const normalizedStatus = String(phaseStatus).toUpperCase();
  if (!Number.isFinite(numericPhase)) throw new TestadorStateError("INVALID_PHASE", `Invalid phase: ${phase}`);
  if (!PHASE_STATUS_SET.has(normalizedStatus)) {
    throw new TestadorStateError("INVALID_PHASE_STATUS", `Invalid phase status: ${phaseStatus}`);
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a phase");
    const now = iso(options.now);
    const history = clone(state.phaseHistory ?? {});
    const previous = history[String(numericPhase)] ?? {};
    history[String(numericPhase)] = {
      name: phaseName(numericPhase),
      status: normalizedStatus,
      startedAt: previous.startedAt ?? now,
      completedAt: normalizedStatus === "DONE" ? now : previous.completedAt ?? null,
      reason: options.reason ?? previous.reason ?? null,
    };

    const lastSafePhase = normalizedStatus === "DONE"
      ? Math.max(Number(state.lastSafePhase ?? 0), numericPhase)
      : Number(state.lastSafePhase ?? 0);
    let runStatus = state.status;
    if (normalizedStatus === "RUNNING" || normalizedStatus === "DONE") runStatus = "RUNNING";
    if (["FAILED", "BLOCKED", "UNKNOWN"].includes(normalizedStatus)) runStatus = normalizedStatus;
    if (normalizedStatus === "CANCELLED") runStatus = "BLOCKED";
    assertRunTransition(state, runStatus);

    const committed = commitEvent(
      artifactDir,
      state,
      "PHASE_UPDATED",
      { phase: numericPhase, phaseStatus: normalizedStatus, lastSafePhase, phaseHistory: history, runStatus },
      options,
    );
    return { state: committed.state, event: committed.event, summary: runSummary(committed.state) };
  }, options);
}

/**
 * Aplica um mapa `{ deterministic, a11y, uiux, spec-coverage: bool }` (o
 * retorno de `lib/gates.mjs::completionGateRequirements()`) a uma run ja
 * inicializada, marcando cada um dos 4 completion gates waivable como
 * `required: true/false` conforme o plano da fase 3 -- sem alterar
 * `status` (mantem `PENDING` se ja estava, ou preserva o status atual).
 * Usado quando o plano de gates so fica disponivel depois de `init`
 * (fase 3 depende de descoberta/ingestao da fase 1-2, que roda depois da
 * fase 0 onde `init` acontece).
 */
export function applyCompletionGateRequirements(artifactDir, requirements = {}, options = {}) {
  const results = {};
  for (const [gateId, required] of Object.entries(requirements)) {
    const definition = COMPLETION_GATE_DEFINITIONS[gateId];
    if (!definition || !definition.waivable) continue;
    const current = loadRun(artifactDir).state.completionGates?.[gateId];
    const currentStatus = current?.status ?? "PENDING";
    results[gateId] = updateCompletionGate(artifactDir, gateId, currentStatus, { ...options, required: Boolean(required) }).gate;
  }
  return { gates: results };
}

export function updateCompletionGate(artifactDir, gateId, status, options = {}) {
  const definition = COMPLETION_GATE_DEFINITIONS[gateId];
  if (!definition) {
    throw new TestadorStateError(
      "UNKNOWN_COMPLETION_GATE",
      `Unknown completion gate: ${gateId}`,
      { accepted: Object.keys(COMPLETION_GATE_DEFINITIONS) },
    );
  }
  const normalizedStatus = String(status ?? "").toUpperCase() === "N/A" ? "N/A" : String(status ?? "").toUpperCase();
  if (!GATE_STATUS_SET.has(normalizedStatus)) {
    throw new TestadorStateError("INVALID_GATE_STATUS", `Invalid gate status: ${status}`);
  }
  if (normalizedStatus === "N/A" && definition.waivable !== true) {
    throw new TestadorStateError("GATE_NOT_WAIVABLE", `Completion gate ${gateId} is not waivable and cannot be N/A`);
  }

  if (options.required != null && typeof options.required !== "boolean") {
    throw new TestadorStateError("INVALID_GATE_APPLICABILITY", "Completion gate required override must be a boolean");
  }
  if (options.required != null && !definition.waivable) {
    throw new TestadorStateError(
      "GATE_APPLICABILITY_FIXED",
      `Completion gate ${gateId} is not waivable and always required`,
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a completion gate");
    const now = iso(options.now);
    const previous = state.completionGates?.[gateId] ?? {
      id: gateId,
      phase: definition.phase,
      required: !definition.waivable,
      requiredOverride: null,
      status: "PENDING",
      evidence: [],
      updatedAt: now,
    };

    let requiredOverride = options.required ?? previous.requiredOverride ?? null;
    // Guarda de monotonicidade: uma vez que um waiver foi registrado
    // (requiredOverride === false), flipa-lo de volta para true precisa
    // ser um ato deliberado (`--unwaive`), nunca um efeito colateral de
    // reabrir o gate com `--required true`. Sem isso, `RUN_GATES_WAIVED`
    // podia ser silenciado retroativamente sem deixar rastro auditavel do
    // waiver que aconteceu.
    if (previous.requiredOverride === false && requiredOverride === true && !options.unwaive) {
      throw new TestadorStateError(
        "GATE_WAIVER_REQUIRES_EXPLICIT_UNWAIVE",
        `Completion gate ${gateId} was previously waived (requiredOverride: false); flipping it back to required needs options.unwaive: true to make the transition auditable`,
        { gateId, previousReason: previous.reason ?? null },
      );
    }
    if (normalizedStatus === "N/A" && previous.required) {
      requiredOverride = false;
    }
    const required = requiredOverride == null ? previous.required : requiredOverride;
    if (normalizedStatus === "N/A" && required) {
      throw new TestadorStateError(
        "REQUIRED_GATE_CANNOT_BE_SKIPPED",
        `Completion gate ${gateId} is required and cannot be N/A`,
      );
    }
    if (normalizedStatus === "N/A" && !options.reason) {
      throw new TestadorStateError(
        "GATE_WAIVER_REQUIRES_REASON",
        `Completion gate ${gateId} requires a reason when marked N/A`,
      );
    }

    const gate = {
      ...previous,
      status: normalizedStatus,
      required,
      requiredOverride,
      evidence: options.evidence ? [...new Set([...(previous.evidence ?? []), ...normalizeList(options.evidence)])] : previous.evidence,
      reason: options.reason ?? previous.reason ?? null,
      updatedAt: now,
    };

    const committed = commitEvent(artifactDir, state, "COMPLETION_GATE_UPDATED", { gateId, gate }, options);
    return { state: committed.state, event: committed.event, gate, summary: runSummary(committed.state) };
  }, options);
}

function normalizeExternalStatus(probe) {
  const raw = String(probe?.executorStatus ?? probe?.sessionStatus ?? probe?.conversationStatus ?? probe?.status ?? "").toUpperCase();
  const map = {
    COMPLETED: "DONE",
    COMPLETE: "DONE",
    SUCCESS: "DONE",
    SUCCEEDED: "DONE",
    IN_PROGRESS: "RUNNING",
    DISPATCHED: "RUNNING",
    ERROR: "FAILED",
    TIMED_OUT: "FAILED",
    TIMEOUT: "FAILED",
    QUOTA_EXHAUSTED: "BLOCKED",
    QUOTA_EXAUSTED: "BLOCKED",
    AUTH_REQUIRED: "BLOCKED",
    NEEDS_SYNC: "BLOCKED",
  };
  const normalized = map[raw] ?? raw;
  const status = TASK_STATUS_SET.has(normalized) ? normalized : null;
  const operationalReasonCodes = new Set([
    "QUOTA_EXHAUSTED",
    "QUOTA_EXAUSTED",
    "AUTH_REQUIRED",
    "TIMEOUT",
    "TIMED_OUT",
    "NEEDS_SYNC",
  ]);
  return {
    raw: raw || null,
    status,
    reasonCode: probe?.reasonCode ?? (operationalReasonCodes.has(raw) ? raw : null),
  };
}

function readProbeFile(path) {
  if (!path) return { tasks: {} };
  const parsed = safeJsonParse(readFileSync(resolve(path), "utf8"), resolve(path));
  if (!parsed || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks)) {
    throw new TestadorStateError("INVALID_PROBE_FILE", "Probe file must contain an object shaped as { tasks: { <taskId>: {...} } }");
  }
  return parsed;
}

function reconcileTask(task, probe, projectRoot, git, now) {
  const next = clone(task);
  if (TERMINAL_TASK_STATUSES.has(next.status)) return next;
  const external = normalizeExternalStatus(probe);
  const externalStatus = external.status;
  const expected = pathEvidence(projectRoot, [...(task.expectedFiles ?? []), ...(probe?.expectedFiles ?? [])]);
  const produced = pathEvidence(projectRoot, [...(task.producedFiles ?? []), ...(probe?.producedFiles ?? probe?.files ?? [])]);
  const files = [...expected, ...produced].filter(
    (entry, index, array) => array.findIndex((item) => item.path === entry.path) === index,
  );
  const missingExpected = expected.filter((entry) => !entry.exists).map((entry) => entry.path);
  const validations = Array.isArray(probe?.validations) ? clone(probe.validations) : clone(task.validations ?? []);
  const validationsPass = allValidationsPass(validations);
  const changedFiles = changedFilesSince(projectRoot, task.commitBefore, git);
  const presentFiles = files.filter((entry) => entry.exists && entry.insideProject);
  const commitCorroborated = Boolean(probe?.commitAfter && git.available && probe.commitAfter === git.head);
  const localCorroboration = validationsPass === true
    ? "validation"
    : presentFiles.length > 0
      ? "file"
      : commitCorroborated
        ? "commit"
        : null;
  let recommendation = "VERIFY";
  let reason = "No authoritative executor result was observed";

  if (externalStatus === "RUNNING") {
    next.status = "RUNNING";
    next.lastActivityAt = probe.lastActivityAt ?? next.lastActivityAt ?? now;
    recommendation = "MONITOR";
    reason = "Executor reports that the task is still running";
  } else if (validationsPass === false && externalStatus == null) {
    next.status = "FAILED";
    next.completedAt = now;
    next.reasonCode = probe?.reasonCode ?? "VALIDATION_FAILED";
    recommendation = "FIX_OR_REEXECUTE";
    reason = "At least one task-scoped reconciliation validation failed";
  } else if (externalStatus === "DONE") {
    if (validationsPass === false) {
      next.status = "FAILED";
      next.reasonCode = probe?.reasonCode ?? "VALIDATION_FAILED";
      recommendation = "FIX_OR_REEXECUTE";
      reason = "Executor completed, but at least one validation failed";
    } else if (missingExpected.length > 0) {
      next.status = "UNKNOWN";
      recommendation = "VERIFY_OR_REEXECUTE";
      reason = "Executor reports completion, but expected files are missing";
    } else if (localCorroboration == null) {
      next.status = "UNKNOWN";
      recommendation = "COLLECT_LOCAL_EVIDENCE";
      reason = "Executor reports completion, but no local file, passing validation, or commit evidence corroborates it";
    } else {
      next.status = "DONE";
      next.completedAt = probe.completedAt ?? now;
      next.commitAfter = probe.commitAfter ?? git.head ?? next.commitAfter ?? null;
      next.reasonCode = external.reasonCode;
      recommendation = "CONTINUE";
      reason = "Authoritative executor completion is consistent with local evidence";
    }
  } else if (externalStatus === "FAILED") {
    next.status = "FAILED";
    next.completedAt = probe.completedAt ?? now;
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_FAILED";
    recommendation = changedFiles.length > 0 ? "INSPECT_PARTIAL_THEN_RETRY" : "REEXECUTE";
    reason = probe.error ?? probe.reason ?? "Executor reports failure";
  } else if (externalStatus === "BLOCKED") {
    next.status = "BLOCKED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_BLOCKED";
    recommendation = "RESOLVE_BLOCKER";
    reason = probe.error ?? probe.reason ?? "Executor reports an operational blocker";
  } else if (externalStatus === "CANCELLED") {
    next.status = "CANCELLED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_CANCELLED";
    recommendation = "DO_NOT_REEXECUTE_WITHOUT_USER_INTENT";
    reason = probe.reason ?? "Executor reports cancellation";
  } else if (externalStatus === "STALLED") {
    next.status = "STALLED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_STALLED";
    recommendation = "INTERRUPT_THEN_RECONCILE";
    reason = probe.reason ?? "Executor reports no progress";
  } else if (next.status === "STALLED") {
    recommendation = next.stall?.graceExpiredAt ? "CANCEL_OR_RETRY_AFTER_RECONCILIATION" : "INTERRUPT_THEN_RECONCILE";
    reason = "No new progress was observed for a previously stalled task";
  } else if (next.status === "UNKNOWN" || next.status === "RUNNING") {
    next.status = "UNKNOWN";
    if (changedFiles.length > 0 || files.some((entry) => entry.exists)) {
      recommendation = "VERIFY_BEFORE_REEXECUTE";
      reason = "Local changes exist, but there is no authoritative executor outcome";
    } else {
      recommendation = "REEXECUTE_AFTER_CONFIRMING_SESSION_IS_GONE";
      reason = "No executor outcome or local task evidence was found";
    }
  }

  next.validations = validations;
  next.updatedAt = now;
  next.reconciliation = {
    reconciledAt: now,
    externalStatus,
    externalRawStatus: external.raw,
    reasonCode: external.reasonCode ?? next.reasonCode ?? null,
    files,
    missingExpected,
    validationsPass,
    localCorroboration,
    changedFiles,
    recommendation,
    reason,
  };
  return next;
}

function reconcileLocked(artifactDir, state, options = {}) {
  const projectRoot = resolveProjectRoot(artifactDir, options, state);
  const probeSet = readProbeFile(options.probeFile);
  const now = iso(options.now);
  const git = inspectGit(projectRoot);
  const tasks = {};
  const recommendations = [];
  const pendingExternalProbes = [];

  for (const [taskId, task] of Object.entries(state.tasks)) {
    const probe = probeSet.tasks?.[taskId] ?? null;
    if (["UNKNOWN", "RUNNING", "STALLED", "FAILED", "BLOCKED"].includes(task.status) || probe) {
      tasks[taskId] = reconcileTask(task, probe, projectRoot, git, now);
    } else {
      tasks[taskId] = clone(task);
    }

    const reconciled = tasks[taskId].reconciliation;
    if (reconciled && reconciled.recommendation !== "CONTINUE") {
      recommendations.push({ taskId, action: reconciled.recommendation, reason: reconciled.reason });
    }
    if (tasks[taskId].status === "UNKNOWN") {
      pendingExternalProbes.push({
        taskId,
        executor: tasks[taskId].executor,
        executorSource: tasks[taskId].executorSource ?? null,
        sessionId: tasks[taskId].sessionId,
        conversationId: tasks[taskId].conversationId,
        required: true,
      });
    }
  }

  const runStatus = deriveRunStatus(tasks, state.status);
  const resumeFromPhase = nextSafeResumePhase(state.lastSafePhase);
  const resume = {
    ...(state.resume ?? {}),
    lastReconciledAt: now,
    resumeFromPhase,
    pendingExternalProbes,
    recommendations,
  };
  const repository = { ...(state.repository ?? {}), ...git, lastObservedHead: git.head ?? state.repository?.lastObservedHead ?? null };

  return {
    tasks,
    runStatus,
    repository,
    resume,
    report: {
      runId: state.runId,
      reconciledAt: now,
      resumeFromPhase,
      resumeFromPhaseName: phaseName(resumeFromPhase),
      pendingExternalProbes,
      recommendations,
      git,
    },
  };
}

export function reconcileRunAtDirectory(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: true }).state;
    assertRunMutable(state, "reconcile executors");
    const result = reconcileLocked(artifactDir, state, options);
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_RECONCILED",
      { tasks: result.tasks, runStatus: result.runStatus, repository: result.repository, resume: result.resume },
      options,
    );
    return { state: committed.state, event: committed.event, report: result.report, summary: runSummary(committed.state) };
  }, options);
}

export function resumeRunAtDirectory(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    let state = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: true }).state;
    if (["DONE", "CANCELLED"].includes(state.status)) {
      throw new TestadorStateError("RUN_TERMINAL", `Run ${state.runId} is already ${state.status} and cannot be resumed`);
    }
    const now = iso(options.now);
    const tasks = clone(state.tasks);
    const unknownTasks = [];

    for (const task of Object.values(tasks)) {
      if (task.status === "RUNNING") {
        task.status = "UNKNOWN";
        task.unknownAt = now;
        task.updatedAt = now;
        task.reasonCode = "OWNER_SESSION_INTERRUPTED";
        task.reason = "Previous executor session ended without a durable terminal result";
        unknownTasks.push(task.id);
      }
    }

    const runStatus = deriveRunStatus(tasks, state.status);
    const resume = {
      ...(state.resume ?? {}),
      count: Number(state.resume?.count ?? 0) + 1,
      lastResumedAt: now,
      resumeFromPhase: nextSafeResumePhase(state.lastSafePhase),
      pendingExternalProbes: [],
      recommendations: [],
    };
    const resumed = commitEvent(artifactDir, state, "RUN_RESUMED", { tasks, runStatus, resume, unknownTasks }, options);
    state = resumed.state;

    const reconciled = reconcileLocked(artifactDir, state, options);
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_RECONCILED",
      { tasks: reconciled.tasks, runStatus: reconciled.runStatus, repository: reconciled.repository, resume: reconciled.resume },
      options,
    );
    const projectConfigDrift = computeProjectConfigDrift(committed.state, resolveProjectRoot(artifactDir, options, committed.state));
    return {
      state: committed.state,
      events: [resumed.event, committed.event],
      unknownTasks,
      projectConfigDrift,
      report: { ...reconciled.report, projectConfigDrift },
      summary: runSummary(committed.state),
    };
  }, options);
}

export function updateRunStatus(artifactDir, status, options = {}) {
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!RUN_STATUS_SET.has(normalizedStatus)) {
    throw new TestadorStateError("INVALID_RUN_STATUS", `Invalid run status: ${status}`);
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    if (state.status === normalizedStatus && TERMINAL_RUN_STATUSES.has(normalizedStatus)) {
      return { changed: false, state, summary: runSummary(state) };
    }
    assertRunMutable(state, "update run status");
    assertRunTransition(state, normalizedStatus);
    if (["DONE", "CANCELLED"].includes(normalizedStatus)) {
      const nonTerminalTasks = Object.values(state.tasks ?? {}).filter((task) => !TERMINAL_TASK_STATUSES.has(task.status));
      if (nonTerminalTasks.length > 0) {
        throw new TestadorStateError(
          normalizedStatus === "DONE" ? "RUN_TASKS_NOT_TERMINAL" : "CANCELLATION_NOT_RECONCILED",
          `Run cannot be ${normalizedStatus} while tasks remain non-terminal`,
          { tasks: nonTerminalTasks.map((task) => ({ id: task.id, status: task.status })) },
        );
      }
    }
    if (normalizedStatus === "DONE" && state.completionGates) {
      const openGates = Object.values(state.completionGates).filter(
        (gate) => gate.required && gate.status !== "DONE" && gate.status !== "N/A",
      );
      if (openGates.length > 0) {
        throw new TestadorStateError(
          "RUN_GATES_NOT_CLOSED",
          "Run cannot be DONE while a required completion gate is still open",
          { gates: openGates.map((gate) => ({ id: gate.id, status: gate.status })) },
        );
      }
      // Um waiver de verdade e um gate que foi fechado N/A com
      // requiredOverride:false (ver `updateCompletionGate` — so acontece
      // quando o gate estava `required` e foi explicitamente skippado com
      // justificativa). `requiredOverride:false` sem `status: "N/A"` e o
      // resultado normal de `applyCompletionGateRequirements`/`gates-apply`
      // marcando um gate como "nao aplicavel a este escopo" (ex.:
      // spec-coverage sem OpenSpec) — isso nunca deve, por si so, forcar a
      // run a fechar PARTIAL em vez de DONE.
      const waivedGates = Object.values(state.completionGates).filter(
        (gate) => gate.requiredOverride === false && gate.status === "N/A",
      );
      if (waivedGates.length > 0) {
        throw new TestadorStateError(
          "RUN_GATES_WAIVED",
          "Run cannot be DONE while a required completion gate was waived (closed N/A) — close the handoff as PARTIAL instead",
          { gates: waivedGates.map((gate) => ({ id: gate.id, reason: gate.reason ?? null })) },
        );
      }
    }
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_STATUS_UPDATED",
      { runStatus: normalizedStatus, statusReason: options.reason ?? null },
      options,
    );
    return { state: committed.state, event: committed.event, summary: runSummary(committed.state) };
  }, options);
}

export function findRunDirectory(options = {}) {
  if (options.artifactDir) return resolve(options.artifactDir);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const { index } = readCheckpointIndex(projectRoot);
  if (!index.execucao_atual) {
    throw new TestadorStateError("RUN_NOT_FOUND", `No active execution found in ${projectRoot}; pass --dir explicitly`);
  }
  return resolve(projectRoot, index.execucao_atual);
}

export function verifyRun(artifactDir) {
  const loaded = loadRun(artifactDir, { verifyReplay: true });
  if (loaded.eventTailIncomplete) {
    throw new TestadorStateError("TRUNCATED_EVENT_TAIL", "events.jsonl ends with an incomplete event; run resume/reconcile to repair it");
  }
  if (loaded.snapshotRecovered) {
    throw new TestadorStateError(
      loaded.snapshotDiverged ? "SNAPSHOT_DIVERGED" : "SNAPSHOT_REPAIR_REQUIRED",
      loaded.snapshotDiverged ? "state.json differs from deterministic event replay" : "state.json is missing, invalid, or behind events.jsonl",
      { snapshotError: loaded.snapshotError },
    );
  }
  const state = loaded.state;
  const events = loaded.events;
  const lastEvent = events.at(-1) ?? null;
  const valid = lastEvent != null && lastEvent.revision === state.revision && lastEvent.eventId === state.lastEventId;
  if (!valid) {
    throw new TestadorStateError("INTEGRITY_ERROR", "state.json does not match the last durable event", {
      stateRevision: state.revision,
      eventRevision: lastEvent?.revision ?? null,
      stateLastEventId: state.lastEventId,
      eventId: lastEvent?.eventId ?? null,
    });
  }
  return { valid: true, artifactDir: resolve(artifactDir), snapshotRecovered: loaded.snapshotRecovered, eventCount: events.length, summary: runSummary(state) };
}

export function statusRun(artifactDir) {
  const loaded = loadRun(artifactDir, { verifyReplay: true });
  return {
    artifactDir: resolve(artifactDir),
    summary: runSummary(loaded.state),
    projectConfig: loaded.state.projectConfig ?? null,
    tasks: loaded.state.tasks,
    completionGates: loaded.state.completionGates ?? null,
    resume: loaded.state.resume,
    integrity: {
      snapshotRecovered: loaded.snapshotRecovered,
      snapshotDiverged: loaded.snapshotDiverged,
      eventTailIncomplete: loaded.eventTailIncomplete,
      snapshotError: loaded.snapshotError,
    },
  };
}

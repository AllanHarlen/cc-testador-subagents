/**
 * Handoff envelope validator — Pensador → Orchestrador → Testador → Executor.
 *
 * Esta e a copia CANONICA, BYTE-IDENTICA do validador replicada nos quatro
 * plugins do workflow, EXCETO pela regra `TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR`
 * que so existe aqui (substituindo a regra `EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL`
 * do executor, que nao se aplica ao testador — o executor ainda e o estagio
 * terminal quando `nextStage: null`).
 *
 * Escopo: `handoffVersion: 1`. Valida a forma estrutural do envelope (campos
 * obrigatorios, enums de `stage`/`status`, vocabulario de `role` por `stage`,
 * consistencia `upstream`/`nextStage`), nao invariantes de negocio do estagio
 * produtor.
 */

export const SUPPORTED_HANDOFF_VERSION = 1;

export const HANDOFF_STAGES = Object.freeze(["pensador", "orchestrador", "testador", "executor"]);

export const HANDOFF_STATUSES = Object.freeze(["DONE", "PARTIAL", "BLOCKED"]);

export const HANDOFF_ROLES_BY_STAGE = Object.freeze({
  pensador: Object.freeze([
    "prd",
    "userhistory",
    "architecture",
    "api-contract",
    "communication-contract",
    "design-system",
    "design-system-files",
    "ui-prototype",
    "brand-assets",
    "openspec-change",
    "codebase-memory",
    "project-baseline",
    "requirements-index",
    "shared-agents",
  ]),
  orchestrador: Object.freeze([
    "implementation-report",
    "tasks-classification",
    "waves",
    "api-contracts",
    "review-final",
    "review-frontend",
    "monitoring",
    "workflow-log",
    "subagents-context",
    "openspec-change",
  ]),
  testador: Object.freeze([
    "test-plan",
    "coverage-matrix",
    "flow-map",
    "test-report",
    "a11y-report",
    "uiux-report",
    "coverage-report",
    "design-conformance",
    "specs",
    "playwright-report",
    "screenshots",
    "monitoring",
    "workflow-log",
    "subagents-context",
    "implementation-report",
  ]),
  executor: Object.freeze([
    "initial-plan-baseline",
    "execution-brief",
    "plan-vs-output-review",
    "implementation-report",
    "workflow-log",
    "subagents-context",
    "monitoring",
    "screenshots",
  ]),
});

export class HandoffValidationError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "HandoffValidationError";
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function validateHandoff(handoff) {
  const errors = [];
  const push = (code, message, path = null) => errors.push({ code, message, path });

  if (!isPlainObject(handoff)) {
    push("INVALID_ENVELOPE", "handoff.json must parse to a JSON object", null);
    return { ok: false, errors };
  }

  if (handoff.handoffVersion !== SUPPORTED_HANDOFF_VERSION) {
    push(
      "UNSUPPORTED_HANDOFF_VERSION",
      `handoffVersion ${JSON.stringify(handoff.handoffVersion)} is not supported (expected ${SUPPORTED_HANDOFF_VERSION}) — consumer should degrade to discovery-by-convention (handoff-contract.md section 8)`,
      "handoffVersion",
    );
    return { ok: false, errors };
  }

  if (!HANDOFF_STAGES.includes(handoff.stage)) {
    push(
      "INVALID_STAGE",
      `stage must be one of ${HANDOFF_STAGES.join(", ")}, got ${JSON.stringify(handoff.stage)}`,
      "stage",
    );
  }

  if (!isNonEmptyString(handoff.slug)) {
    push("INVALID_SLUG", "slug must be a non-empty string", "slug");
  }

  if (!isPlainObject(handoff.producer) || !isNonEmptyString(handoff.producer.plugin) || !isNonEmptyString(handoff.producer.version)) {
    push("INVALID_PRODUCER", "producer must be { plugin: string, version: string }", "producer");
  }

  if (!isNonEmptyString(handoff.artifactRoot)) {
    push("INVALID_ARTIFACT_ROOT", "artifactRoot must be a non-empty string", "artifactRoot");
  }

  if (!HANDOFF_STATUSES.includes(handoff.status)) {
    push(
      "INVALID_STATUS",
      `status must be one of ${HANDOFF_STATUSES.join(", ")}, got ${JSON.stringify(handoff.status)}`,
      "status",
    );
  }

  if (!isIsoTimestamp(handoff.createdAt)) {
    push("INVALID_CREATED_AT", "createdAt must be a valid ISO timestamp string", "createdAt");
  }

  if (!isIsoTimestamp(handoff.updatedAt)) {
    push("INVALID_UPDATED_AT", "updatedAt must be a valid ISO timestamp string", "updatedAt");
  }

  if (!isNonEmptyString(handoff.summary)) {
    push("INVALID_SUMMARY", "summary must be a non-empty string", "summary");
  }
  if (["PARTIAL", "BLOCKED"].includes(handoff.status) && isNonEmptyString(handoff.summary) && handoff.summary.trim().length < 10) {
    push(
      "SUMMARY_TOO_SHORT_FOR_NON_DONE_STATUS",
      `status ${handoff.status} requires a summary that actually explains the gap/blocker, got a near-empty string`,
      "summary",
    );
  }

  // Optional structured waiver (WF-010): an accepted-risk record for a
  // PARTIAL/BLOCKED status, distinct from `summary` (a human sentence) —
  // this is the field automation/audits can key on: who accepted the risk,
  // why, what it costs, until when, and what reopens it. Only validated
  // when present; a PARTIAL/BLOCKED handoff without a waiver is still valid
  // (not every gap is a formally accepted risk — some are just open work).
  if (handoff.waiver !== undefined && handoff.waiver !== null) {
    if (!["PARTIAL", "BLOCKED"].includes(handoff.status)) {
      push("WAIVER_REQUIRES_NON_DONE_STATUS", "waiver is only meaningful when status is PARTIAL or BLOCKED", "waiver");
    }
    if (!isPlainObject(handoff.waiver)) {
      push("INVALID_WAIVER", "waiver must be an object", "waiver");
    } else {
      if (!isNonEmptyString(handoff.waiver.owner)) {
        push("INVALID_WAIVER", "waiver.owner must be a non-empty string (who accepted the risk)", "waiver.owner");
      }
      if (!isNonEmptyString(handoff.waiver.motivo)) {
        push("INVALID_WAIVER", "waiver.motivo must be a non-empty string (why the waiver was necessary)", "waiver.motivo");
      }
      if (!isNonEmptyString(handoff.waiver.impacto)) {
        push("INVALID_WAIVER", "waiver.impacto must be a non-empty string (what stays uncovered because of it)", "waiver.impacto");
      }
      if (handoff.waiver.validade !== null && !isNonEmptyString(handoff.waiver.validade)) {
        push("INVALID_WAIVER", "waiver.validade must be an ISO timestamp string or null (no deadline)", "waiver.validade");
      } else if (isNonEmptyString(handoff.waiver.validade) && Number.isNaN(Date.parse(handoff.waiver.validade))) {
        push("INVALID_WAIVER", "waiver.validade must be a valid ISO timestamp string when present", "waiver.validade");
      }
      if (!isNonEmptyString(handoff.waiver.condicaoDeReabertura)) {
        push(
          "INVALID_WAIVER",
          "waiver.condicaoDeReabertura must be a non-empty string (what needs to happen to reopen/revalidate)",
          "waiver.condicaoDeReabertura",
        );
      }
    }
  }

  if (handoff.upstream !== null) {
    if (!isPlainObject(handoff.upstream) || !HANDOFF_STAGES.includes(handoff.upstream.stage) || !isNonEmptyString(handoff.upstream.handoffPath)) {
      push(
        "INVALID_UPSTREAM",
        "upstream must be null or { stage: one of pensador|orchestrador|testador|executor, handoffPath: string }",
        "upstream",
      );
    } else if (handoff.stage === "pensador") {
      push("PENSADOR_CANNOT_HAVE_UPSTREAM", "stage pensador is the first stage in the chain — upstream must be null", "upstream");
    }
  }

  if (!Array.isArray(handoff.artifacts)) {
    push("INVALID_ARTIFACTS", "artifacts must be an array", "artifacts");
  } else {
    const validRoles = HANDOFF_ROLES_BY_STAGE[handoff.stage] ?? null;
    handoff.artifacts.forEach((artifact, index) => {
      const path = `artifacts[${index}]`;
      if (!isPlainObject(artifact)) {
        push("INVALID_ARTIFACT_ENTRY", `${path} must be an object`, path);
        return;
      }
      if (!isNonEmptyString(artifact.role)) {
        push("INVALID_ARTIFACT_ROLE", `${path}.role must be a non-empty string`, `${path}.role`);
      } else if (validRoles && !validRoles.includes(artifact.role)) {
        push(
          "UNKNOWN_ARTIFACT_ROLE",
          `${path}.role ${JSON.stringify(artifact.role)} is not a valid role for stage ${JSON.stringify(handoff.stage)} (accepted: ${validRoles.join(", ")})`,
          `${path}.role`,
        );
      }
      if (!isNonEmptyString(artifact.path)) {
        push("INVALID_ARTIFACT_PATH", `${path}.path must be a non-empty string`, `${path}.path`);
      }
      if (typeof artifact.required !== "boolean") {
        push("INVALID_ARTIFACT_REQUIRED", `${path}.required must be a boolean`, `${path}.required`);
      }
    });
  }

  if (handoff.artifactMode != null) {
    if (!["prd", "spec"].includes(handoff.artifactMode)) {
      push("INVALID_ARTIFACT_MODE", `artifactMode must be "prd" or "spec" when present, got ${JSON.stringify(handoff.artifactMode)}`, "artifactMode");
    }
    if (handoff.stage !== "pensador") {
      push("ARTIFACT_MODE_ONLY_ON_PENSADOR", "artifactMode is only emitted by stage pensador (handoff-contract.md section 4)", "artifactMode");
    }
  }

  if (handoff.nextStage !== null) {
    if (!isPlainObject(handoff.nextStage) || !isNonEmptyString(handoff.nextStage.consumer) || !isNonEmptyString(handoff.nextStage.entrypoint)) {
      push("INVALID_NEXT_STAGE", "nextStage must be null or { consumer: string, entrypoint: string, instructions?: string }", "nextStage");
    }
    if (handoff.stage === "executor") {
      push("EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL", "stage executor is the last stage in the chain — nextStage should normally be null", "nextStage");
    }
    if (handoff.stage === "testador") {
      const consumer = handoff.nextStage?.consumer;
      if (consumer && consumer !== "cc-executor-subagents") {
        push(
          "TESTADOR_NEXT_STAGE_MUST_BE_NULL_OR_EXECUTOR",
          "stage testador may only point nextStage to cc-executor-subagents (or null for standalone runs)",
          "nextStage",
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Catalogo de gates do Testador.
 *
 * Mirrors the pattern of cc-executor-subagents/lib/gates.mjs:
 * planGates(context) returns { gates, skipped } where every gate is
 * { id, phase, blocking: true, kind, command, reason }.
 *
 * kind: "script" -> command carries the exact argv array (node + script path
 *   + placeholders). The caller substitutes {artefatos_dir} / {task_id} /
 *   {test_result_file} before executing.
 *
 * kind: "action" -> command is null; the prose in `reason` describes what
 *   the agent must do manually (e.g. drive the browser via Playwright MCP).
 *
 * CRITICAL: invalid scope FAILS CLOSED with INVALID_SCOPE -- never defaults
 * to the most permissive answer (SMOKE would skip most verification).
 */

export const VALID_SCOPES = Object.freeze(["SMOKE", "STANDARD", "FULL"]);

export class GatesError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "GatesError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Planeja os gates para uma run do Testador.
 *
 * @param {object} context
 * @param {"SMOKE"|"STANDARD"|"FULL"} context.scope
 * @param {boolean} [context.hasFrontend]        True quando ha front-end.
 * @param {boolean} [context.hasApi]             True quando ha API back-end.
 * @param {boolean} [context.separateOrigin]     True quando front e back estao em origens separadas.
 * @param {boolean} [context.jointMode]          True quando rodando em modo conjunto (com upstream handoff).
 * @param {boolean} [context.hasOpenSpec]        True quando ha change set OpenSpec.
 * @param {boolean} [context.hasOpenDesign]      True quando ha Open Design.
 * @param {boolean} [context.a11yBlocking]       True quando violacoes axe bloqueiam.
 * @returns {{ gates: Gate[], skipped: SkippedGate[] }}
 */
export function planGates(context = {}) {
  const { scope, hasFrontend, hasApi, separateOrigin, jointMode, hasOpenSpec, hasOpenDesign, a11yBlocking } = context;

  if (!VALID_SCOPES.includes(scope)) {
    throw new GatesError(
      "INVALID_SCOPE",
      `scope must be one of ${VALID_SCOPES.join(", ")}, got ${JSON.stringify(scope)}`,
      { accepted: [...VALID_SCOPES], received: scope },
    );
  }

  const gates = [];
  const skipped = [];

  const script = (id, phase, scriptName, placeholders, reason) => ({
    id,
    phase,
    blocking: true,
    kind: "script",
    command: Object.freeze([
      "node",
      `\${CLAUDE_SKILL_DIR}/scripts/${scriptName}`,
      ...placeholders,
    ]),
    reason,
  });

  const action = (id, phase, reason) => ({
    id,
    phase,
    blocking: true,
    kind: "action",
    command: null,
    reason,
  });

  const skip = (id, reason) => skipped.push({ id, reason });

  // -----------------------------------------------------------------------
  // Phase 4: Stack
  // -----------------------------------------------------------------------
  gates.push(action(
    "stack-up",
    4,
    "Bring the app stack up (docker compose up --build or npm run dev). A failed stack is itself a blocking finding.",
  ));

  // -----------------------------------------------------------------------
  // Phase 5: MCP smoke exploration
  // -----------------------------------------------------------------------
  gates.push(action(
    "mcp-smoke",
    5,
    "Drive critical user flows via Playwright MCP (browser_navigate, browser_snapshot, browser_find, browser_console_messages --level error, browser_network_requests). Produce flow-map.json.",
  ));

  if (scope === "SMOKE") {
    // SMOKE: stack + smoke only. Report and handoff still required.
    skip("generate-specs", "SMOKE scope: deterministic specs not generated");
    skip("run-specs", "SMOKE scope: skipped");
    skip("a11y-scan", "SMOKE scope: skipped");
    skip("design-conformance", "SMOKE scope: skipped");
    skip("uiux-review", "SMOKE scope: skipped");
    skip("coverage-check", "SMOKE scope: skipped");
    skip("triage", "SMOKE scope: triage still runs but only on MCP findings");
    gates.push(action("report-review", 10, "Subagente read-only: confere evidencia vs conclusoes do laudo."));
    gates.push(script("handoff-validate", 11, "validate-handoff.mjs", ["--file", "{artefatos_dir}/handoff.json"], "Validate the handoff.json envelope before emitting DONE."));
    return { gates, skipped };
  }

  // -----------------------------------------------------------------------
  // Phase 6: Spec generation (STANDARD and FULL)
  // -----------------------------------------------------------------------
  gates.push(script(
    "generate-specs",
    6,
    "generate-specs.mjs",
    ["--flow-map", "{artefatos_dir}/plan/flow-map.json", "--coverage-matrix", "{artefatos_dir}/plan/coverage-matrix.json", "--dir", "{artefatos_dir}"],
    "Generate deterministic Playwright specs from flow-map.json + coverage-matrix.json.",
  ));

  // -----------------------------------------------------------------------
  // Phase 7: Execution
  // -----------------------------------------------------------------------
  gates.push(script(
    "run-specs",
    7,
    "run-specs.mjs",
    ["--dir", "{artefatos_dir}"],
    "Run generated specs with npx playwright test and collect JSON/JUnit reports.",
  ));

  if (hasFrontend) {
    gates.push(script(
      "a11y-scan",
      7,
      "collect-a11y-results.mjs",
      ["--dir", "{artefatos_dir}"],
      "Run @axe-core/playwright on all planned routes and emit structured a11y report.",
    ));
  } else {
    skip("a11y-scan", "hasFrontend is false: no front-end to scan for accessibility");
  }

  gates.push(script(
    "collect-results",
    7,
    "collect-test-results.mjs",
    ["--dir", "{artefatos_dir}", "--input", "{test_result_file}"],
    "Parse JUnit/JSON test reports and attach evidenceId to the run.",
  ));

  // -----------------------------------------------------------------------
  // Phase 8: UI/UX + Open Design (STANDARD and FULL, frontend only)
  // -----------------------------------------------------------------------
  if (hasFrontend) {
    if (hasOpenDesign) {
      gates.push(script(
        "design-conformance",
        8,
        "check-design-conformance.mjs",
        ["--dir", "{artefatos_dir}"],
        "Check token conformance (var(--*) vs hex literals, invented tokens, accent overuse) and preview structural comparison against the Open Design proposal.",
      ));
    } else {
      skip("design-conformance", "hasOpenDesign is false: no Open Design tokens to validate against");
    }

    gates.push(action(
      "uiux-review",
      8,
      "Subagente read-only usando frontend-design + ui-ux-pro-max: verifica piso de qualidade (responsivo ate mobile, foco de teclado visivel, prefers-reduced-motion), detecta cliches de design de IA e confere criterios de UI/UX. Reportar em Skills utilizadas.",
    ));
  } else {
    skip("design-conformance", "hasFrontend is false");
    skip("uiux-review", "hasFrontend is false");
  }

  // -----------------------------------------------------------------------
  // Phase 9: Coverage check (only when formal requirements exist)
  // -----------------------------------------------------------------------
  if (hasOpenSpec || jointMode) {
    gates.push(script(
      "coverage-check",
      9,
      "build-coverage-matrix.mjs",
      ["--dir", "{artefatos_dir}"],
      "Verify every traceable requirement/Scenario has a corresponding test case (COVERED or explicitly MANUAL).",
    ));
  } else {
    skip("coverage-check", "no formal requirement source (no OpenSpec, not in joint mode): spec-coverage gate will degrade to N/A with a recorded note");
  }

  // -----------------------------------------------------------------------
  // Phase 9: Triage
  // -----------------------------------------------------------------------
  gates.push(script(
    "triage",
    9,
    "triage-findings.mjs",
    ["--dir", "{artefatos_dir}"],
    "Apply the blocking rule: explicit traceable requirement violated -> blocking; undeclared best practice -> informative.",
  ));

  // -----------------------------------------------------------------------
  // Phase 10: Laudo review
  // -----------------------------------------------------------------------
  gates.push(action("report-review", 10, "Subagente read-only: confere que cada conclusao tem evidencia e que nenhum achado bloqueante foi silenciado."));

  // -----------------------------------------------------------------------
  // Phase 11: Handoff validation
  // -----------------------------------------------------------------------
  gates.push(script(
    "handoff-validate",
    11,
    "validate-handoff.mjs",
    ["--file", "{artefatos_dir}/handoff.json"],
    "Validate the handoff.json envelope before emitting DONE.",
  ));

  return { gates, skipped };
}

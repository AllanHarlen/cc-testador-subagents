/**
 * Catalogo de gates do Testador.
 *
 * Mirrors the pattern of cc-executor-subagents/lib/gates.mjs:
 * planGates(context) returns { gates, skipped } where every gate is
 * { id, phase, blocking: true, kind, command, reason }.
 *
 * kind: "script" -> command carries the exact argv array (node + script path
 *   + placeholders). The caller substitutes {artefatos_dir} / {task_id} /
 *   {test_result_file} before executing. Every placeholder here matches a
 *   flag the corresponding canonical CLI actually accepts -- see
 *   COMPLETION_GATE_BY_PLAN_GATE below for the bridge to the durable
 *   completion-gate vocabulary in lib/testador-state.mjs.
 *
 * kind: "action" -> command is null; the prose in `reason` describes what
 *   the agent must do manually (e.g. drive the browser via Playwright MCP).
 *
 * CRITICAL: invalid scope FAILS CLOSED with INVALID_SCOPE -- never defaults
 * to the most permissive answer (SMOKE would skip most verification).
 *
 * Plan gates (this catalog) and completion gates
 * (`COMPLETION_GATE_DEFINITIONS` in lib/testador-state.mjs) are two
 * different vocabularies for two different jobs: plan gates are the
 * per-run checklist of *steps*, completion gates are the durable
 * DONE-blocking record of *outcomes*. `COMPLETION_GATE_BY_PLAN_GATE` is the
 * explicit bridge between them, and `completionGateRequirements()` is the
 * function that turns a plan into "which of the 4 waivable completion
 * gates should be marked required for this run" -- the piece that was
 * previously missing, which let every waivable gate default to
 * `required: false` regardless of what the plan actually demanded.
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
 * Plan gate id -> completion gate id (lib/testador-state.mjs
 * COMPLETION_GATE_DEFINITIONS). Plan gates with no entry here (`generate-specs`,
 * `triage`) feed a completion gate indirectly (through `run-specs`/`collect-results`
 * and `report-review` respectively) and have no direct mapping of their own.
 */
export const COMPLETION_GATE_BY_PLAN_GATE = Object.freeze({
  "stack-up": "stack",
  "mcp-smoke": "smoke",
  "run-specs": "deterministic",
  "collect-results": "deterministic",
  "a11y-scan": "a11y",
  "design-conformance": "uiux",
  // Achado 12.10: nenhuma fase existente abre um navegador para checar token
  // computado, paleta, fonte entregue ou overflow/dominancia de nav por
  // viewport — `design-conformance` acima e estatico (verbatim vs
  // materializado), e a Fase 9.5 do orquestrador so exercita funcao.
  // Mesmo bucket de completion gate que `design-conformance`/`uiux-review`
  // (ambos Fase 8, UI/UX): os tres juntos e que decidem se `uiux` fecha.
  "design-runtime": "uiux",
  "uiux-review": "uiux",
  "coverage-check": "spec-coverage",
  "report-review": "reports",
  "handoff-validate": "reports",
});

/** The 4 waivable completion gates this module can compute applicability for. */
const WAIVABLE_COMPLETION_GATES = Object.freeze(["deterministic", "a11y", "uiux", "spec-coverage"]);

/**
 * Deriva, a partir do resultado de `planGates()`, quais dos 4 completion
 * gates waivable devem ser marcados `required: true` nesta run.
 *
 * Regra: um completion gate e `required: true` se PELO MENOS UM plan gate
 * que o alimenta foi efetivamente planejado (aparece em `gates`); e
 * `required: false` (nao aplicavel a esta run) se TODOS os plan gates que o
 * alimentam foram pulados (aparecem em `skipped`) -- por exemplo `a11y` fica
 * false quando `hasFrontend` e false, porque `a11y-scan` foi pulado por
 * ausencia estrutural de front-end, nao por decisao de waiver.
 *
 * Chamar isto e aplicar o resultado via
 * `testador-state.mjs gate --gate <id> --status PENDING --required <bool>`
 * e o passo que faltava entre planejar (fase 3) e a run poder fechar
 * `DONE`/`RUN_GATES_WAIVED` corretamente: sem isso, todo gate waivable
 * nasce `required: false` e um `N/A` posterior nunca registra waiver.
 *
 * @param {{gates: Array<{id: string}>, skipped: Array<{id: string}>}} planResult
 * @returns {Record<string, boolean>}
 */
export function completionGateRequirements(planResult) {
  const plannedIds = new Set((planResult?.gates ?? []).map((g) => g.id));
  const skippedIds = new Set((planResult?.skipped ?? []).map((s) => s.id));
  const requirements = {};
  for (const completionGateId of WAIVABLE_COMPLETION_GATES) {
    const planGateIds = Object.entries(COMPLETION_GATE_BY_PLAN_GATE)
      .filter(([, mapped]) => mapped === completionGateId)
      .map(([planGateId]) => planGateId);
    const anyPlanned = planGateIds.some((id) => plannedIds.has(id));
    const anySkipped = planGateIds.some((id) => skippedIds.has(id));
    // Se nenhum plan gate desse completion gate aparece em nenhuma das duas
    // listas (nao deveria acontecer com o catalogo atual), a falta de sinal
    // nao vira exigencia -- required so fica true com planejamento explicito.
    requirements[completionGateId] = anyPlanned ? true : (anySkipped ? false : false);
  }
  return requirements;
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
    skip("collect-results", "SMOKE scope: skipped");
    skip("a11y-scan", "SMOKE scope: skipped");
    skip("design-conformance", "SMOKE scope: skipped");
    skip("design-runtime", "SMOKE scope: skipped");
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
    ["--dir", "{artefatos_dir}", "--base-url", "{base_url}"],
    "Generate deterministic Playwright specs from flow-map.json + coverage-matrix.json (read from {artefatos_dir}/plan/).",
  ));

  // -----------------------------------------------------------------------
  // Phase 7: Execution
  // -----------------------------------------------------------------------
  gates.push(script(
    "run-specs",
    7,
    "run-specs.mjs",
    ["--dir", "{artefatos_dir}", "--project-root", "{project_root}", "--base-url", "{base_url}"],
    "Run generated specs with @playwright/test and collect JSON/JUnit reports.",
  ));

  if (hasFrontend) {
    gates.push(script(
      "a11y-scan",
      7,
      "collect-a11y-results.mjs",
      ["--dir", "{artefatos_dir}", "--a11y-blocking", "{a11y_blocking}"],
      "Run @axe-core/playwright on all planned routes and emit structured a11y report.",
    ));
  } else {
    skip("a11y-scan", "hasFrontend is false: no front-end to scan for accessibility");
  }

  gates.push(script(
    "collect-results",
    7,
    "collect-test-results.mjs",
    ["--dir", "{artefatos_dir}"],
    "Parse the Playwright JSON/JUnit report produced by run-specs.mjs into a structured summary.",
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
        ["--dir", "{artefatos_dir}", "--root", "{project_root}"],
        "Check token conformance (var(--*) vs hex literals, invented tokens, accent overuse) and preview structural comparison against the Open Design proposal.",
      ));
      gates.push(script(
        "design-runtime",
        8,
        "check-runtime-design.mjs",
        ["--dir", "{artefatos_dir}", "--root", "{project_root}"],
        "Before running this: drive the running app via Playwright MCP per key route/viewport and inject RUNTIME_DESIGN_PROBE_SCRIPT (lib/runtime-design-probe.mjs) via browser_evaluate, appending each {route, viewport, probe} to {artefatos_dir}/run/design-probes.json. This script then analyzes what was captured — token resolution, palette/scale conformance, font delivery, and viewport layout (overflow, nav dominance, gutter) — and writes {artefatos_dir}/review/design-runtime.json.",
      ));
    } else {
      skip("design-conformance", "hasOpenDesign is false: no Open Design tokens to validate against");
      skip("design-runtime", "hasOpenDesign is false: no Open Design contract to validate at runtime");
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
      ["--root", "{project_root}", "--requirements-index", "{requirements_index_path}", "--openspec-change", "{openspec_change_dir}"],
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
    ["--dir", "{artefatos_dir}", "--a11y-blocking", "{a11y_blocking}", "--has-open-design", "{has_open_design}"],
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

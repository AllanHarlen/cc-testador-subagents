# cc-testador-subagents

Claude Code plugin for real-browser QA between the Orchestrator and the Executor. It adds the skill **`testador-subagents`** and the command **`/testador`**.

📖 **[Documentação em Português](./README.pt-BR.md)** | **Portuguese Documentation**

## Overview

The Testador sits between `/orquestrador` (builds) and `/executor` (fixes), validating in a real browser what the Orchestrator delivered:

- no production-code writes — strictly read-only on the target repo;
- never writes inside `openspec/`, never invokes `/opsx:*`;
- drives critical flows in a real browser via Playwright MCP;
- generates deterministic Playwright specs + `@axe-core/playwright` for regression and real a11y scanning;
- persists per-flow Axe/Playwright evidence; accessibility is informative by default and becomes blocking with `a11yBlocking=true`;
- treats missing or invalid browser evidence as blocking (fail-closed) and updates the deterministic/a11y gates from produced artifacts;
- validates UI/UX against OpenSpec `#### Scenario:` blocks and Open Design tokens;
- triages findings by an explicit blocking rule: **explicit traceable requirement violated → blocking; undeclared best practice → informative**;
- publishes a `handoff.json` pointing at `/executor` so the Executor can consume the test report as a pre-defined plan.

## Position in the workflow chain

```text
cc-pensador  →  cc-orchestrador-subagents  →  cc-testador-subagents  →  cc-executor-subagents
 (thinks)         (builds)                      (validates in browser)     (fixes)
```

The Testador is the third stage in the handoff chain. In joint mode its `handoff.json` points `nextStage` at `cc-executor-subagents`; the Executor adopts the test report as its pre-defined baseline and runs the plan-vs-delivery review.

## The three mandatory skills

Unlike the Executor (whose agent stack is configurable), the Testador's stack is **Claude Code pure** — no Codex, no AGY. The three skills are mandatory, not optional references. Preflight blocks if any of them is absent.

| Skill | Phases | Gates |
|---|---|---|
| `webapp-testing` | 4 (server lifecycle) and 5 (MCP exploration) | `stack`, `smoke` |
| `frontend-design` | 8 (UI/UX review) | `uiux` |
| `ui-ux-pro-max` | 8 (UI/UX review) | `uiux` |

Install:

```bash
npx skills add https://github.com/anthropics/skills --skill webapp-testing
npx skills add https://github.com/anthropics/skills --skill frontend-design
npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max
```

## The hybrid execution model

The Testador combines two complementary approaches because they solve different problems:

**Playwright MCP (phases 4–5)** handles what requires judgment: discovering which flows exist, which selectors are stable, whether a screen looks right, whether an empty state makes sense. It is expensive in tokens and non-deterministic — useless as binary evidence.

**Generated specs (phases 6–7)** handle what requires proof: a binary, repeatable assertion with a JUnit/JSON report that becomes an `evidenceId`. They are the only path to `@axe-core/playwright` as a real library, because `AxeBuilder` needs a `Page` object in a Node process.

A `flow-map.json` artifact produced in phase 5 bridges the two: the exploration confirms selectors and expected assertions, the spec generator consumes them to produce deterministic code. No generated spec is ever written to the target repo — all specs live under `.testador/<slug>/artefatos/run/specs/`.

## The blocking rule

The rule that decides severity is: **the existence of a traceable requirement**, not the tool.

| Finding | Blocking |
|---|---|
| Stack failed to start | Yes |
| CORS error in console | Yes |
| API returned non-2xx | Yes |
| 2xx but UI did not reflect the data | Yes — the classic silent casing-divergence symptom |
| Final effect did not happen | Yes |
| OpenSpec `#### Scenario:` failed | Yes |
| PRD RF/CA not met | Yes |
| API contract shape mismatch | Yes |
| Hex literal where a Design token was expected | Yes |
| Invented token ("never invent new tokens") | Yes |
| Accent appearing more than 2× per page | Yes |
| DESIGN.md §9 anti-pattern | Yes |
| Preview structural divergence | Yes |
| Axe violation (any severity) | **No** — informative by default |
| Quality floor without a declared requirement | No |
| AI design cliché | No |

The only exception that crosses the table: any "No" item whose content has an explicit traceable requirement is **upgraded to blocking** by the triage function, with the requirement cited in `blockingReason`.

## Persistent state and resume

Each run gets its own crash-safe `{artefatos_dir}/state.json` + `events.jsonl` (event fsynced before the snapshot swaps atomically — a crash mid-write is repaired by replay). `.testador/checkpoint.json` is a lightweight index (`execucao_atual`, `historico[]`) pointing at the active run. Resume with:

```bash
/testador resume
```

An interrupted `RUNNING` task always comes back as `UNKNOWN` — never a presumed `FAILED`/`DONE` — and is reconciled against Git/files/validations before anything is re-delegated. See `skills/testador-subagents/references/persistent-state.md`.

## Completion gates

Seven gates must close before a run can be marked `DONE`:

| Gate | Phase | Waivable |
|---|---|---|
| `stack` | 4 | No |
| `smoke` | 5 | No |
| `deterministic` | 7 | Yes |
| `a11y` | 7 | Yes |
| `uiux` | 8 | Yes |
| `spec-coverage` | 9 | Yes |
| `reports` | 11 | No |

A waivable gate explicitly declared `required: true` and then closed as `N/A` is a **waiver** — `RUN_GATES_WAIVED` blocks `DONE`, and the handoff must close as `PARTIAL`, never `DONE`.

## When to use

Use `/testador` after `/orquestrador` delivers and before `/executor` fixes:

- validating that a new feature actually works end-to-end in a real browser;
- checking that Open Design tokens were materialized correctly and no hex literals sneak in;
- verifying that every OpenSpec `#### Scenario:` is covered by a passing test;
- running real `@axe-core/playwright` accessibility scans tied to session authentication;
- producing a blocking/informative findings report the Executor can consume as a plan.

Do not use for trivial 1-2-line edits with no UI surface. For those, `/executor` directly is faster.

## How it works

Simplified flow:

1. preflight — Playwright MCP, browsers, three mandatory skills;
2. upstream ingestion — Orchestrator handoff, OpenSpec, Open Design tokens;
3. target discovery — `baseUrl`, `startCommand`, routes, credential key names;
4. traceable test plan — RF/CA or `#### Scenario:` → coverage matrix;
5. stack up — `docker compose up --build` or `npm run dev` via `webapp-testing`;
6. MCP exploration — smoke, selectors, `flow-map.json` → screenshots;
7. spec generation — deterministic `.spec.mjs` files (never in the target repo);
8. deterministic execution — `run-specs.mjs` (`@playwright/test`) + `@axe-core/playwright`;
9. UI/UX review — `frontend-design` + `ui-ux-pro-max` + Open Design conformance;
10. triage — blocking rule applied, 2xx-without-effect correlator;
11. laudo review — read-only subagent checks evidence vs conclusions;
12. test report + handoff — `test-report.md` + `handoff.json` → `/executor`.

Default subagent routing:

- phase 5: MCP explorer subagent via Playwright MCP (`webapp-testing` skill);
- phase 7: deterministic executor subagent (`run-specs.mjs` / `@playwright/test`);
- phase 8: UI/UX reviewer subagent (`frontend-design` + `ui-ux-pro-max` skills);
- phase 10: read-only report reviewer subagent.

## How the Testador decides the run status

| Triage result | Run status |
|---|---|
| At least 1 blocking finding | `REPROVADO` |
| No blocking findings, but informative findings exist | `APROVADO_COM_RESSALVAS` |
| Zero findings | `APROVADO` |
| A gate was waived or verification was impossible | `PARCIAL` |

The run status determines the `handoff.json` status:

- `REPROVADO` → `BLOCKED` — the Executor treats the report as a pre-defined fix plan;
- `PARCIAL` → `PARTIAL` — signals an incomplete verification;
- `APROVADO` / `APROVADO_COM_RESSALVAS` → `DONE`.

## Prerequisites

Mandatory:

| Item | Check |
|---|---|
| Node.js >= 22 | `node --version` |
| Playwright MCP | `claude mcp add playwright npx @playwright/mcp@latest` |
| Plugin deps (`@playwright/test`, `@axe-core/playwright`) | `npm install --prefix "${CLAUDE_PLUGIN_ROOT}"` — checked via `require.resolve()`, not just `package.json` presence |
| Chromium | `npx playwright install chromium` (runs automatically as a `postinstall` of the step above) |
| Skill `webapp-testing` | `npx skills add https://github.com/anthropics/skills --skill webapp-testing` |
| Skill `frontend-design` | `npx skills add https://github.com/anthropics/skills --skill frontend-design` |
| Skill `ui-ux-pro-max` | `npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max` |
| `Bash(node:*)` and `Bash(npx:*)` | `.claude/settings.json` — remediation only with `preflight --fix-permissions` |

Optional:

| Item | Use |
|---|---|
| Python 3 | Enables `with_server.py` from `webapp-testing`; otherwise `runner/server-lifecycle.mjs` is used |
| `openspec` CLI | Confirms OpenSpec change-set completeness; direct file reading works without it |
| Context7 MCP | Current docs for libs/frameworks/APIs |

Preflight also detects whether Python 3 is on PATH and reports it under
`checks.optional.python3`, together with which lifecycle path is active
(`with_server.py` or `runner/server-lifecycle.mjs`).

Minimum permission in the target project:

```json
{
  "permissions": {
    "allow": [
      "Bash(node:*)",
      "Bash(npx:*)"
    ]
  }
}
```

## Installation

Local:

```text
/plugin marketplace add "c:\Users\allanh\Desktop\Pessoal\Skills\cc-testador-subagents"
/plugin install cc-testador-subagents@cc-testador-subagents
```

GitHub:

```text
/plugin marketplace add AllanHarlen/cc-testador-subagents
/plugin install cc-testador-subagents@cc-testador-subagents
```

Validate:

```text
/testador preflight
```

Preflight is read-only by default. If it reports missing permissions, obtain explicit confirmation and rerun `node scripts/preflight.mjs --fix-permissions`.

For CI, install with `npm ci`, run `npm test`, and run `npm run test:integration` for the local Chromium integration suite. `viewports` and `wcagTags` in `.testador/project-config.md` are forwarded to the runner; only configured viewports are executed.

## Usage

```text
/testador <demand or handoff path>
```

Sub-commands: `help`, `preflight`, `project-config` (alias `config`), `status [dir]`, `resume [dir]`. The Testador keeps its own Project_Config in `.testador/project-config.md`; configuring it does not configure the Executor or the Orchestrator.

```text
/testador validate the clients page delivery
```

```text
/testador validate the checkout flow after the latest Orchestrator build
```

```text
/testador check accessibility and Open Design conformance on the onboarding screen
```

## Layout

```text
cc-testador-subagents/
|-- .claude-plugin/
|   |-- plugin.json
|   `-- marketplace.json
|-- commands/
|   `-- testador.md
|-- runner/                      <- only layer with a Playwright dependency
|   |-- playwright.config.mjs
|   |-- server-lifecycle.mjs
|   `-- fixtures/
|       |-- axe-fixture.mjs
|       |-- console-guard.mjs
|       |-- flow-fixture.mjs
|       `-- network-recorder.mjs
|-- scripts/
|   `-- (17 compatibility wrappers, 1:1 with the canonical CLIs below)
`-- skills/
    `-- testador-subagents/
        |-- SKILL.md
        |-- scripts/
        |   |-- testador-spec.mjs (doc<->code source of truth, not a CLI, no wrapper)
        |   |-- (17 canonical CLIs)
        |   `-- lib/
        |       `-- (21 modules)
        |-- references/
        |   |-- workflow.md
        |   |-- preflight-check.md
        |   |-- project-config.md
        |   |-- persistent-state.md
        |   |-- programmatic-intelligence.md
        |   |-- mcp-context.md
        |   |-- handoff-contract.md
        |   |-- subagent-prompts.md
        |   |-- skills-integration.md
        |   |-- openspec-ingestion.md
        |   |-- open-design-validation.md
        |   |-- a11y-criteria.md
        |   `-- visual-criteria.md
        `-- assets/
            |-- flow-map.schema.json
            |-- handoff.schema.json
            |-- checkpoint-template.json
            |-- test-plan-template.md
            |-- test-report-template.md
            `-- monitoring-template.md
```

Artifacts from a run:

```text
.testador/locadora-veiculos/artefatos/
|-- state.json  events.jsonl  handoff.json  ingested-baseline.md
|-- plan/     test-plan.md  coverage-matrix.json  flow-map.json
|-- run/      monitoring.md  specs/  playwright-report/
|-- review/   test-report.md  a11y-report.md  uiux-report.md
|             coverage-report.md  design-conformance.json  screenshots/
|-- report/   implementation-report.md  workflow-log.md  subagents-context.md
`-- evidence/ <evidenceId>.json
```

## Principles

- **Validate, not build.** The Testador never writes production code or modifies anything in the target repo.
- **Read-only on openspec/.** Never writes inside `openspec/`, never invokes `/opsx:*`. Consumes OpenSpec change-sets read-only as a source of test cases.
- **Three skills are mandatory.** `webapp-testing`, `frontend-design`, and `ui-ux-pro-max` are wired to specific phases and gates — not optional references. Absent = preflight blocks.
- **Explicit requirement violated → blocking. Undeclared best practice → informative.** The same finding can be either, depending on whether a traceable requirement backs it.
- **Hybrid by phase.** MCP for discovery and visual evidence; deterministic specs for provable assertions.
- **Specs stay inside `.testador/`.** No generated file ever reaches the target repo. Verified by `git status --porcelain`.
- **Coverage never faked.** Without a `requirements-index` and without OpenSpec, the `spec-coverage` gate degrades and records the degradation — never reports 100% coverage.
- **Claude Code pure.** No Codex, no AGY. All subagents are native Claude Code Task subagents.

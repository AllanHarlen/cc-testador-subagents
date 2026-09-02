# Changelog

Todas as mudancas notaveis deste plugin sao documentadas aqui.

## [1.0.0] - 2026-09-01 - Primeira versao: QA em navegador real entre Orquestrador e Executor

Cria o `cc-testador-subagents` como quarto estagio da cadeia
`cc-pensador` -> `cc-orchestrador-subagents` -> `cc-testador-subagents` -> `cc-executor-subagents`.
O testador ingere a entrega do Orquestrador (ou um alvo avulso), dirige fluxos criticos num
navegador real via Playwright MCP, gera specs Playwright deterministicos + `@axe-core/playwright`
para regressao e a11y, valida UI/UX contra `#### Scenario:` do OpenSpec e tokens do Open Design, e
devolve um laudo triado ao Executor via `handoff.json`.

- `.claude-plugin/plugin.json` + `marketplace.json` (novo): manifestos do plugin, sem dependencia
  cross-marketplace (stack Claude Code puro, sem Codex/AGY).
- `skills/testador-subagents/scripts/lib/cli-utils.mjs` (novo, copiado verbatim de
  `cc-executor-subagents`): contrato de CLI (`executeJsonCli`, `parseArgs`, `required`,
  `numberArg`, `boolArg`, `jsonArg`, `readJsonFile`) que todo script deste plugin usa.
- `skills/testador-subagents/scripts/lib/intelligence.mjs` (novo, copiado verbatim): envelope
  `{schemaVersion, kind, summary, details, evidenceId, generatedAt}` e persistencia de evidencia.
- `commands/testador.md` + `skills/testador-subagents/SKILL.md` (novo): comando `/testador` e a
  skill que ele carrega.
- `tests/cli-contract.test.mjs`, `tests/manifest-consistency.test.mjs` (novos): trava o contrato de
  CLI e a consistencia de versao entre `plugin.json`/`marketplace.json`/`package.json`.

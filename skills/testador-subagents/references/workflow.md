# Workflow — Testador Subagents

Detalhamento das 11 fases. Ver SKILL.md para a visao geral e tabela de gates.

## Fase 0 — Preflight

Rodar antes de qualquer coisa:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs"
```

As 3 skills (webapp-testing, frontend-design, ui-ux-pro-max), o Playwright MCP e o
Chromium sao **obrigatorios**. Falha = bloquear, mostrar remediacao, perguntar via
AskUserQuestion. Sem caminho "seguir sem".

## Fase 1 — Ingestao

Descubrir o handoff do Orquestrador, subir a chain ate o Pensador e coletar insumos:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ingest-upstream.mjs" [--root .] [--slug <slug>]
```

Modos: joint (handoff Orquestrador encontrado) | standalone (sem upstream) | ambiguous
(varios slugs: pedir confirmacao via AskUserQuestion antes de prosseguir).

## Fase 2 — Descoberta de alvo

Se o Project_Config nao existir ou estiver desatualizado:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/discover-target.mjs" [--root .]
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" write --root .
```

Credenciais: `seedCredentialsRef` guarda referencia (nome de arquivo .env), nunca valor.

## Fase 3 — Plano rastreavel + matriz de cobertura

```bash
node "${CLAUDE_SKILL_DIR}/scripts/build-coverage-matrix.mjs" \
  [--requirements-index <path>] [--openspec-change <dir>] [--root .]
```

Sem fonte formal: gate `spec-coverage` degrada e registra — nunca finge cobertura.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/testador-gates.mjs" plan \
  --scope <SMOKE|STANDARD|FULL> \
  [--has-frontend bool] [--has-api bool] [--separate-origin bool] \
  [--joint-mode bool] [--has-openspec bool] [--has-open-design bool]
```

## Fase 4 — Subida da stack (skill webapp-testing)

Subir a app via `startCommand` do Project_Config. Usar `with_server.py` (Python) ou
`runner/server-lifecycle.mjs` (Node) conforme `serverLifecycle`.

Falha em subir = achado bloqueante `STACK_DOWN`. Gate `stack` fecha ou nao.

## Fase 5 — Exploracao MCP (skill webapp-testing)

Protocolo obrigatorio (ver references/subagent-prompts.md, secao 1):
- `browser_navigate` -> aguardar `networkidle`
- `browser_snapshot` **uma unica vez**
- `browser_find` daí em diante (busca na arvore de a11y, barato)
- `browser_console_messages --level error --filename <path>`
- `browser_network_requests`
- `browser_take_screenshot`

Saida: `{artefatos_dir}/plan/flow-map.json`. Gate `smoke` fecha.

## Fase 6 — Geracao de specs

```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-specs.mjs" --dir {artefatos_dir} [--base-url <url>]
```

Specs escritos em `{artefatos_dir}/run/specs/`. Repo-alvo **intocado**.
Credenciais: nunca como valor literal, sempre `process.env.X`.

## Fase 7 — Execucao deterministica

```bash
TESTADOR_ARTIFACTS_DIR={artefatos_dir} TESTADOR_BASE_URL={baseUrl} \
  npx playwright test --config "${CLAUDE_PLUGIN_ROOT}/runner/playwright.config.mjs"
```

Seguido de:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/collect-test-results.mjs" --dir {artefatos_dir}
node "${CLAUDE_SKILL_DIR}/scripts/collect-a11y-results.mjs" --dir {artefatos_dir}
```

Gates `deterministic` e `a11y` fecham (ou ficam N/A se nao aplicavel).

## Fase 8 — Validacao UI/UX (skills frontend-design + ui-ux-pro-max)

Ver references/subagent-prompts.md, secao 3. Skill ausente = BLOCKED, nao degradacao.

Quando Open Design presente:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-design-conformance.mjs" --dir {artefatos_dir}
```

Gates `uiux` e `spec-coverage` fecham.

## Fase 9 — Triagem

```bash
node "${CLAUDE_SKILL_DIR}/scripts/triage-findings.mjs" --dir {artefatos_dir}
```

Regra de corte: requisito explicito violado = bloqueante, boa pratica nao pedida = informativo.

## Fase 10 — Review do laudo

Subagente read-only (ver references/subagent-prompts.md, secao 4): confere que cada
conclusao tem evidencia e que nenhum bloqueante foi silenciado.

## Fase 11 — Laudo + handoff

Gravar `{artefatos_dir}/review/test-report.md` e `{artefatos_dir}/handoff.json`.
Validar antes de fechar:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-handoff.mjs" --file {artefatos_dir}/handoff.json
```

Status: DONE se APROVADO ou APROVADO_COM_RESSALVAS; PARTIAL se gate waived; BLOCKED se REPROVADO.
Em modo conjunto: `nextStage` aponta para `cc-executor-subagents`.
Gate `reports` fecha.

# Workflow — Testador Subagents

Detalhamento das 12 fases (0 a 11). Ver SKILL.md para a visao geral e tabela de gates.

## Fase 0 — Preflight

Rodar antes de qualquer coisa:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --check-only
```
Se permissoes precisarem ser corrigidas, confirme com o usuario e execute `preflight.mjs --fix-permissions`; sem essa flag a etapa permanece somente leitura.

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
  [--joint-mode bool] [--has-openspec bool] [--has-open-design bool] \
  > {artefatos_dir}/plan/gates-plan.json
```

Logo depois, aplique o resultado (`{gates, skipped}`) ao run ja inicializado na fase 0:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/testador-state.mjs" gates-apply \
  --dir {artefatos_dir} --gates-plan {artefatos_dir}/plan/gates-plan.json
```

Isso determina quais dos 4 completion gates waivable (`deterministic`, `a11y`, `uiux`,
`spec-coverage`) ficam `required: true` nesta run, via
`lib/gates.mjs::completionGateRequirements()`. Sem esse passo, todo gate waivable
nasce `required: false` e um `N/A` posterior nunca registra waiver de verdade — o run
fecharia `DONE` mesmo tendo pulado etapas que o plano exigia. (`testador-state.mjs init`
tambem aceita `--gates-plan` diretamente quando o contexto de escopo ja e conhecido
antes da fase 0; `gates-apply` cobre o caso comum em que o plano so existe apos a
ingestao/descoberta das fases 1-2.)

## Fase 4 — Subida da stack (skill webapp-testing)

Subir a app via `startCommand` do Project_Config. Usar `with_server.py` (Python) ou
`runner/server-lifecycle.mjs` (Node) conforme `serverLifecycle`.

Falha em subir = achado bloqueante `STACK_DOWN`. Gate `stack` fecha ou nao.

## Fase 5 — Exploracao MCP (skill webapp-testing)

Protocolo obrigatorio (ver references/subagent-prompts.md, secao 1):
- `browser_navigate` -> aguardar `networkidle`
- `browser_snapshot` **uma unica vez**
- `browser_find` dai em diante (busca na arvore de a11y, barato)
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
node "${CLAUDE_SKILL_DIR}/scripts/run-specs.mjs" --dir {artefatos_dir} --project-root {project_root} [--base-url <url>] [--viewports <WxH,...>] [--wcag-tags <tags>] [--a11y-blocking <bool>]
```

`run-specs.mjs` e o wrapper canonico do `@playwright/test` do proprio plugin (resolve
`node_modules/@playwright/test/cli.js` na raiz do plugin, sem depender de `npx` estar
no PATH nem instalar nada sob demanda) — preflight (`capabilities.plugin-deps-installed`)
garante que a dependencia esta presente antes desta fase rodar. Seguido de:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/collect-test-results.mjs" --dir {artefatos_dir}
node "${CLAUDE_SKILL_DIR}/scripts/collect-a11y-results.mjs" --dir {artefatos_dir} [--a11y-blocking bool]
```

Gates `deterministic` e `a11y` sao atualizados automaticamente pelos coletores a partir dos artefatos reais. `collect-a11y-results.mjs` devolve `status: "NOT_RUN"` quando `run/axe-results.json` nao existe (o scan do axe nunca rodou) — isso **nao** e equivalente a `PASS`; quando o gate `a11y` for `required: true` (ha front-end), so feche-o como `DONE` se `status` for `PASS` ou `FAIL`. Em `NOT_RUN` com gate obrigatorio, o gate fica `BLOCKED` e a triagem registra `A11Y_SCAN_NOT_RUN` como bloqueante — nunca aprove silenciosamente por ausencia de dados. Ausencia ou invalidez do relatorio Playwright produz finding bloqueante equivalente.

## Fase 8 — Validacao UI/UX (skills frontend-design + ui-ux-pro-max)

Ver references/subagent-prompts.md, secao 3. Skill ausente = BLOCKED, nao degradacao.

Quando Open Design presente:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-design-conformance.mjs" --dir {artefatos_dir}
```

Gate `uiux` fecha. `spec-coverage` fecha na fase 9 (build-coverage-matrix.mjs roda de
novo, agora com o resultado da execucao para confirmar cobertura de fato, nao apenas
planejada) — ver `lib/gates.mjs::COMPLETION_GATE_BY_PLAN_GATE`.

## Fase 9 — Triagem

```bash
node "${CLAUDE_SKILL_DIR}/scripts/triage-findings.mjs" --dir {artefatos_dir} \
  [--a11y-blocking bool] [--has-open-design bool]
```

Regra de corte: requisito explicito violado = bloqueante, boa pratica nao pedida =
informativo. `--has-open-design true` torna as 5 categorias `DESIGN_*` sempre
bloqueantes (existe um contrato de tokens declarado para violar); sem essa flag, elas
seguem a regra generica (bloqueante somente com requisito rastreavel). O correlacionador
2xx-sem-efeito-na-UI le `{artefatos_dir}/run/network-calls.jsonl`, gravado pelos specs
gerados via `runner/fixtures/flow-fixture.mjs::persistFlowEvidence` durante a fase 7.

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

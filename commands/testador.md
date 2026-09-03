---
description: Validar em navegador real a entrega do Orquestrador (ou um alvo avulso) antes do Executor corrigir. Roda Playwright MCP para exploracao, gera specs deterministicos + axe-core para regressao e a11y, confere UI/UX contra OpenSpec/Open Design, e devolve um laudo triado com handoff para o Executor.
argument-hint: "help | preflight | project-config | status | resume [dir] | <demanda ou caminho do handoff>"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Agent, TaskCreate, TaskUpdate, TaskList, Skill
---

# /testador

Inicia o **Testador Subagents** para validar em navegador real a entrega descrita em `$ARGUMENTS`.

Este comando fica entre `/orquestrador` (constroi) e `/executor` (corrige): ele nao implementa nada,
nao escreve em `openspec/`, nao roda as suites existentes do projeto. Ele confere o que foi
construido contra requisitos rastreaveis (RF/CA do PRD, `#### Scenario:` do OpenSpec, tokens do
Open Design), dirige fluxos criticos num navegador real via Playwright MCP, gera evidencia
deterministica com Playwright + `@axe-core/playwright`, e devolve um laudo classificado.

Nota de permissao: este comando declara `Bash` amplo porque o testador precisa subir a stack do
projeto (`docker compose`, `npm run dev`), instalar browsers do Playwright e rodar `npx playwright
test`. Mesmo assim, use comandos destrutivos somente com autorizacao explicita do usuario.

Para produzir uma especificacao antes de implementar, use `/pensador`; para construir a partir de um
PRD pronto, use `/orquestrador`; para corrigir o que este comando reprovar, use `/executor`.

## Sinopse

```text
/testador <demanda ou caminho de handoff>   valida a entrega em navegador real
/testador help                              esta ajuda
/testador preflight                         valida dependencias e encerra
/testador project-config                     mostra/altera a configuracao de teste do projeto
/testador status [dir]                       estado da execucao, read-only
/testador resume [dir]                       retoma a execucao interrompida
```

## Subcomandos reservados

Interceptam o argumento: se `$ARGUMENTS` comeca com um destes, a demanda **nao** e ingerida.

| Subcomando | O que faz | Executa |
|---|---|---|
| `help` | imprime a Sinopse acima e encerra | nada |
| `preflight` | valida Playwright MCP, browsers, as 3 skills obrigatorias e mostra status/falhas/remediacao | `scripts/preflight.mjs` |
| `project-config` (alias `config`) | mostra e altera a configuracao de teste do projeto | `scripts/project-config.mjs` |
| `status [dir]` | estado da execucao, sem reparar nem reconciliar | `scripts/testador-state.mjs status` |
| `resume [dir]` | repara, reconcilia e retoma da fase gravada | `scripts/testador-state.mjs resume` |

> A Project_Config do Testador vive em `.testador/project-config.md` e e **propria do Testador** —
> nao e a mesma configuracao do Executor (`.executor/project-config.md`) nem do Orquestrador.

## Modo help

Imprima a Sinopse e a tabela de Subcomandos reservados. Nao rode script nenhum e encerre.

## Modo status

Se o primeiro argumento for `status`, mostre o estado da execucao sem muta-lo:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/testador-state.mjs" status [--dir <artefatos_dir>]
```

Sem `--dir`, resolve a execucao ativa por `execucao_atual` do indice (`.testador/checkpoint.json`).
Este modo e **read-only**.

## Modo preflight

Se `$ARGUMENTS` for exatamente `preflight`, rode apenas:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --check-only
```

Mostre `status`, falhas obrigatorias (incluindo as 3 skills — `webapp-testing`, `frontend-design`,
`ui-ux-pro-max` — que sao obrigatorias, nao opcionais), avisos e remediacao. Depois encerre.

## Modo project-config

Se o primeiro argumento for `project-config`, este ramo substitui a execucao da demanda.

1. Mostre a configuracao vigente e a origem:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/project-config.mjs" show --root "."
   ```

2. Se `show` retornar `ok: false` com erro do parser, apresente o erro nomeando campo, valor
   recebido e caminho, e ofereca por `AskUserQuestion` a regravacao a partir de novas respostas.

3. Apresente as perguntas de `AskUserQuestion` para os campos de `references/project-config.md`
   (baseUrl, apiBaseUrl, startCommand, wcagTags, a11yBlocking, viewports, seedCredentialsRef,
   serverLifecycle), com o **valor detectado** por `discover-target.mjs` como default quando
   houver.

4. Grave:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/project-config.mjs" write --root "." \
     --base-url "<url>" --api-base-url "<url>" --start-command "<comando>" \
     --wcag-tags "<tags>" --a11y-blocking "<bool>" --viewports "<lista>" \
     --seed-credentials-ref "<referencia>" --server-lifecycle "<auto|python|node>"
   ```

5. Rode o preflight uma vez, sempre.

O preflight é não mutante por padrão. Se houver falha de permissão, peça confirmação explícita e só então execute `node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --fix-permissions`.

## Modo resume

Se o primeiro argumento for `resume`, este ramo substitui o inicio de uma execucao nova:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/testador-state.mjs" resume [--dir <artefatos_dir>]
```

O comando faz: reparo de tail de evento incompleto -> replay -> qualquer task `RUNNING`
interrompida vira `UNKNOWN` (nunca `FAILED`/`DONE` presumido) -> reconciliacao contra
Git/arquivos/validacoes -> devolve `resumeFromPhase`. Nao trate `resume` como demanda nova.

## Execucao normal

1. Rode o preflight:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --check-only
   ```

   As 3 skills (`webapp-testing`, `frontend-design`, `ui-ux-pro-max`), o Playwright MCP e os
   browsers sao **obrigatorios**. Se `status: "failed"`, mostre `remediation` (inclui os comandos
   exatos `npx skills add ...` e `claude mcp add playwright ...`) e pergunte via `AskUserQuestion`
   se o usuario quer corrigir e tentar de novo, ou cancelar. Nao ha caminho "seguir sem".

2. Carregue a skill:

   ```text
   Skill(skill="cc-testador-subagents:testador-subagents")
   ```

   Se a tool de Skill recusar por `disable-model-invocation: true`, leia
   `${CLAUDE_PLUGIN_ROOT}/skills/testador-subagents/SKILL.md` e siga diretamente.

3. Siga o fluxo de 12 fases (0-11) documentado no SKILL.md: preflight -> ingestao (handoff do Orquestrador, OpenSpec,
   Open Design) -> descoberta de alvo -> plano rastreavel -> stack -> exploracao MCP -> geracao de
   specs -> execucao determinística -> validacao UI/UX -> triagem -> review do laudo -> laudo +
   handoff.

4. Ao final, publique `{artefatos_dir}/review/test-report.md` e `{artefatos_dir}/handoff.json`. Se
   o status for `REPROVADO` ou `PARCIAL`, informe explicitamente que o proximo passo e
   `/executor` consumindo o laudo como plano pre-definido.

## Quando nao usar

Se nao houver front-end nem API para validar em navegador (ex: mudanca puramente de infra/CLI),
avise que o testador nao se aplica e sugira `/executor` direto para verificacao local.

## Comunicacao

Use updates curtos:

- "preflight OK; Playwright MCP e as 3 skills obrigatorias validadas";
- "ingestao concluida: modo conjunto, handoff do Orquestrador, OpenSpec com 4 Scenarios";
- "stack de pe; explorando login + CRUD via MCP";
- "specs gerados e executados; axe rodou em 3 rotas";
- "laudo: REPROVADO, 2 achados bloqueantes (CORS, token inventado), handoff pronto para /executor".

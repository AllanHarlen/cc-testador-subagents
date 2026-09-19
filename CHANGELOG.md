# Changelog

Todas as mudancas notaveis deste plugin sao documentadas aqui.

## [1.3.0] - 2026-09-19 - Guard do estado da run, handoff validado no DONE e sync com cc-pensador 2.28/2.29

Endurece o plugin contra as falhas observadas numa run real do Pensador (OficinaAI, sessao
`oficinaai-dd`, 2026-09-18): etapas delegadas a um fork em segundo plano (74 min sem progresso),
checkpoint movido a mao de `INIT` para `DONE` pulando seis estagios, e um `handoff.json` escrito a
mao que reprovava em `validate-handoff.mjs` apresentado como "PRD completo". O estado deste plugin
ja e event-sourced e gated; o que faltava era impedir o contorno manual e validar o handoff no fechamento.

- **Novo hook `PreToolUse`** (`hooks/hooks.json` → `scripts/guard-state.mjs`, decisao em
  `lib/state-guard.mjs`): bloqueia `Edit`/`Write`/`MultiEdit` e escritas via Bash/PowerShell em
  `state.json`, `events.jsonl` e `.state.lock` dentro de `.testador/`. Leituras e o proprio `testador-state.mjs`
  passam; falha aberta. O `verify`/replay do CLI continua sendo a rede de seguranca.
- **`run --status DONE` valida o handoff**: se `handoff.json` existe na pasta da run e reprova em
  `validateHandoff()` (ou nao e JSON), o fechamento falha com `HANDOFF_INVALID`. Sem `handoff.json`
  (run avulsa) nada muda.
- **SKILL**: nova secao "Execucao no fio principal e estado so via CLI" — proibe delegar a conducao a
  fork/segundo plano/`ScheduleWakeup`/`/loop`, proibe editar o estado a mao, exige validar o handoff e
  obriga o recap final a declarar o que foi pulado, dispensado ou degradado (nunca "concluido" com lacunas).
- Sync com o contrato do `cc-pensador` 2.28: role `ui-prototype` removido de `HANDOFF_ROLES_BY_STAGE.pensador`
  e do `handoff-contract.md` (byte-identico nos 4 plugins).
- Corrige `references/mcp-context.md` (acentos vazados que quebravam o teste de convencao sem-acento do SKILL/references) e a contagem de CLIs/modulos nos READMEs.
- Testes: `tests/state-guard.test.mjs`, `tests/handoff-gate-on-done.test.mjs`.

## [1.2.2] - 2026-09-12 - Integração e diretrizes do Context7 MCP para testes

- `skills/testador-subagents/references/mcp-context.md`: ampliação completa da seção do Context7 MCP para consulta de documentação oficial de frameworks de teste (Playwright, axe-core, Vitest, Jest, Mock Service Worker).
- Adicionadas regras de Single-Concept Scoping, seleção canônica versionada no formato `/org/project/version`, pontuação oficial e limite de 3 chamadas.
- `skills/testador-subagents/references/subagent-prompts.md`: inclusão da regra 4 instruindo subagentes a consultarem documentação oficial de libs de teste quando disponíveis.

## [1.2.1] - 2026-09-12 - Contrato de handoff visual: novos roles `ui-prototype`/`brand-assets`

Sincronizacao com a extensao aditiva v1 do pacote visual resolvido (`references/handoff-contract.md`
secao 10) publicada por `cc-pensador`, `cc-orchestrador-subagents` e `cc-executor-subagents` na
mesma leva.

- `references/handoff-contract.md`: adicionados os roles `ui-prototype` (`prototypes/`) e
  `brand-assets` (`assets/`, com `assets/manifest.json`) na tabela de artefatos do estagio DESIGN.
- `skills/testador-subagents/scripts/lib/handoff-validator.mjs`: `ui-prototype` e `brand-assets`
  passam a validar como roles conhecidos do vocabulario por estagio.
- `tests/docs-links.test.mjs`: o teste de citacoes `assets/*` deixa de varrer `handoff-contract.md`
  — o documento descreve, por contrato, caminhos dentro do pacote resolvido de um *produtor*
  (Pensador), nao assets proprios do Testador.

## [1.1.1] - 2026-09-03 - Sincronizacao pos-cloud: gate de a11y honesto, ingest sem off-by-one, preflight nao mutante

Correcoes encontradas numa revisao de bugs/performance/gaps de negocio apos os tres plugins
irmaos sincronizarem `HANDOFF_STAGES`/`handoff-contract.md` com o estagio Testador
(ver changelog de `cc-pensador`, `cc-orchestrador-subagents` e `cc-executor-subagents` na mesma
data). Nenhuma mudanca de superficie de comando; todas as correcoes sao de comportamento interno.

- `skills/testador-subagents/references/handoff-contract.md` (alterado, replicado byte-a-byte
  nos quatro plugins): a secao 9 afirmava que `assets/handoff.schema.json` e
  `scripts/lib/handoff-validator.mjs` sao byte-identicos nos quatro plugins — falso (schemas tem
  checksums e contagem de linhas diferentes; o validador tem divergencias pontuais documentadas
  como intencionais, ex. regra de `nextStage` do Executor). A secao agora declara a garantia real:
  byte-identidade e exigencia so deste arquivo (secao 8); schema e validador sao cobertos por
  equivalencia semantica testada contra a tabela de roles.
- `skills/testador-subagents/scripts/lib/axe-report.mjs` (alterado): `collectAxeResults()`
  descartava o `found:false` de `parseAxeReport()` e sempre reportava `status: "PASS"` quando
  `run/axe-results.json` nao existia — um scan de acessibilidade que nunca rodou aprovava
  silenciosamente. Agora devolve `status: "NOT_RUN"` e `scanExecuted: false` nesse caso;
  `references/workflow.md` (Fase 7) instrui a nao fechar o gate `a11y` obrigatorio como `DONE`
  quando o status for `NOT_RUN`.
- `skills/testador-subagents/scripts/lib/upstream-ingest.mjs` (alterado): `openSpecChangeName`
  usava `dirname(openSpecChangePath).split(/[\\/]/).at(-1)`, que devolvia o nome do diretorio
  **pai** (`"changes"`) em vez do nome do change set (`"add-login"`) — off-by-one confirmado
  empiricamente. Corrigido para `basename(openSpecChangePath)`.
- `skills/testador-subagents/scripts/preflight.mjs` (alterado): rodava
  `autoRemediateTestadorBashPermission()` incondicionalmente, escrevendo em
  `.claude/settings.json` do projeto-alvo mesmo quando o chamador so queria consultar o estado.
  Novo flag `--check-only`/`--dry-run` reporta sem gravar (`references/preflight-check.md`).
- `tests/axe-report.test.mjs`, `tests/upstream-ingest.test.mjs` (alterados): cobrem os dois
  fixes acima (`status: "NOT_RUN"` e `openSpecChangeName` correto).

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

## [1.1.0] - 2026-09-02 - Fase 7 executavel, injecao fechada, gates reconciliados

Corrige os bloqueadores que impediam a fase 7 (execucao deterministica) de rodar, fecha
a injecao de codigo no gerador de specs, e reconcilia a camada de gates/triagem com a
regra de corte documentada.

- `package.json` (alterado): declara `@playwright/test@1.62.1` e `@axe-core/playwright@4.13.0`
  como `dependencies` pinadas (antes ausentes; a fase 7 nao tinha como executar). Adiciona
  `postinstall: playwright install chromium`.
- `skills/testador-subagents/scripts/collect-test-results.mjs`, `run-specs.mjs`,
  `testador-probe.mjs` (novos): os tres CLIs canonicos que os wrappers de `scripts/`
  ja referenciavam sem existir. `run-specs.mjs` executa `@playwright/test` via
  `node_modules/@playwright/test/cli.js`, sem `npx`/shell.
  `skills/testador-subagents/scripts/lib/playwright-report.mjs` (antes codigo morto)
  passa a ter consumidor.
- `runner/fixtures/flow-fixture.mjs` (novo): fixture combinado (`consoleErrors` +
  `apiCalls` + `domAssertions` + persistencia em `run/network-calls.jsonl`) que os specs
  gerados agora importam — corrige o fixture inexistente que quebrava toda execucao.
  `console-guard.mjs`/`network-recorder.mjs`/`axe-fixture.mjs` exportam a funcao de
  fixture separadamente para permitir composicao.
- `skills/testador-subagents/scripts/lib/spec-generator.mjs` (reescrito): todo valor
  dinamico de `flow-map.json`/`coverage-matrix.json` passa por `JSON.stringify` (nunca
  `replace()` manual) antes de entrar no `.spec.mjs` gerado — fecha os quatro pontos de
  injecao de codigo do gerador anterior. Valida `process.env.NOME` por regex de match
  completo. Rejeita `artefatosDir` fora de uma arvore `.testador/` (`assertInsideTestadorRoot`).
- `runner/playwright.config.mjs`: projeto `chromium-mobile` forca `browserName: "chromium"`
  (antes herdava WebKit do descritor `devices["iPhone 12"]`, incompativel com o unico
  browser que o preflight instala).
- `runner/server-lifecycle.mjs` (reescrito): `tokenizeCommand` tokeniza `startCommand`
  sem shell, rejeitando metacaractere de shell fora de aspas — fecha a injecao de comando
  que `shell: true` permitia. `killTree` mata a arvore de processos (`taskkill /T /F` no
  Windows, `process.kill(-pid)` em POSIX). Fail-fast quando o processo filho morre antes
  da porta abrir.
- `skills/testador-subagents/scripts/lib/gates.mjs`: `COMPLETION_GATE_BY_PLAN_GATE` e
  `completionGateRequirements()` ligam o plano de gates (fase 3) aos completion gates
  waivable (fase 7-9), via novo comando `testador-state.mjs gates-apply`. Corrige os
  `command` de `generate-specs`/`run-specs`/`coverage-check` para as flags reais das CLIs.
- `skills/testador-subagents/scripts/lib/testador-state.mjs`: guarda de monotonicidade em
  `requiredOverride` (`--unwaive` explicito exigido para reabrir um gate waived). Corrige
  `RUN_GATES_WAIVED` para exigir `status === "N/A"` (antes disparava para qualquer
  `requiredOverride === false`, incluindo gates marcados nao-aplicaveis sem nunca terem
  sido fechados `N/A`).
- `skills/testador-subagents/scripts/lib/finding-triage.mjs` (reescrito): categorias
  `DESIGN_*` so sao always-blocking com `hasOpenDesign: true` (antes sempre bloqueantes,
  invertendo a regra de corte documentada). Achado sem `category` ou com categoria fora
  de `FINDING_CATEGORIES` agora e bloqueante (fail-closed; antes caia em informativo por
  default). Heuristica de requisito rastreavel reescrita por overlap de palavras
  significativas (corrige promocao espuria por stopword). Correlacionador 2xx-sem-efeito
  agora recebe dados reais via `run/network-calls.jsonl`.
- `skills/testador-subagents/scripts/lib/axe-report.mjs`: corrige bug de precedencia de
  operador em `byRule` (`+` antes de `??` produzia `NaN`).
- `skills/testador-subagents/scripts/preflight.mjs`: novo check
  `capabilities.plugin-deps-installed` (`require.resolve()` de `@playwright/test` e
  `@axe-core/playwright`) — o antigo `chromium-installed` inspecionava um cache de
  browsers desconectado do `node_modules` do plugin e nunca detectaria a dependencia ausente.
- Documentacao: referencias corrigidas em `SKILL.md`/`references/*.md` (fase do
  `spec-coverage`, "12 fases" em vez de "11 fases", fixture path, comandos de fase 7/9),
  paridade entre `README.md`/`README.pt-BR.md`, seis vazamentos de acento na convencao
  pt-sem-acentos.
- `tests/docs-links.test.mjs`, `tests/testador-state-cli.test.mjs` (novos): guardas de
  invariante para bijecao wrapper/canonico, resolucao de referencias de doc, contagens do
  Layout, e comportamento de CLI a nivel de processo.

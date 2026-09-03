# cc-testador-subagents

Plugin de Claude Code para validação em navegador real entre o Orquestrador e o Executor. Ele adiciona a skill **`testador-subagents`** e o comando **`/testador`**.

📖 **[English Documentation](./README.md)** | **Documentação em Inglês**

## Visão geral

O Testador fica entre `/orquestrador` (constrói) e `/executor` (corrige), validando em navegador real o que o Orquestrador entregou:

- sem escrita no código de produção — estritamente read-only no repo alvo;
- nunca escreve dentro de `openspec/`, nunca invoca `/opsx:*`;
- dirige fluxos críticos num navegador real via Playwright MCP;
- gera specs Playwright determinísticos + `@axe-core/playwright` para regressão e scan de acessibilidade real;
- valida UI/UX contra `#### Scenario:` do OpenSpec e tokens do Open Design;
- triagem os achados por regra de corte explícita: **requisito explícito rastreável violado → bloqueante; boa prática não declarada → informativo**;
- publica `handoff.json` apontando para `/executor`, que consome o laudo como plano pré-definido.

## Posição na cadeia de workflow

```text
cc-pensador  →  cc-orchestrador-subagents  →  cc-testador-subagents  →  cc-executor-subagents
 (pensa)           (constrói)                    (valida em navegador)      (corrige)
```

O Testador é o terceiro estágio na cadeia de handoff. Em modo conjunto, seu `handoff.json` aponta `nextStage` para `cc-executor-subagents`; o Executor adota o laudo de teste como baseline pré-definido e executa o review plano-vs-entrega.

## As três skills obrigatórias

Diferente do Executor (cuja stack de agentes é configurável), a stack do Testador é **Claude Code puro** — sem Codex, sem AGY. As três skills são obrigatórias, não referência opcional. O preflight bloqueia se qualquer uma estiver ausente.

| Skill | Fases | Gates |
|---|---|---|
| `webapp-testing` | 4 (ciclo de vida do servidor) e 5 (exploração MCP) | `stack`, `smoke` |
| `frontend-design` | 8 (review UI/UX) | `uiux` |
| `ui-ux-pro-max` | 8 (review UI/UX) | `uiux` |

Instalar:

```bash
npx skills add https://github.com/anthropics/skills --skill webapp-testing
npx skills add https://github.com/anthropics/skills --skill frontend-design
npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max
```

## O modelo de execução híbrido

O Testador combina duas abordagens complementares porque elas resolvem problemas diferentes:

**Playwright MCP (fases 4–5)** lida com o que exige julgamento: descobrir quais fluxos existem, qual seletor é estável, se a tela parece certa, se o estado vazio faz sentido. É caro por token e não-determinístico — inútil como evidência binária.

**Specs gerados (fases 6–7)** lidam com o que exige prova: asserção binária, repetível, com relatório JUnit/JSON que vira `evidenceId`. São o único caminho para `@axe-core/playwright` de verdade, porque `AxeBuilder` precisa de um objeto `Page` num processo Node.

Um artefato `flow-map.json` produzido na fase 5 faz a ponte: a exploração confirma seletores e asserções esperadas, o gerador de specs os consome para produzir código determinístico. Nenhum spec gerado é escrito no repo alvo — todos vivem em `.testador/<slug>/artefatos/run/specs/`.

## A regra de corte

O que decide a severidade é: **a existência de um requisito rastreável**, não a ferramenta.

| Achado | Bloqueante |
|---|---|
| Stack não subiu | Sim |
| Erro de CORS no console | Sim |
| API retornou não-2xx | Sim |
| 2xx mas UI não refletiu o dado | Sim — sintoma clássico de casing divergente |
| Efeito final não aconteceu | Sim |
| `#### Scenario:` do OpenSpec falhou | Sim |
| RF/CA do PRD não atendido | Sim |
| Shape de resposta divergente do contrato | Sim |
| Hex literal onde havia token de design | Sim |
| Token inventado ("never invent new tokens") | Sim |
| Accent aparecendo mais de 2× por página | Sim |
| Anti-padrão do DESIGN.md §9 | Sim |
| Divergência estrutural com `preview/` | Sim |
| Violação axe (qualquer severidade) | **Não** — informativo por default |
| Piso de qualidade sem requisito declarado | Não |
| Clichê de design de IA | Não |

A única exceção que atravessa a tabela: qualquer item "Não" cujo conteúdo tenha um requisito explícito rastreável é **promovido a bloqueante** pela função de triagem, com o requisito citado em `blockingReason`.

## Estado persistente e retomada

Cada execução ganha seu próprio `{artefatos_dir}/state.json` + `events.jsonl`, seguro contra crash (o evento é gravado com fsync antes do snapshot trocar atomicamente — crash no meio da escrita é reparado por replay). `.testador/checkpoint.json` é um índice leve (`execucao_atual`, `historico[]`) apontando para a execução ativa. Retome com:

```bash
/testador resume
```

Uma task `RUNNING` interrompida sempre volta como `UNKNOWN` — nunca `FAILED`/`DONE` presumido — e é reconciliada contra Git/arquivos/validações antes de qualquer redelegação. Ver `skills/testador-subagents/references/persistent-state.md`.

## Gates de conclusão

Sete gates precisam fechar antes de uma execução ser marcada `DONE`:

| Gate | Fase | Waivable |
|---|---|---|
| `stack` | 4 | Não |
| `smoke` | 5 | Não |
| `deterministic` | 7 | Sim |
| `a11y` | 7 | Sim |
| `uiux` | 8 | Sim |
| `spec-coverage` | 9 | Sim |
| `reports` | 11 | Não |

Um gate waivable declarado `required: true` e depois fechado como `N/A` é um **waiver** — `RUN_GATES_WAIVED` bloqueia `DONE`, e o handoff deve fechar como `PARTIAL`, nunca `DONE`.

## Quando usar

Use `/testador` depois que `/orquestrador` entrega e antes que `/executor` corrija:

- validar que uma nova feature realmente funciona end-to-end em navegador real;
- conferir que os tokens do Open Design foram materializados corretamente e sem hex literals;
- verificar que todo `#### Scenario:` do OpenSpec tem um teste passando;
- rodar scan de acessibilidade real com `@axe-core/playwright` em sessão autenticada;
- produzir um laudo classificado (bloqueante/informativo) que o Executor pode consumir como plano.

Não use para edições triviais de 1-2 linhas sem superfície de UI. Para esses casos, `/executor` direto é mais rápido.

## Como funciona

Fluxo resumido:

1. preflight — Playwright MCP, browsers, três skills obrigatórias;
2. ingestão de upstream — handoff do Orquestrador, OpenSpec, tokens do Open Design;
3. descoberta de alvo — `baseUrl`, `startCommand`, rotas, nomes de chave de credencial;
4. plano rastreável — RF/CA ou `#### Scenario:` → matriz de cobertura;
5. subida da stack — `docker compose up --build` ou `npm run dev` via `webapp-testing`;
6. exploração MCP — smoke, seletores, `flow-map.json` → screenshots;
7. geração de specs — arquivos `.spec.mjs` determinísticos (nunca no repo alvo);
8. execução determinística — `run-specs.mjs` (`@playwright/test`) + `@axe-core/playwright`;
9. validação UI/UX — `frontend-design` + `ui-ux-pro-max` + conformidade Open Design;
10. triagem — regra de corte aplicada, correlacionador 2xx-sem-efeito;
11. review do laudo — subagente read-only confere evidência vs conclusões;
12. laudo + handoff — `test-report.md` + `handoff.json` → `/executor`.

Roteamento padrão de subagentes:

- fase 5: subagente explorador via Playwright MCP (skill `webapp-testing`);
- fase 7: subagente executor determinístico (`run-specs.mjs` / `@playwright/test`);
- fase 8: subagente revisor UI/UX (skills `frontend-design` + `ui-ux-pro-max`);
- fase 10: subagente revisor do laudo (read-only).

## Pré-requisitos

Obrigatórios:

| Item | Verificar |
|---|---|
| Node.js >= 22 | `node --version` |
| Playwright MCP | `claude mcp add playwright npx @playwright/mcp@latest` |
| Deps do plugin (`@playwright/test`, `@axe-core/playwright`) | `npm install --prefix "${CLAUDE_PLUGIN_ROOT}"` — verificado via `require.resolve()`, não só presença no `package.json` |
| Chromium | `npx playwright install chromium` (roda automaticamente como `postinstall` do passo acima) |
| Skill `webapp-testing` | `npx skills add https://github.com/anthropics/skills --skill webapp-testing` |
| Skill `frontend-design` | `npx skills add https://github.com/anthropics/skills --skill frontend-design` |
| Skill `ui-ux-pro-max` | `npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max` |
| `Bash(node:*)` e `Bash(npx:*)` | `.claude/settings.json` — remediação somente com `preflight --fix-permissions` |

Opcionais:

| Item | Uso |
|---|---|
| Python 3 | Habilita `with_server.py` da skill `webapp-testing`; senão `runner/server-lifecycle.mjs` é usado |
| CLI `openspec` | Confirma completude do change set; leitura direta de arquivos funciona sem ele |
| Context7 MCP | Docs atuais de libs/frameworks/APIs |

O preflight também detecta se Python 3 está no PATH e reporta em `checks.optional.python3` qual caminho de lifecycle está ativo (`with_server.py` ou `runner/server-lifecycle.mjs`).

Permissão mínima no projeto alvo:

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

## Instalação

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

Validar:

```text
/testador preflight
```
O preflight é somente leitura por padrão. Após confirmação explícita, use `node scripts/preflight.mjs --fix-permissions` para aplicar permissões.

Para CI: `npm ci`, `npm test` e `npm run test:integration`. `viewports` e `wcagTags` da Project_Config chegam ao runner; somente os viewports configurados são executados.

## Uso

```text
/testador <demanda ou caminho de handoff>
```

Subcomandos: `help`, `preflight`, `project-config` (alias `config`), `status [dir]`, `resume [dir]`. O Testador mantém a Project_Config dele em `.testador/project-config.md`; configurar um não configura o Executor nem o Orquestrador.

```text
/testador valide a entrega da página de clientes
```

```text
/testador valide o fluxo de checkout após o último build do Orquestrador
```

```text
/testador verifique a acessibilidade e a conformidade com o Open Design na tela de onboarding
```

## Como o Testador decide o status

| Resultado da triagem | Status da run |
|---|---|
| Pelo menos 1 achado bloqueante | `REPROVADO` |
| Nenhum bloqueante, mas achados informativos | `APROVADO_COM_RESSALVAS` |
| Zero achados | `APROVADO` |
| Gate waived ou verificação impossível | `PARCIAL` |

O status da run determina o status do `handoff.json`:

- `REPROVADO` → `BLOCKED` — o Executor trata o laudo como plano de correção pré-definido;
- `PARCIAL` → `PARTIAL` — indica verificação incompleta;
- `APROVADO` / `APROVADO_COM_RESSALVAS` → `DONE`.

## Layout

```text
cc-testador-subagents/
|-- .claude-plugin/
|   |-- plugin.json
|   `-- marketplace.json
|-- commands/
|   `-- testador.md
|-- runner/                      <- única camada com dependência de Playwright
|   |-- playwright.config.mjs
|   |-- server-lifecycle.mjs
|   `-- fixtures/
|       |-- axe-fixture.mjs
|       |-- console-guard.mjs
|       |-- flow-fixture.mjs
|       `-- network-recorder.mjs
|-- scripts/
|   `-- (16 wrappers de compatibilidade, 1:1 com os CLIs canônicos abaixo)
`-- skills/
    `-- testador-subagents/
        |-- SKILL.md
        |-- scripts/
        |   |-- testador-spec.mjs (fonte de verdade doc<->código, não é CLI, sem wrapper)
        |   |-- (16 CLIs canônicos)
        |   `-- lib/
        |       `-- (20 módulos)
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

Artefatos de uma run:

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

## Princípios

- **Validar, não construir.** O Testador nunca escreve código de produção nem modifica nada no repo alvo.
- **Read-only sobre `openspec/`.** Nunca escreve dentro de `openspec/`, nunca invoca `/opsx:*`. Consome change sets do OpenSpec somente-leitura como fonte de casos de teste.
- **As três skills são obrigatórias.** `webapp-testing`, `frontend-design` e `ui-ux-pro-max` estão amarradas a fases e gates específicos — não são referência opcional. Ausente = preflight bloqueia.
- **Requisito explícito violado → bloqueante. Boa prática não declarada → informativo.** O mesmo achado pode ser qualquer um dos dois, dependendo de haver ou não um requisito rastreável.
- **Híbrido por fase.** MCP para descoberta e evidência visual; specs determinísticos para asserções prováveis.
- **Specs ficam dentro de `.testador/`.** Nenhum arquivo gerado chega ao repo alvo. Verificado por `git status --porcelain`.
- **Cobertura nunca fingida.** Sem `requirements-index` e sem OpenSpec, o gate `spec-coverage` degrada e registra a degradação — nunca reporta cobertura de 100%.
- **Claude Code puro.** Sem Codex, sem AGY. Todos os subagentes são Task subagents nativos do Claude Code.

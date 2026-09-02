# OpenSpec Ingestion — Testador Subagents

Como o Testador ingere change sets do OpenSpec e converte `#### Scenario:` em casos de teste.

## Regra absoluta

**NUNCA escrever em `openspec/`.** Nunca invocar `/opsx:*`. O CLI `openspec` e **opcional**
e so serve como confirmacao de completude -- ausencia nunca bloqueia a ingestao.

## Localizacao do change set

O role `openspec-change` no handoff do Pensador aponta para `openspec/changes/<nome>/`
(caminho relativo ao **projeto**, nao ao `artifactRoot`). Exemplo:

```
openspec/changes/login-social-v1/
  proposal.md
  design.md
  tasks.md
  specs/
    auth/login/spec.md
    checkout/spec.md
    ui-design-system/spec.md   <- roteado para fase 8
```

## Formato dos specs

```markdown
### Requirement: <titulo>

Texto normativo com SHALL/MUST...

#### Scenario: <nome>
- **WHEN** <condicao>
- **THEN** <resultado esperado>
```

## Classificacao de automacao

| Sinal no WHEN/THEN | Classificacao |
|---|---|
| url, rota, tela, pagina, render, visivel | AUTOMATABLE |
| button, click, fill, form, input | AUTOMATABLE |
| var(--, hex, token, cor | AUTOMATABLE |
| api, endpoint, request, response | AUTOMATABLE |
| regra de negocio pura sem superficie observavel | MANUAL |

## Roteamento ui-design-system

Specs da capability `ui-design-system` sao separados dos demais e passados para
a **fase 8** (validacao UI/UX), nao para a geracao de specs Playwright (fase 6).
Eles descrevem conformidade de token e anti-padroes, que exigem inspecao visual
e browser_evaluate, nao specs de fluxo.

## CLI

```bash
node "${CLAUDE_SKILL_DIR}/scripts/parse-openspec.mjs" --change-path <dir>
```

Saida: `{ changeName, specFiles, requirements, scenarios, uiDesignScenarios }`.

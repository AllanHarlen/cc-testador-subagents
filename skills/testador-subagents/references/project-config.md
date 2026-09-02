# Project Config — Testador Subagents

Gramatica e campos do `.testador/project-config.md`.

## Gramatica canonica

```markdown
# TESTADOR PROJECT CONFIG

> Configuracao de teste do projeto. Gerada e lida por /testador project-config.

- **schemaVersion**: 1
- **updatedAt**: 2026-02-14T18:05:31Z
- **baseUrl**: http://localhost:5173
- **apiBaseUrl**: http://localhost:3000
- **startCommand**: docker compose up --build
- **readyTimeoutSeconds**: 120
- **wcagTags**: wcag2a,wcag2aa,wcag21a,wcag21aa
- **a11yBlocking**: false
- **viewports**: 390x844,1440x900
- **seedCredentialsRef**: .env.test
- **serverLifecycle**: auto
- **specMode**: hybrid

## Notas
- a11yBlocking: default-aplicado
```

## Campos

| Campo | Tipo | Default | Descricao |
|---|---|---|---|
| `baseUrl` | URL | `http://localhost:3000` | URL base do front-end |
| `apiBaseUrl` | URL | `""` | URL da API (derivacao de `separateOrigin`) |
| `startCommand` | string | `""` | Comando para subir a stack |
| `readyTimeoutSeconds` | int > 0 | `120` | Timeout aguardando a porta |
| `wcagTags` | lista CSV | `wcag2a,wcag2aa,wcag21a,wcag21aa` | Tags axe |
| `a11yBlocking` | bool | `false` | Se true, toda violacao axe bloqueia |
| `viewports` | lista WxH | `390x844,1440x900` | Viewports Playwright |
| `seedCredentialsRef` | referencia | `""` | Nome do arquivo .env com credenciais |
| `serverLifecycle` | auto\|python\|node | `auto` | Motor de lifecycle do servidor |
| `specMode` | hybrid | `hybrid` | Modo de geracao de specs |

## Seguranca

`seedCredentialsRef` guarda uma **referencia** (ex: `.env.test`), nunca um valor de
credencial. Regra de seguranca: credencial nunca em spec gerado, `flow-map.json`,
screenshot ou laudo.

## CLI

```bash
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" show --root .
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" write --root . --base-url <url> ...
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" validate --root .
```

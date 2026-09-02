# Preflight Check — Testador Subagents

Tabela completa de itens verificados por `scripts/preflight.mjs`.

| Item | Obrigatorio | Remediacao |
|---|---|---|
| Node >= 22 | Sim | Instalar Node.js 22+ e garantir que esta no PATH |
| Playwright MCP | Sim | `claude mcp add playwright npx @playwright/mcp@latest` |
| Deps do plugin (`@playwright/test`, `@axe-core/playwright`) | Sim | `npm install --prefix "${CLAUDE_PLUGIN_ROOT}"` — verificado via `require.resolve()`, nao apenas presenca no `package.json` |
| Chromium | Sim | `npx playwright install chromium` (roda automaticamente como `postinstall` do passo acima) |
| Skill `webapp-testing` | **Sim** | `npx skills add https://github.com/anthropics/skills --skill webapp-testing` |
| Skill `frontend-design` | **Sim** | `npx skills add https://github.com/anthropics/skills --skill frontend-design` |
| Skill `ui-ux-pro-max` | **Sim** | `npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max` |
| `Bash(node:*)` e `Bash(npx:*)` | Sim | Auto-remediado: criado/atualizado em `.claude/settings.json` |
| Python 3 | Nao | Habilita `with_server.py`; senao usa `runner/server-lifecycle.mjs` |
| `openspec` CLI | Nao | Complementa ingestao; leitura direta funciona sem ele |
| `.testador/project-config.md` | Nao | `/testador project-config` |
| Context7 MCP | Nao | `npx ctx7 setup --claude` |

Quando um item **obrigatorio** falha, o preflight mostra a remediacao exata e pergunta via
`AskUserQuestion` se o usuario quer corrigir e tentar de novo, ou cancelar. Nao ha caminho
"seguir sem" para os itens marcados como obrigatorios.

Quando `serverLifecycle: auto` (default), o preflight reporta em `checks.optional.python3`
se o Python esta disponivel. Sem Python, `runner/server-lifecycle.mjs` e usado no lugar
de `with_server.py`.

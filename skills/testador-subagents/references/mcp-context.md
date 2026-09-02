# MCP Context — Testador Subagents

Como o Testador usa o Playwright MCP e como o Context7 e integrado.

## Playwright MCP

**Instalacao (obrigatoria):**
```bash
claude mcp add playwright npx @playwright/mcp@latest
```

**Tools usadas:**

| Tool | Quando usar |
|---|---|
| `browser_navigate` | Ir para uma URL |
| `browser_snapshot` | Capturar arvore de acessibilidade -- **uma vez** |
| `browser_find` | Localizar elemento na arvore capturada (barato) |
| `browser_click` | Clicar em elemento |
| `browser_fill_form` | Preencher multiplos campos |
| `browser_evaluate` | Executar JS: `getComputedStyle`, injetar axe |
| `browser_console_messages` | Coletar erros de console -- usar `--filename` |
| `browser_network_requests` | Listar chamadas de API |
| `browser_take_screenshot` | Evidencia visual |

**Protocolo obrigatorio (skill webapp-testing):**
1. `browser_navigate` para a URL.
2. Aguardar rede quieta (networkidle).
3. `browser_snapshot` **uma unica vez**.
4. `browser_find` dai em diante.
5. `--filename <path>` em console_messages para salvar em arquivo.

## Context7 MCP

Opcional. Usado para consultar documentacao atualizada de frameworks/libs quando
a task envolver biblioteca especifica.

Deteccao automatica no preflight em `checks.optional.mcp.context7`.

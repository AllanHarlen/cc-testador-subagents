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

Opcional. Usado para consultar documentação oficial atualizada de frameworks de teste (Playwright, axe-core, Vitest, Jest, Mock Service Worker) ou de bibliotecas sob teste quando a validação envolver comportamentos específicos de dependências externas.

- **Detecção:** automática no preflight em `checks.optional.mcp.context7.ok`. Ausência nunca bloqueia o pipeline.
- **Quando usar:** esclarecer sintaxes de asserção, seletores avançados, fixtures do Playwright, regras do axe-core ou mocks de API.
- **Quando NÃO usar:** lógica de asserção de regras de negócio internas do projeto ou análise de código local.

**Protocolo obrigatório:**
1. `resolve-library-id` com o nome oficial pontuado (ex.: `Playwright`, `axe-core`).
2. Se o projeto fixar a versão da ferramenta no `package.json` e ela estiver listada em `Versions`, use o formato `/org/project/version`.
3. `query-docs` com consulta focada em **um único conceito** (Single-Concept Scoping, ex: "Playwright route abort mock response examples").
4. **Limite:** no máximo 3 consultas por tarefa. Se não resolver, caia para as convenções locais.
5. **Fallback:** quando ausente ou sem autenticação, siga os exemplos de specs e fixtures já existentes no repositório.
6. **Segurança:** chaves de API (`ctx7sk-...`) nunca entram em logs, specs de teste ou artefatos.

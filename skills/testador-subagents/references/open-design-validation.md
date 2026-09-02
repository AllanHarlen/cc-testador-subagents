# Open Design Validation — Testador Subagents

Como o Testador valida a conformidade da interface com a proposta inicial do Open Design.

## Regras de bloqueio

Todas derivam do gate de design do handoff-contract.md §6 e da regra inviolavel
"never invent new tokens":

| Violacao | Bloqueante |
|---|---|
| Hex literal onde ha token declarado (`#1a73e8` em vez de `var(--color-primary)`) | **Sim** |
| Token inventado (presente na materializada mas nunca declarado no verbatim) | **Sim** |
| Accent aparecendo mais de 2x por pagina (exceto em links) | **Sim** |
| Anti-padrao da §9 do DESIGN.md | **Sim** |
| Divergencia estrutural de tela-chave contra `preview/` | **Sim** |

## Verificacao estatica (lib/design-conformance.mjs)

Compara `tokens.css` verbatim (`.pensador/<slug>-vN/design-systems/<id>/tokens.css`)
com o `tokens.css` materializado (`materializeInto`). Detecta:
- Tokens ausentes na materializada (missing).
- Tokens com valor diferente (changed).
- Tokens inventados na materializada (invented).

## Verificacao dinamica (fase 8, via browser_evaluate)

O subagente de fase 8 usa Playwright MCP para:
1. `browser_evaluate` -> `getComputedStyle` dos elementos-chave.
2. Verificar que propriedades de cor/espacamento usam `var(--*)` e nao hex literal.
3. Contar aparicoes do accent.
4. Verificar anti-padroes da §9 contra a pagina renderizada.

## Comparacao com preview/

Comparacao **estrutural** (presenca e ordem de secoes, hierarquia tipografica,
paleta efetiva), nao pixel-diff. Pixel-diff produz falso-positivo em conteudo dinamico.

## CLI

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-design-conformance.mjs" --dir {artefatos_dir} [--root .]
```

Saida: envelope de intelligence com `staticFindings` (divergencias detectadas
estaticamente) e `antipatternChecklist` (lista para o subagente verificar no browser).

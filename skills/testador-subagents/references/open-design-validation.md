# Open Design Validation — Testador Subagents

Como o Testador valida a conformidade da interface com a proposta inicial do Open Design.

## Regras de bloqueio

Todas derivam do gate de design do handoff-contract.md §6 e da regra inviolavel
"never invent new tokens":

| Violacao | Bloqueante |
|---|---|
| Hex literal onde ha token declarado (`#1a73e8` em vez de `var(--color-primary)`) | **Sim** |
| Token inventado (presente na materializada mas nunca declarado no `resolved/`) | **Sim** |
| Accent aparecendo mais de 2x por pagina (exceto em links) | **Sim** |
| Anti-padrao da §9 do DESIGN.md | **Sim** |
| Divergencia estrutural de tela-chave contra `preview/` | **Sim** |
| `DESIGN_BRIEF_MISMATCH`: tema pintado diferente do exigido pelo brief, ou primaria travada diferente do `--accent` computado (tema claro) | **Sim** |
| `DESIGN_CONTRACT_HASH_MISMATCH`: `design-contract.json` em disco nao bate com o `contractSha256` do handoff | **Sim** |

## Fonte do "verbatim"

O verbatim e o pacote **`resolved/`** apontado pelo handoff do Pensador
(`design-systems/<id>/resolved/`): `design-contract.json`, `tokens.css`,
`DESIGN.md`, `components.html`, `preview/`. O `source/` (proveniencia do engine)
nao e verbatim e nao entra na comparacao. O id do system e `<id>` (nunca
`<id>/resolved`). A entrada do handoff carrega `contractSha256`, `themes` e
`designBriefPath`, todos consumidos por `ingest-upstream.mjs`.

`tokens.css` declara os dois temas: `:root` (claro, base e tokens compartilhados),
`[data-theme="dark"]` e `@media (prefers-color-scheme: dark)` (overrides escuros).

## Verificacao estatica (lib/design-conformance.mjs)

Compara `tokens.css` do `resolved/`
(`.pensador/<slug>-vN/design-systems/<id>/resolved/tokens.css`) com o `tokens.css`
materializado (`materializeInto`). Detecta:
- Tokens ausentes na materializada (missing).
- Tokens com valor diferente (changed).
- Tokens inventados na materializada (invented).

O parser mantem a **primeira** ocorrencia de cada token (o valor do tema claro).

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

## Conformidade com o brief e tema escuro (runtime)

`check-runtime-design.mjs` le `run/design-probes.json`, um array de
`{ route, viewport, theme, probe }`, onde `theme` e `default` (nada forcado),
`light` ou `dark`. Se a entrada de `plan/design-systems.json` traz `designBriefPath`,
cada probe passa por `analyzeBriefConformance` (`DESIGN_BRIEF_MISMATCH`):

- **Tema:** o tema efetivo e o que a pagina **pinta** (luminancia de `--bg`), nao o
  atributo. `default` deve bater com `themeDefault` (`system` segue
  `prefers-color-scheme`); `themeExposure: light-only` proibe render escuro; probe
  `dark` deve pintar escuro. Atributo que diz um tema e pintura de outro = seletor
  de tema quebrado.
- **Primaria:** `colorPrimary` travado e comparado com o `--accent` computado **so
  no tema claro** (o engine deriva outra primaria no escuro). Campo nao travado
  nunca e cobrado.

**Tema escuro:** quando `themeExposure` nao e `light-only`, capture tambem cada
rota-chave no escuro, com `"theme": "dark"`: alterne `document.documentElement.dataset.theme = "dark"`
(via `browser_evaluate`, antes de rodar o probe) ou emule `prefers-color-scheme: dark`
(`page.emulateMedia({ colorScheme: "dark" })`). Os tokens esperados vem do bloco escuro do
`tokens.css`, e valem as mesmas checagens (resolucao de tokens, paleta, fontes, layout).
Sem nenhum probe escuro, `details.warnings` aponta que o tema escuro nao foi verificado.

### Captura do probe escuro (obrigatoria quando o brief expoe o tema escuro)

Se `design-brief.json` traz `themeExposure` diferente de `light-only`, alem do probe
`default`/`light` de cada rota-chave e viewport, capture **tambem** um probe `dark`.
Sem ele a triagem gera `DESIGN_DARK_PROBE_MISSING` (critico, bloqueante) e a run nao fecha `DONE`.

1. Forcar o tema escuro, por um dos dois caminhos (o segundo cobre `system`):
   - `browser_evaluate`: `document.documentElement.setAttribute('data-theme','dark')`
     (e `localStorage` do tema, se o app o usa), depois recarregar/aguardar o repaint;
   - emular `prefers-color-scheme: dark` via Playwright MCP
     (`browser_run_code_unsafe`: `await page.emulateMedia({ colorScheme: 'dark' })`),
     removendo qualquer `data-theme` forcado antes.
2. Injetar `RUNTIME_DESIGN_PROBE_SCRIPT` (`lib/runtime-design-probe.mjs`) via `browser_evaluate`.
3. Acrescentar `{ "route": "...", "viewport": {...}, "theme": "dark", "probe": <retorno> }`
   ao array de `{artefatos_dir}/run/design-probes.json` (mesma rota/viewport do claro).
4. Repor o tema original (`removeAttribute('data-theme')` / `emulateMedia({ colorScheme: null })`).
5. Rodar `check-runtime-design.mjs`: o probe `dark` e comparado contra o bloco escuro
   do `tokens.css` e contra o brief (`DESIGN_BRIEF_MISMATCH`).

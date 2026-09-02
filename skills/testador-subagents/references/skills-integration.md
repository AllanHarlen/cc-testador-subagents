# Skills Integration — Testador Subagents

As 3 skills obrigatorias mapeadas a fases, gates e criterios de uso.
Skill ausente bloqueia o preflight. Skill inacessivel numa fase = BLOCKED, nao degradacao.

## webapp-testing

**Fases:** 4 (subida da stack) e 5 (exploracao MCP)
**Gates:** `stack`, `smoke`
**Fonte:** https://github.com/anthropics/skills (Apache-2.0)
**Instalacao:** `npx skills add https://github.com/anthropics/skills --skill webapp-testing`

Padroes obrigatorios extraidos da skill:
- Nunca inspecionar DOM antes de `page.waitForLoadState("networkidle")`.
- Reconhecimento-antes-de-acao: snapshot primeiro, then find.
- Scripts como caixa-preta: `--help` primeiro, nunca ler o fonte.
- Preferir seletor `role=` e `text=` a CSS fragil.
- `--filename` para salvar console/network (nao poluir contexto).
- `with_server.py` como lifecycle manager quando Python esta no PATH; senao `runner/server-lifecycle.mjs`.

## frontend-design

**Fases:** 8 (validacao UI/UX)
**Gates:** `uiux`
**Fonte:** https://github.com/anthropics/skills (Apache-2.0)
**Instalacao:** `npx skills add https://github.com/anthropics/skills --skill frontend-design`

Criterios obrigatorios:
- Piso de qualidade: responsivo ate mobile nos viewports configurados.
- Foco de teclado visivel ao tabular por todos os elementos interativos.
- `prefers-reduced-motion` respeitado.
- Detector de 3 cliches de design de IA (informativo):
  1. Creme `#F4F1EA` + serif alto contraste + acento terracota.
  2. Quase-preto + acento verde-acido ou vermelhao unico.
  3. Broadsheet com fios de cabelo, `border-radius:0`, colunas densas.

## ui-ux-pro-max

**Fases:** 8 (validacao UI/UX)
**Gates:** `uiux`
**Fonte:** https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
**Instalacao:** `npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max`

Criterios obrigatorios:
- Design system: coerencia de padrao, anti-padroes nomeados.
- Notas de risco de acessibilidade por estilo.
- Padroes de conversao e hierarquia visual.

## Relatorio de uso

Todo subagente das fases 4, 5 e 8 deve:
1. Consultar as skills disponiveis se o ambiente expoe inventario.
2. Se nao expoe: registrar "skills nao acessiveis" e retornar BLOCKED -- nao degradar.
3. Reportar no campo "skillsUtilizadas" as skills que guiaram a execucao.

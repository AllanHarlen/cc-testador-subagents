# Visual Criteria — Testador Subagents

Checklist de qualidade visual utilizado na fase 8 quando as skills frontend-design
e ui-ux-pro-max estao disponiveis. Itens sao **informativos** por default; viram
bloqueantes apenas quando correspondem a um requisito rastreavel.

## Piso de qualidade (frontend-design)

- Responsivo ate mobile nos viewports configurados (390x844 e maiores).
- Foco de teclado visivel ao tabular por todos os elementos interativos.
- `prefers-reduced-motion` respeitado: animacoes desativadas quando media query ativa.
- Contraste de texto satisfatorio (informativo; bloqueia se ha requisito WCAG).

## Detector de 3 cliches de design de IA (frontend-design)

Todos informativos:
1. Creme `#F4F1EA` + serif alto contraste + acento terracota -- padrao "cafeteria startup".
2. Quase-preto + unico acento verde-acido ou vermelhao -- padrao "tech dark mode".
3. Broadsheet com fios de cabelo, `border-radius:0`, colunas densas -- padrao "newsletter editorial".

Se o design explicitamente pede um destes estilos, a deteccao e suprimida.

## Criterios de design system (ui-ux-pro-max)

- Coerencia de padrão entre componentes e paginas.
- Anti-padroes nomeados pelo ui-ux-pro-max ausentes.
- Padroes de conversao adequados ao tipo de produto.

## Checklist de fallback (quando skill inacessivel)

Se o ambiente nao expoe inventario de skills, o subagente deve reportar BLOCKED.
**Nao degradar silenciosamente para um checklist embutido** -- a decisao foi tornar
as skills obrigatorias.

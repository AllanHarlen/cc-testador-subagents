# A11y Criteria — Testador Subagents

Criterios de acessibilidade e regras de bloqueio.

## Regra de bloqueio

Por decisao do usuario (2=c): **violacao axe nunca bloqueia por si so** (default
`a11yBlocking: false`). Entram no laudo classificadas por severidade.

**Excecoes:**
1. `a11yBlocking: true` no Project_Config: toda violacao bloqueia.
2. Upgrade por requisito rastreavel: violacao que corresponde a um Scenario ou RF
   explicito e promovida a bloqueante pela triagem, com o requisito citado em
   `blockingReason`.

## Tags WCAG default

`wcag2a,wcag2aa,wcag21a,wcag21aa` (configuravel via `wcagTags` no Project_Config).

## Severidades axe

| Severidade | Exemplos |
|---|---|
| `critical` | Input sem label, contraste insuficiente em texto grande |
| `serious` | Foco de teclado nao visivel, alt text ausente |
| `moderate` | Landmark ausente, heading order incorreta |
| `minor` | Atributo aria redundante |

## CLI

```bash
TESTADOR_ARTIFACTS_DIR={artefatos_dir} \
  npx playwright test --config "${CLAUDE_PLUGIN_ROOT}/runner/playwright.config.mjs" \
  --grep "a11y"
node "${CLAUDE_SKILL_DIR}/scripts/collect-a11y-results.mjs" --dir {artefatos_dir} [--a11y-blocking bool]
```

## Fixture

`runner/fixtures/axe-fixture.mjs` expoe `makeAxeBuilder` com as tags WCAG configuradas.
Uso nos specs de a11y:
```js
import { test, expect } from "../fixtures/axe-fixture.mjs";
test("a11y scan", async ({ page, makeAxeBuilder }) => {
  await page.goto("/rota");
  await page.waitForLoadState("networkidle");
  const results = await makeAxeBuilder().analyze();
  expect(results.violations).toEqual([]);
});
```

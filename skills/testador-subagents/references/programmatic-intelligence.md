# Programmatic Intelligence — Testador Subagents

Scripts deterministicos que emitem envelopes de evidencia estruturada.

## Principio

Toda verificacao que pode ser feita mecanicamente deve ser feita por script,
nao por leitura/julgamento do LLM. Regra: >= 3 comparacoes mecanicas, loop de
arquivo ou comparacao estrutural -> script deterministico -> JSON + `evidenceId`.

## Catalogo

| Script | Funcao |
|---|---|
| `ingest-upstream.mjs` | Descobre handoff, sobe chain, coleta insumos |
| `parse-openspec.mjs` | Extrai Scenarios do change set OpenSpec |
| `build-coverage-matrix.mjs` | RF/CA ou Scenarios -> matriz de cobertura |
| `testador-gates.mjs plan` | Lista exata de gates por escopo/contexto |
| `generate-specs.mjs` | flow-map.json -> specs Playwright deterministicos |
| `run-specs.mjs` | Executa `npx playwright test` com config do plugin |
| `collect-test-results.mjs` | JUnit/JSON -> resumo estruturado |
| `collect-a11y-results.mjs` | axe JSON -> resumo por severidade e tag |
| `check-design-conformance.mjs` | tokens.css verbatim vs materializado, §9 |
| `triage-findings.mjs` | Aplica regra de corte, upgrade por requisito |
| `validate-handoff.mjs` | Valida envelope handoff.json |

## Envelope de evidencia

```json
{
  "schemaVersion": 1,
  "kind": "discover-target",
  "summary": { ... },
  "details": { ... },
  "evidenceId": "intel-discover-target-<hash>",
  "generatedAt": "2026-01-01T00:00:00.000Z"
}
```

`evidenceId` e content-addressable (hash do conteudo). Scripts que suportam
`--dir <artefatos_dir> --task <id>` persistem a evidencia em
`{artefatos_dir}/evidence/` e a anexam a task correspondente.

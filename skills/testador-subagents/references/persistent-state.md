# Persistent State — Testador Subagents

Estado por-run: duas camadas (indice + detalhe), invariantes de seguranca, resume.

## Duas camadas

**Indice** (`.testador/checkpoint.json`):
- `execucao_atual`: caminho do `artefatos_dir` ativo.
- `historico[]`: historico de runs anteriores.
- Gerenciado por `lib/checkpoint-index.mjs`.

**Detalhe** (`{artefatos_dir}/state.json` + `events.jsonl` + `.state.lock`):
- Estado completo da run ativa.
- Gerenciado exclusivamente por `lib/testador-state.mjs` (escrita atomica + eventos).
- Nunca editar `state.json` manualmente.

## Invariantes de seguranca

1. **Evento antes do snapshot**: todo evento e fsyncado em `events.jsonl` **antes** do
   `state.json` ser trocado atomicamente. Crash no meio = reparavel por replay.
2. **RUNNING interrompido = UNKNOWN**: nunca `FAILED`/`DONE` presumido.
   `reasonCode: OWNER_SESSION_INTERRUPTED`.
3. **DONE exige evidencia local**: arquivo produzido, validacao passando, ou delta de
   commit. Sem evidencia = `TASK_DONE_REQUIRES_EVIDENCE`.
4. **STALLED com grace period**: `STALLED` so apos `staleIdleSeconds` elapsar; a
   recomendacao escala para `CANCEL_OR_RETRY_AFTER_RECONCILIATION` apos `stallGraceSeconds`.

## Gates de conclusao

7 gates, definidos em `COMPLETION_GATE_DEFINITIONS`:

| Gate | Fase | Waivable |
|---|---|---|
| `stack` | 4 | Nao |
| `smoke` | 5 | Nao |
| `deterministic` | 7 | Sim |
| `a11y` | 7 | Sim |
| `uiux` | 8 | Sim |
| `spec-coverage` | 9 | Sim |
| `reports` | 11 | Nao |

Gate waivable fechado como N/A apos ter sido marcado required = **waiver**:
`requiredOverride: false`, `RUN_GATES_WAIVED` bloqueia `DONE`, handoff fecha `PARCIAL`.

## Resume

```bash
node "${CLAUDE_SKILL_DIR}/scripts/testador-state.mjs" resume [--dir <artefatos_dir>]
```

1. Reparar tail de evento incompleto.
2. Replay dos eventos sobre o snapshot.
3. Toda task `RUNNING` interrompida -> `UNKNOWN`.
4. Reconciliar contra Git/arquivos/validacoes.
5. Devolver `resumeFromPhase`, `unknownTasks`, `recommendations`.

Nao redelegue uma task `UNKNOWN` sem confirmar que a sessao anterior nao segue ativa.

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

Os 4 gates waivable nascem `required` de acordo com o que a fase 3 planejou --
via `testador-state.mjs gates-apply --gates-plan <plano>` (ver `references/workflow.md`
fase 3 e `lib/gates.mjs::completionGateRequirements()`). Sem esse passo, todo gate
waivable nasce `required: false` (comportamento legado).

**Waiver de verdade** = gate que estava `required: true` e foi fechado `N/A` com
`--reason`: grava `requiredOverride: false` **e** `status: "N/A"`. Esse par e o unico
que `RUN_GATES_WAIVED` reconhece e que bloqueia `DONE` (o handoff correspondente fecha
`PARCIAL`). Um gate marcado `required: false` por **nao ser aplicavel a este escopo**
(ex.: `spec-coverage` sem OpenSpec/joint mode) nunca conta como waiver, mesmo que
`requiredOverride` seja `false` -- so o par completo (`requiredOverride: false` +
`status: "N/A"`) importa.

Reabrir um gate ja waived (`requiredOverride: false -> true`) exige `--unwaive true`
explicito em `testador-state.mjs gate`; sem isso, a chamada falha com
`GATE_WAIVER_REQUIRES_EXPLICIT_UNWAIVE` -- o waiver nunca e silenciosamente desfeito.

## Resume

```bash
node "${CLAUDE_SKILL_DIR}/scripts/testador-state.mjs" resume [--dir <artefatos_dir>] [--probe-file <json>]
```

1. Reparar tail de evento incompleto.
2. Replay dos eventos sobre o snapshot.
3. Toda task `RUNNING` interrompida -> `UNKNOWN`.
4. Reconciliar contra Git/arquivos/validacoes.
5. Devolver `resumeFromPhase`, `unknownTasks`, `recommendations`.

Nao redelegue uma task `UNKNOWN` sem confirmar que a sessao anterior nao segue ativa.

`--probe-file` recebe um JSON no shape `{ tasks: { <taskId>: {...} } }` (ver
`probeFileShape` em `testador-state.mjs help`). Como o Testador e Claude Code puro
(sem Codex/AGY externo), esse arquivo e montado por `testador-probe.mjs` a partir do
que o proprio agente/subagente relatou sobre cada task -- nunca por inferencia
heuristica de texto livre:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/testador-probe.mjs" \
  --task mcp-explorer --status DONE --produced-file plan/flow-map.json --output probe.json
node "${CLAUDE_SKILL_DIR}/scripts/testador-state.mjs" resume --probe-file probe.json
```

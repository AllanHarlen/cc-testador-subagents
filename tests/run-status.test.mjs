/**
 * Status da run derivado da triagem: todas as combinacoes.
 * Funcao pura -- nao depende de I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { triageFindings } from "../skills/testador-subagents/scripts/lib/finding-triage.mjs";

test("REPROVADO: qualquer achado bloqueante", () => {
  const { runStatus } = triageFindings({ rawFindings: [{ category: "CORS_ERROR", title: "CORS" }] });
  assert.equal(runStatus, "REPROVADO");
});

test("APROVADO_COM_RESSALVAS: so achados informativos", () => {
  const { runStatus } = triageFindings({ rawFindings: [{ category: "A11Y_VIOLATION", title: "contrast" }] });
  assert.equal(runStatus, "APROVADO_COM_RESSALVAS");
});

test("APROVADO: zero achados", () => {
  const { runStatus } = triageFindings({ rawFindings: [] });
  assert.equal(runStatus, "APROVADO");
});

test("REPROVADO sobrepoe qualquer informativo: bloqueante + informativo = REPROVADO", () => {
  const { runStatus } = triageFindings({
    rawFindings: [
      { category: "CORS_ERROR", title: "CORS" },
      { category: "A11Y_VIOLATION", title: "contrast" },
    ],
  });
  assert.equal(runStatus, "REPROVADO");
});

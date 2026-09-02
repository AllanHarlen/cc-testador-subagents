/**
 * Fixture Playwright: grava requisicoes e respostas de API para o
 * correlacionador 2xx-sem-efeito-na-UI da fase de triagem.
 *
 * Grava apenas metodo/URL/status -- nunca corpo ou headers de
 * request/response, para nao persistir token/cookie em `apiCalls` (que
 * acaba em `run/api-calls.json` e, por extensao, em achados/evidencia).
 * `apiCallsFixture` e exportado para composicao em `flow-fixture.mjs`.
 */
import { test as base } from "@playwright/test";

export const apiCallsFixture = async ({ page }, use) => {
  const calls = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/") && !url.match(/\/(graphql|trpc)/)) return;
    try {
      calls.push({
        url,
        method: response.request().method(),
        status: response.status(),
        ok: response.ok(),
        ts: new Date().toISOString(),
      });
    } catch {
      // Response body read can fail on redirects -- ignore.
    }
  });
  await use(calls);
};

export const test = base.extend({ apiCalls: apiCallsFixture });

export { expect } from "@playwright/test";

/**
 * Fixture Playwright: grava requisicoes e respostas de API para o
 * correlacionador 2xx-sem-efeito-na-UI da fase de triagem.
 */
import { test as base } from "@playwright/test";

export const test = base.extend({
  apiCalls: async ({ page }, use) => {
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
  },
});

export { expect } from "@playwright/test";

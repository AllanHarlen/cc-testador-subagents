/**
 * Fixture Playwright: falha o teste quando um erro de console ou CORS e
 * detectado durante a execucao.
 *
 * `consoleErrorsFixture` e exportado separadamente (alem de `test` ja
 * estendido) para que `flow-fixture.mjs` possa compor este fixture com
 * outros (ex.: `apiCalls` de `network-recorder.mjs`) num unico `test.extend`,
 * sem duplicar a logica de captura de console.
 *
 * Uso direto (sem outros fixtures):
 *   import { test, expect } from "../fixtures/console-guard.mjs";
 */
import { test as base } from "@playwright/test";

export const consoleErrorsFixture = async ({ page }, use) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await use(errors);
  if (errors.length > 0) {
    throw new Error(`Console errors detected: ${errors.slice(0, 3).join(" | ")}`);
  }
};

export const test = base.extend({ consoleErrors: consoleErrorsFixture });

export { expect } from "@playwright/test";

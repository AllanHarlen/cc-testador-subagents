/**
 * Fixture Playwright: falha o teste quando um erro de console ou CORS e
 * detectado durante a execucao.
 *
 * Uso nos specs gerados:
 *   import { test, expect } from "../fixtures/console-guard.mjs";
 */
import { test as base } from "@playwright/test";

export const test = base.extend({
  consoleErrors: async ({ page }, use) => {
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));
    await use(errors);
    if (errors.length > 0) {
      throw new Error(`Console errors detected: ${errors.slice(0, 3).join(" | ")}`);
    }
  },
});

export { expect } from "@playwright/test";

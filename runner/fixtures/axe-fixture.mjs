/**
 * Fixture Playwright: expoe AxeBuilder com as tags WCAG configuradas
 * pelo Project_Config (wcagTags).
 */
import { test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const wcagTags = (process.env.TESTADOR_WCAG_TAGS ?? "wcag2a,wcag2aa,wcag21a,wcag21aa")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

export const makeAxeBuilderFixture = async ({ page }, use) => {
  const makeAxeBuilder = () => new AxeBuilder({ page }).withTags(wcagTags);
  await use(makeAxeBuilder);
};

export const test = base.extend({ makeAxeBuilder: makeAxeBuilderFixture });

export { expect } from "@playwright/test";

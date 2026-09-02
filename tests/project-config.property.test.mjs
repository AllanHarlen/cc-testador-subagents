/**
 * Property test: render -> parse deve ser um round-trip exato dos campos
 * canonicos, para qualquer combinacao valida de campos. Arbitraries derivadas
 * dos exports reais (`SERVER_LIFECYCLE_VALUES`, `WCAG_TAG_VALUES`, ...) para
 * o gerador nao driftar do modulo real.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import test from "node:test";

import { parseProjectConfig, renderProjectConfig } from "../skills/testador-subagents/scripts/lib/project-config.mjs";
import { arbProjectConfigFields } from "./helpers/project-config-arbitraries.mjs";

const NUM_RUNS = 200;

test("Property: render -> parse e um round-trip exato dos campos canonicos", () => {
  fc.assert(
    fc.property(arbProjectConfigFields(), (config) => {
      const content = renderProjectConfig(config, { now: config.updatedAt });
      const reparsed = parseProjectConfig(content);
      assert.equal(reparsed.schemaVersion, config.schemaVersion);
      assert.equal(reparsed.updatedAt, config.updatedAt);
      assert.equal(reparsed.baseUrl, config.baseUrl);
      assert.equal(reparsed.readyTimeoutSeconds, config.readyTimeoutSeconds);
      assert.equal(reparsed.a11yBlocking, config.a11yBlocking);
      assert.equal(reparsed.serverLifecycle, config.serverLifecycle);
      assert.equal(reparsed.specMode, config.specMode);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property: parse is idempotent (parsing the render of a parse yields the same value)", () => {
  fc.assert(
    fc.property(arbProjectConfigFields(), (config) => {
      const first = parseProjectConfig(renderProjectConfig(config, { now: config.updatedAt }));
      const second = parseProjectConfig(renderProjectConfig(first, { now: first.updatedAt }));
      assert.deepEqual(second, first);
    }),
    { numRuns: NUM_RUNS },
  );
});

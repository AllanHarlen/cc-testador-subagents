/**
 * Gramatica do Project_Config_File do Testador: parse tolerante
 * (espacamento, ordem, BOM, CRLF, backtick/aspas), estrito em conteudo
 * (campo ausente, valor fora do conjunto permitido, schemaVersion nao
 * suportado).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROJECT_CONFIG,
  ProjectConfigError,
  applyProjectConfigDefaults,
  defaultProjectConfig,
  diffProjectConfig,
  parseProjectConfig,
  renderProjectConfig,
} from "../skills/testador-subagents/scripts/lib/project-config.mjs";

const SAMPLE = {
  schemaVersion: 1,
  updatedAt: "2026-02-14T18:05:31Z",
  baseUrl: "http://localhost:5173",
  apiBaseUrl: "http://localhost:3000",
  startCommand: "docker compose up --build",
  readyTimeoutSeconds: 120,
  wcagTags: "wcag2a,wcag2aa,wcag21a,wcag21aa",
  a11yBlocking: false,
  viewports: "390x844,1440x900",
  seedCredentialsRef: ".env.test",
  serverLifecycle: "auto",
  specMode: "hybrid",
  defaultsApplied: [],
};

test("renderProjectConfig produces the canonical bold-field grammar in field order", () => {
  const content = renderProjectConfig(SAMPLE);
  assert.match(content, /^# TESTADOR PROJECT CONFIG\n/);
  assert.match(content, /- \*\*schemaVersion\*\*: 1\n/);
  assert.match(content, /- \*\*baseUrl\*\*: http:\/\/localhost:5173\n/);
  assert.match(content, /- \*\*serverLifecycle\*\*: auto\n/);
  assert.doesNotMatch(content, /## Notas/);
});

test("renderProjectConfig writes a Notas section only when a field carries a default", () => {
  const config = { ...SAMPLE, defaultsApplied: ["a11yBlocking"] };
  const content = renderProjectConfig(config);
  assert.match(content, /## Notas\n\n- a11yBlocking: default-aplicado\n/);
});

test("parseProjectConfig round-trips the canonical render exactly", () => {
  const content = renderProjectConfig(SAMPLE);
  const parsed = parseProjectConfig(content);
  for (const key of Object.keys(SAMPLE)) {
    assert.deepEqual(parsed[key], SAMPLE[key], `field ${key} must round-trip`);
  }
});

test("parseProjectConfig tolerates BOM, CRLF, backticks and out-of-order fields", () => {
  const messy =
    "\uFEFF# TESTADOR PROJECT CONFIG\r\n\r\n> lead\r\n\r\n"
    + "- **baseUrl**: `http://localhost:5173`\r\n"
    + "- **schemaVersion**: 1\r\n"
    + '- **apiBaseUrl**: "http://localhost:3000"\r\n'
    + "- **startCommand**: docker compose up\r\n"
    + "- **readyTimeoutSeconds**: 90\r\n"
    + "- **wcagTags**: wcag2a,wcag2aa\r\n"
    + "- **a11yBlocking**: true\r\n"
    + "- **viewports**: 1440x900\r\n"
    + "- **seedCredentialsRef**: .env.test\r\n"
    + "- **serverLifecycle**: python\r\n"
    + "- **specMode**: hybrid\r\n"
    + "- **updatedAt**: 2026-02-14T18:05:31Z\r\n";
  const parsed = parseProjectConfig(messy);
  assert.equal(parsed.baseUrl, "http://localhost:5173");
  assert.equal(parsed.apiBaseUrl, "http://localhost:3000");
  assert.equal(parsed.a11yBlocking, true);
  assert.equal(parsed.serverLifecycle, "python");
});

test("parseProjectConfig rejects a missing required field", () => {
  const content = renderProjectConfig(SAMPLE).replace(/- \*\*baseUrl\*\*: .*\n/, "");
  assert.throws(() => parseProjectConfig(content), (error) => {
    assert.ok(error instanceof ProjectConfigError);
    assert.equal(error.code, "PROJECT_CONFIG_FIELD_MISSING");
    assert.equal(error.details.field, "baseUrl");
    return true;
  });
});

test("parseProjectConfig rejects an out-of-set value for an enum-like field", () => {
  const content = renderProjectConfig(SAMPLE).replace("**serverLifecycle**: auto", "**serverLifecycle**: rust");
  assert.throws(() => parseProjectConfig(content), (error) => {
    assert.equal(error.code, "PROJECT_CONFIG_INVALID_VALUE");
    assert.equal(error.details.field, "serverLifecycle");
    return true;
  });
});

test("parseProjectConfig rejects an invalid wcagTags entry", () => {
  const content = renderProjectConfig(SAMPLE).replace("wcag2a,wcag2aa,wcag21a,wcag21aa", "wcag2a,not-a-tag");
  assert.throws(() => parseProjectConfig(content), (error) => error.code === "PROJECT_CONFIG_INVALID_VALUE");
});

test("parseProjectConfig rejects a malformed viewport entry", () => {
  const content = renderProjectConfig(SAMPLE).replace("390x844,1440x900", "390x844,not-a-viewport");
  assert.throws(() => parseProjectConfig(content), (error) => error.code === "PROJECT_CONFIG_INVALID_VALUE");
});

test("parseProjectConfig rejects schemaVersion above what this plugin supports", () => {
  const content = renderProjectConfig(SAMPLE).replace("**schemaVersion**: 1", "**schemaVersion**: 99");
  assert.throws(() => parseProjectConfig(content), (error) => error.code === "PROJECT_CONFIG_SCHEMA_UNSUPPORTED");
});

test("parseProjectConfig rejects a file with no recognizable field line", () => {
  assert.throws(() => parseProjectConfig("just some prose, no fields here"), (error) => error.code === "PROJECT_CONFIG_UNPARSEABLE");
});

test("defaultProjectConfig has updatedAt null and no defaultsApplied", () => {
  const config = defaultProjectConfig();
  assert.equal(config.updatedAt, null);
  assert.deepEqual(config.defaultsApplied, []);
  assert.equal(config.baseUrl, DEFAULT_PROJECT_CONFIG.baseUrl);
});

test("applyProjectConfigDefaults fills every missing field and records it in defaultsApplied", () => {
  const resolved = applyProjectConfigDefaults({ baseUrl: "http://localhost:8080" }, { now: "2026-01-01T00:00:00Z" });
  assert.equal(resolved.baseUrl, "http://localhost:8080");
  assert.equal(resolved.serverLifecycle, DEFAULT_PROJECT_CONFIG.serverLifecycle);
  assert.ok(resolved.defaultsApplied.includes("serverLifecycle"));
  assert.ok(!resolved.defaultsApplied.includes("baseUrl"));
});

test("diffProjectConfig reports only the fields that changed", () => {
  const left = { ...SAMPLE };
  const right = { ...SAMPLE, baseUrl: "http://localhost:9999" };
  const changed = diffProjectConfig(left, right);
  assert.deepEqual(Object.keys(changed), ["baseUrl"]);
  assert.equal(changed.baseUrl.to, "http://localhost:9999");
});

test("diffProjectConfig is empty when nothing changed", () => {
  assert.deepEqual(diffProjectConfig(SAMPLE, SAMPLE), {});
});

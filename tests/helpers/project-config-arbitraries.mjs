import fc from "fast-check";

import {
  CONFIGURABLE_FIELDS,
  SERVER_LIFECYCLE_VALUES,
  SPEC_MODE_VALUES,
  WCAG_TAG_VALUES,
} from "../../skills/testador-subagents/scripts/lib/project-config.mjs";

/** Instante ISO 8601 arbitrario, com precisao de segundos (o que o renderer preserva). */
export function arbInstant() {
  return fc
    .date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-01-01T00:00:00Z"), noInvalidDate: true })
    .map((date) => `${date.toISOString().slice(0, 19)}Z`);
}

function arbUrl() {
  return fc.constantFrom(
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "https://staging.example.com",
  );
}

function arbCommaList(values, min = 1, max = 3) {
  return fc
    .uniqueArray(fc.constantFrom(...values), { minLength: min, maxLength: max })
    .map((entries) => entries.join(","));
}

function arbViewports() {
  return arbCommaList(["390x844", "1440x900", "1280x720", "768x1024"], 1, 2);
}

export function arbProjectConfigFields() {
  return fc.record({
    schemaVersion: fc.constant(1),
    updatedAt: arbInstant(),
    baseUrl: arbUrl(),
    apiBaseUrl: fc.oneof(arbUrl(), fc.constant("")),
    startCommand: fc.oneof(fc.constant("docker compose up --build"), fc.constant("npm run dev"), fc.constant("")),
    readyTimeoutSeconds: fc.integer({ min: 1, max: 600 }),
    wcagTags: arbCommaList(WCAG_TAG_VALUES),
    a11yBlocking: fc.boolean(),
    viewports: arbViewports(),
    seedCredentialsRef: fc.oneof(fc.constant(".env.test"), fc.constant("")),
    serverLifecycle: fc.constantFrom(...SERVER_LIFECYCLE_VALUES),
    specMode: fc.constantFrom(...SPEC_MODE_VALUES),
    defaultsApplied: fc.constant([]),
  });
}

export { CONFIGURABLE_FIELDS };

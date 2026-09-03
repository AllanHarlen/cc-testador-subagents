import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { intelligenceResult } from "./intelligence.mjs";

/**
 * Parser de relatorios Playwright (JSON + JUnit).
 * Converte o output do playwright test em envelope de intelligence.
 */

export class PlaywrightReportError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PlaywrightReportError";
    this.code = code;
    this.details = details;
  }
}

function parsePlaywrightJson(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const suites = raw.suites ?? [];
  let total = 0, passed = 0, failed = 0, skipped = 0;
  const failedTests = [];

  function walk(suite) {
    for (const test of suite.specs ?? suite.tests ?? []) {
      const results = test.tests ?? [test];
      for (const result of results) {
        const attempts = result.results?.length ? result.results : [result];
        for (const attempt of attempts) {
          total += 1;
          const status = attempt.status ?? result.status ?? result.outcome ?? "unknown";
          if (["passed", "expected"].includes(status)) passed += 1;
          else if (["failed", "unexpected", "flaky", "timedOut"].includes(status)) {
            failed += 1;
            const errors = [
              ...(attempt.errors ?? []),
              ...(attempt.error ? [attempt.error] : []),
              ...(result.errors ?? []),
              ...(result.error ? [result.error] : []),
            ].filter(Boolean);
            failedTests.push({
              title: test.title ?? result.title,
              testTitle: test.title ?? result.title,
              projectName: result.projectName ?? attempt.projectName ?? null,
              status,
              error: errors[0]?.message ?? null,
              errors,
              attachments: attempt.attachments ?? [],
            });
          } else {
            skipped += 1;
          }
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  }

  for (const suite of suites) walk(suite);
  return { summary: { total, passed, failed, skipped, status: failed === 0 ? "PASS" : "FAIL" }, failedTests };
}

export function parsePlaywrightReport(artefatosDir) {
  const reportDir = join(resolve(artefatosDir), "run", "playwright-report");
  const jsonPath = join(reportDir, "results.json");
  if (!existsSync(jsonPath)) {
    return {
      found: false,
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, status: "UNKNOWN" },
      failedTests: [],
    };
  }
  try {
    const parsed = parsePlaywrightJson(jsonPath);
    return { found: true, ...parsed };
  } catch (error) {
    throw new PlaywrightReportError("PLAYWRIGHT_REPORT_INVALID", `Cannot parse Playwright report: ${error.message}`, { path: jsonPath });
  }
}

export function collectPlaywrightResults(artefatosDir, options = {}) {
  const parsed = parsePlaywrightReport(artefatosDir);
  const summary = {
    filesChecked: parsed.found ? 1 : 0,
    filesParsed: parsed.found ? 1 : 0,
    filesUnparsed: 0,
    total: parsed.summary?.total ?? 0,
    passed: parsed.summary?.passed ?? 0,
    failed: parsed.summary?.failed ?? 0,
    skipped: parsed.summary?.skipped ?? 0,
    durationSeconds: null,
    status: parsed.summary?.status ?? "UNKNOWN",
  };
  if (parsed.found) {
    const reportDir = join(resolve(artefatosDir), "run", "playwright-report");
    const findingsPath = join(reportDir, "findings.json");
    mkdirSync(reportDir, { recursive: true });
    const findings = (parsed.failedTests ?? []).map((test) => ({
      category: "PLAYWRIGHT_TEST_FAILED",
      severity: "critical",
      title: `Playwright test failed: ${test.title ?? "unknown"}`,
      evidence: test,
    }));
    const temporary = `${findingsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
    renameSync(temporary, findingsPath);
  }
  return intelligenceResult(
    "playwright-results",
    summary,
    { failedTests: parsed.failedTests ?? [], artefatosDir: resolve(artefatosDir) },
    options,
  );
}

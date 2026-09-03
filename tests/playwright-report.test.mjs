import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { collectPlaywrightResults } from "../skills/testador-subagents/scripts/lib/playwright-report.mjs";

test("collectPlaywrightResults counts project attempts and preserves nested errors", () => {
  const root = mkdtempSync(join(tmpdir(), "pw-report-test-"));
  try {
    const dir = join(root, "run", "playwright-report");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify({ suites: [{ specs: [{ title: "checkout", tests: [
      { title: "checkout", projectName: "mobile", status: "unexpected", results: [{ status: "failed", errors: [{ message: "boom" }] }] },
      { title: "checkout", projectName: "desktop", status: "expected", results: [{ status: "passed" }] },
    ] }] }] }), "utf8");
    const result = collectPlaywrightResults(root);
    assert.deepEqual(result.summary, { filesChecked: 1, filesParsed: 1, filesUnparsed: 0, total: 2, passed: 1, failed: 1, skipped: 0, durationSeconds: null, status: "FAIL" });
    assert.equal(result.details.failedTests[0].error, "boom");
    assert.equal(result.details.failedTests[0].projectName, "mobile");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

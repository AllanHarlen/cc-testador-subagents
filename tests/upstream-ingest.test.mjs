/**
 * Ingestao de upstream: descobre o handoff do Orquestrador, sobe a chain
 * ate o Pensador, detecta modo conjunto vs avulso, variacao de versao
 * incompativel, varios slugs (ambiguidade).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ingestUpstream } from "../skills/testador-subagents/scripts/lib/upstream-ingest.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "upstream-ingest-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeHandoff(root, relativePath, handoff) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(handoff, null, 2), "utf8");
}

function baseHandoff(stage, slug, upstream = null, nextStage = null) {
  return {
    handoffVersion: 1,
    stage,
    slug,
    producer: { plugin: `cc-${stage}`, version: "1.0.0" },
    artifactRoot: `.${stage === "orchestrador" ? "orchestration" : stage}/${slug}`,
    status: "DONE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    summary: `${stage} done`,
    upstream,
    artifacts: [],
    nextStage,
  };
}

test("returns standalone mode when no .orchestration/ directory exists", () => {
  const root = fixture();
  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.mode, "standalone");
  assert.ok(result.warning);
});

test("detects joint mode from .orchestration/<slug>/report/handoff.json (layout v2)", () => {
  const root = fixture();
  writeHandoff(
    root,
    ".orchestration/login-social/report/handoff.json",
    baseHandoff("orchestrador", "login-social", null, {
      consumer: "cc-testador-subagents",
      entrypoint: "/testador",
    }),
  );

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.mode, "joint");
  assert.equal(result.slug, "login-social");
  assert.ok(result.orchestradorHandoff);
});

test("falls back to root handoff.json for pre-v2 Orchestrador layout", () => {
  const root = fixture();
  writeHandoff(
    root,
    ".orchestration/login-social/handoff.json",
    baseHandoff("orchestrador", "login-social"),
  );

  const result = ingestUpstream({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "joint");
});

test("follows upstream chain to the Pensador handoff", () => {
  const root = fixture();
  const pensadorHandoff = baseHandoff("pensador", "login-social");
  pensadorHandoff.artifactRoot = ".pensador/login-social-v1";
  pensadorHandoff.upstream = null;

  const orchestradorHandoff = baseHandoff("orchestrador", "login-social", {
    stage: "pensador",
    handoffPath: ".pensador/login-social-v1/handoff.json",
  });

  writeHandoff(root, ".pensador/login-social-v1/handoff.json", pensadorHandoff);
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", orchestradorHandoff);

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.mode, "joint");
  assert.ok(result.pensadorHandoff !== null);
  assert.equal(result.pensadorHandoff.stage, "pensador");
});

test("detects hasOpenDesign from design-system-files role in Pensador artifacts", () => {
  const root = fixture();
  const pensadorHandoff = {
    ...baseHandoff("pensador", "login-social"),
    artifactRoot: ".pensador/login-social-v1",
    artifactMode: "prd",
    artifacts: [
      {
        role: "design-system-files",
        path: "design-systems/default/",
        required: true,
        materializeInto: "packages/ui/design-systems/default",
      },
    ],
  };

  const orchestradorHandoff = baseHandoff("orchestrador", "login-social", {
    stage: "pensador",
    handoffPath: ".pensador/login-social-v1/handoff.json",
  });

  writeHandoff(root, ".pensador/login-social-v1/handoff.json", pensadorHandoff);
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", orchestradorHandoff);

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.ingest.hasOpenDesign, true);
  assert.equal(result.ingest.designSystemFilesEntries.length, 1);
  assert.equal(result.ingest.designSystemFilesEntries[0].materializeInto, "packages/ui/design-systems/default");
});

test("detects hasOpenSpec from openspec-change role in Pensador artifacts", () => {
  const root = fixture();
  const pensadorHandoff = {
    ...baseHandoff("pensador", "login-social"),
    artifactRoot: ".pensador/login-social-v1",
    artifactMode: "spec",
    artifacts: [
      { role: "openspec-change", path: "openspec/changes/login-social-v1/", required: true },
    ],
  };

  const orchestradorHandoff = baseHandoff("orchestrador", "login-social", {
    stage: "pensador",
    handoffPath: ".pensador/login-social-v1/handoff.json",
  });

  writeHandoff(root, ".pensador/login-social-v1/handoff.json", pensadorHandoff);
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", orchestradorHandoff);

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.ingest.hasOpenSpec, true);
  assert.ok(result.ingest.openSpecChangePath);
  assert.equal(result.ingest.openSpecChangeName, "login-social-v1", "must derive the change directory name, not its parent (`changes`)");
});

test("returns ambiguous mode when multiple Orchestrador slugs exist without explicit slug", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", baseHandoff("orchestrador", "login-social"));
  writeHandoff(root, ".orchestration/checkout/report/handoff.json", baseHandoff("orchestrador", "checkout"));

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.mode, "ambiguous");
  assert.ok(result.slugCandidates.length >= 2);
});

test("degrades to standalone mode when handoff has unsupported handoffVersion", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", {
    handoffVersion: 99,
    stage: "orchestrador",
    slug: "login-social",
  });

  const result = ingestUpstream({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "standalone");
  assert.ok(result.warning?.includes("version") || result.warning?.includes("standalone"));
});

test("prefers a valid pre-v2 root handoff over a corrupt v2 handoff, instead of masking it (N-14)", () => {
  const root = fixture();
  // v2 path exists but is not valid JSON.
  const v2Path = join(root, ".orchestration/login-social/report/handoff.json");
  mkdirSync(join(v2Path, ".."), { recursive: true });
  writeFileSync(v2Path, "{ not valid json", "utf8");
  // Legacy root path is a valid handoff.
  writeHandoff(root, ".orchestration/login-social/handoff.json", baseHandoff("orchestrador", "login-social"));

  const result = ingestUpstream({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "joint", "a valid legacy handoff must not be masked by a corrupt v2 handoff");
  assert.ok(result.orchestradorHandoff);
});

test("does not count an orphan .orchestration/<slug>/ directory without a handoff.json as a slug candidate (N-15)", () => {
  const root = fixture();
  writeHandoff(root, ".orchestration/login-social/report/handoff.json", baseHandoff("orchestrador", "login-social"));
  // Orphan directory from a cancelled run: no handoff.json anywhere inside it.
  mkdirSync(join(root, ".orchestration/abandoned-run"), { recursive: true });
  writeFileSync(join(root, ".orchestration/abandoned-run/some-other-file.txt"), "leftover", "utf8");

  const result = ingestUpstream({ projectRoot: root });
  assert.equal(result.mode, "joint", "the orphan directory must not force a spurious ambiguity");
  assert.equal(result.slug, "login-social");
});

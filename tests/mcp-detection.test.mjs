/**
 * Deteccao do Playwright MCP e do Context7 MCP nos locais candidatos de
 * config do Claude Code. Marker (`@playwright/mcp`) evita o falso-positivo
 * documentado nos plugins irmaos: um nome comum ("playwright") pode colidir
 * com uma definicao nao relacionada cujo command/args contenham a substring.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PLAYWRIGHT_CONFIG_CANDIDATES,
  PLAYWRIGHT_DEFINITION_MARKERS,
  PLAYWRIGHT_SERVER_NAMES,
  resolveCandidate,
} from "../skills/testador-subagents/scripts/lib/mcp-candidates.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-detection-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeMcpConfig(path, servers) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
}

/** Mirrors preflight.mjs's own search logic for use in isolated unit tests. */
function findServer(candidates, ctx, names, markers) {
  const wanted = names.map((n) => n.toLowerCase());
  const wantedMarkers = markers.map((m) => m.toLowerCase());
  for (const candidate of candidates) {
    const path = resolveCandidate(candidate, ctx);
    if (!existsSync(path)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    for (const [name, definition] of Object.entries(json.mcpServers ?? {})) {
      if (wanted.includes(name.toLowerCase())) return { path, server: name };
      const blob = JSON.stringify(definition ?? "").toLowerCase();
      if (wantedMarkers.some((m) => blob.includes(m))) return { path, server: name };
    }
  }
  return null;
}

test("PLAYWRIGHT_CONFIG_CANDIDATES resolve to absolute paths under home/cwd", () => {
  const root = fixture();
  const home = join(root, "home");
  const resolved = PLAYWRIGHT_CONFIG_CANDIDATES.map((c) => resolveCandidate(c, { home, cwd: root }));
  assert.ok(resolved.every((p) => p.startsWith(home) || p.startsWith(root)));
});

test("finds Playwright registered under its own name", () => {
  const root = fixture();
  const configPath = join(root, ".mcp.json");
  writeMcpConfig(configPath, { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } });

  const hit = findServer(
    [{ base: "cwd", segments: [".mcp.json"], format: "json" }],
    { home: join(root, "home"), cwd: root },
    PLAYWRIGHT_SERVER_NAMES,
    PLAYWRIGHT_DEFINITION_MARKERS,
  );
  assert.ok(hit);
  assert.equal(hit.server, "playwright");
});

test("finds Playwright registered under a custom name via the definition marker", () => {
  const root = fixture();
  const configPath = join(root, ".mcp.json");
  writeMcpConfig(configPath, { pw: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } });

  const hit = findServer(
    [{ base: "cwd", segments: [".mcp.json"], format: "json" }],
    { home: join(root, "home"), cwd: root },
    PLAYWRIGHT_SERVER_NAMES,
    PLAYWRIGHT_DEFINITION_MARKERS,
  );
  assert.ok(hit, "must match via the @playwright/mcp marker even under a custom server name");
  assert.equal(hit.server, "pw");
});

test("does not false-positive on an unrelated server whose args merely contain a similar path", () => {
  const root = fixture();
  const configPath = join(root, ".mcp.json");
  // Server named "playwright-notes" with an unrelated command — must not match the marker.
  writeMcpConfig(configPath, { "some-other-server": { command: "node", args: ["./scripts/playwright-notes.js"] } });

  const hit = findServer(
    [{ base: "cwd", segments: [".mcp.json"], format: "json" }],
    { home: join(root, "home"), cwd: root },
    PLAYWRIGHT_SERVER_NAMES,
    PLAYWRIGHT_DEFINITION_MARKERS,
  );
  assert.equal(hit, null, "a path substring must not be mistaken for the @playwright/mcp package marker");
});

test("returns null when no candidate file exists", () => {
  const root = fixture();
  const hit = findServer(
    [{ base: "cwd", segments: [".mcp.json"], format: "json" }],
    { home: join(root, "home"), cwd: root },
    PLAYWRIGHT_SERVER_NAMES,
    PLAYWRIGHT_DEFINITION_MARKERS,
  );
  assert.equal(hit, null);
});

/**
 * Ciclo de vida de servidor: aguarda porta, timeout vira achado bloqueante,
 * portFromUrl extrai porta corretamente.
 * Nao sobe servidor real -- so testa a logica de parse e timeout curto.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { portFromUrl, waitForPort, ServerLifecycleError } from "../runner/server-lifecycle.mjs";

test("portFromUrl extracts port from http URL", () => {
  assert.equal(portFromUrl("http://localhost:5173"), 5173);
});

test("portFromUrl extracts port from https URL", () => {
  assert.equal(portFromUrl("https://example.com:8443"), 8443);
});

test("portFromUrl defaults to 80 for http and 443 for https without explicit port", () => {
  assert.equal(portFromUrl("http://example.com"), 80);
  assert.equal(portFromUrl("https://example.com"), 443);
});

test("portFromUrl returns null for invalid URL", () => {
  assert.equal(portFromUrl("not-a-url"), null);
});

test("waitForPort rejects with PORT_NOT_READY after a very short timeout on a closed port", async () => {
  // Port 19999 is almost certainly not open in this test environment.
  await assert.rejects(
    () => waitForPort(19999, "127.0.0.1", 200), // 200ms timeout
    (error) => error instanceof ServerLifecycleError && error.code === "PORT_NOT_READY",
  );
});

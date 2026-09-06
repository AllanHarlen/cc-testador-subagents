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

  // 1. Todo custom property que resolve no :root.
  const tokens = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules ?? [])) {
      if (rule.selectorText !== ':root' || !rule.style) continue;
      for (let i = 0; i < rule.style.length; i += 1) {
        const prop = rule.style[i];
        if (prop.startsWith('--')) tokens[prop] = rootStyle.getPropertyValue(prop).trim();
      }
    }
  }

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

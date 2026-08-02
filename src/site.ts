import { config } from "./config.js";

/**
 * The human- and crawler-facing surface of the service.
 *
 * Everything else here answers agents in JSON. This module exists because the
 * x402 facilitator is an indexer, not a registry: merchant identity in the
 * public catalogue is read automatically from whatever the merchant's own
 * domain serves. A service that answers every GET with `application/json` gives
 * it nothing to read, and shows up as a truncated payTo address. So does a
 * developer who follows a catalogue link in a browser.
 *
 * The pages are generated from the same route manifest the paywall uses, so a
 * price or capability can never be advertised here that a 402 would not honour.
 */

export interface ManifestEntry {
  resource: string;
  method: string;
  price: string;
  description: string;
}

export const SITE = {
  name: "Algo Verdict API",
  tagline: "The blockchain intelligence layer for AI agents, wallets and DeFi",
  description:
    "Explainable blockchain intelligence that AI agents buy per request, settled in USDC on " +
    "Algorand over x402. No API key, no account, no subscription.",
  repo: "https://github.com/AlgoIntel01/Algo-Verdict",
  sdkPackage: "https://www.npmjs.com/package/verdict-sdk",
  mcpPackage: "https://www.npmjs.com/package/verdict-mcp",
} as const;

/**
 * Serve HTML only when the caller explicitly asked for it.
 *
 * `fetch()` sends `Accept: * / *` when no header is set, which is what the SDK,
 * the MCP server and the benchmark script all do — they must keep receiving
 * JSON. Browsers and metadata crawlers name `text/html` outright. That
 * distinction is the whole content-negotiation rule; nothing else qualifies.
 */
export function prefersHtml(accept: string | undefined): boolean {
  return (accept ?? "").toLowerCase().includes("text/html");
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `$0.08 ($0.50 with ?depth=deep)` → `0.08`, for schema.org offers. */
function numericPrice(price: string): string | null {
  return price.match(/\$([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? null;
}

/** The route path from a fully-qualified resource URL. */
export function pathOf(resource: string): string {
  try {
    return new URL(resource).pathname;
  } catch {
    return resource;
  }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#5c6370;--line:#e3e6eb;--card:#f7f8fa;--accent:#1a6feb}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6e9ef;--muted:#9aa4b2;--line:#232a35;--card:#141a23;--accent:#5aa2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:52rem;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 .35rem;letter-spacing:-.02em}
h2{font-size:1.15rem;margin:2.75rem 0 .85rem;letter-spacing:-.01em}
p{margin:0 0 1rem}
.tagline{color:var(--muted);font-size:1.1rem;margin:0 0 1.5rem}
.badges{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 2rem;padding:0;list-style:none}
.badges li{border:1px solid var(--line);border-radius:999px;padding:.25rem .7rem;font-size:.82rem;color:var(--muted)}
.endpoints{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.endpoint{display:block;padding:.9rem 1rem;border-top:1px solid var(--line);color:inherit;text-decoration:none}
.endpoint:first-child{border-top:0}
.endpoint:hover{background:var(--card)}
.endpoint .row{display:flex;gap:1rem;align-items:baseline;justify-content:space-between}
.endpoint code{font-size:.9rem;font-weight:600}
.price{color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:.9rem}
.desc{color:var(--muted);font-size:.88rem;margin:.3rem 0 0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.9rem 1rem;overflow-x:auto;font-size:.85rem;line-height:1.55}
a{color:var(--accent)}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.25rem;margin:0;font-size:.9rem}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
footer{margin-top:3.5rem;padding-top:1.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
`.trim();

interface HeadOptions {
  title: string;
  description: string;
  canonical: string;
}

function head({ title, description, canonical }: HeadOptions): string {
  const image = `${config.baseUrl}/og.png`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(SITE.name)} — ${esc(SITE.tagline)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<style>${STYLE}</style>`;
}

/**
 * schema.org description of the service, one Offer per paid route. Prices come
 * from the manifest, so they cannot disagree with what the paywall charges.
 */
function jsonLd(entries: ManifestEntry[]): string {
  const doc = {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: SITE.name,
    description: SITE.description,
    url: `${config.baseUrl}/`,
    image: `${config.baseUrl}/og.png`,
    documentation: `${config.baseUrl}/llms.txt`,
    termsOfService: `${config.baseUrl}/.well-known/x402`,
    provider: { "@type": "Organization", name: SITE.name, url: `${config.baseUrl}/` },
    sameAs: [SITE.repo, SITE.sdkPackage, SITE.mcpPackage],
    offers: entries.map((entry) => {
      const price = numericPrice(entry.price);
      // /wallet/analyze prices as a range ("$0.08 ($0.50 with ?depth=deep)"),
      // which a single Offer.price cannot express. Publish the base price and
      // keep the full pricing string in the description rather than dropping
      // the more expensive mode silently.
      const ranged = price !== null && entry.price !== `$${price}`;
      return {
        "@type": "Offer",
        name: `${entry.method} ${pathOf(entry.resource)}`,
        description: ranged ? `${entry.description} Pricing: ${entry.price}.` : entry.description,
        url: entry.resource,
        ...(price ? { price, priceCurrency: "USD" } : {}),
      };
    }),
  };
  // Only "</" can break out of a script element; escaping it keeps the block
  // safe without mangling the JSON itself.
  return `<script type="application/ld+json">${JSON.stringify(doc).replace(/<\//g, "<\\/")}</script>`;
}

function endpointList(entries: ManifestEntry[]): string {
  return entries
    .map(
      (entry) => `<a class="endpoint" href="${esc(pathOf(entry.resource))}">
<span class="row"><code>${esc(entry.method)} ${esc(pathOf(entry.resource))}</code><span class="price">${esc(entry.price)}</span></span>
<p class="desc">${esc(entry.description)}</p>
</a>`,
    )
    .join("\n");
}

function settlementTable(): string {
  return `<dl>
<dt>Protocol</dt><dd>x402, <code>exact</code> scheme</dd>
<dt>Asset</dt><dd>USDC (ASA ${config.usdcAsaId}) on Algorand ${esc(config.network)}</dd>
<dt>Paid to</dt><dd><code>${esc(config.sellerAddress)}</code></dd>
<dt>Facilitator</dt><dd><a href="${esc(config.facilitatorUrl)}">${esc(config.facilitatorUrl)}</a></dd>
<dt>Fees</dt><dd>Gasless — the facilitator pays the transaction fee</dd>
</dl>`;
}

/** The front door: what this sells, at what price, and how to pay for it. */
export function renderLandingPage(entries: ManifestEntry[]): string {
  const title = `${SITE.name} — ${SITE.tagline}`;
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description: SITE.description, canonical: `${config.baseUrl}/` })}
${jsonLd(entries)}
</head>
<body>
<main>
<h1>${esc(SITE.name)}</h1>
<p class="tagline">${esc(SITE.tagline)}</p>
<ul class="badges">
<li>Pay per request</li>
<li>USDC on Algorand</li>
<li>No API key</li>
<li>No account</li>
<li>Gasless</li>
</ul>

<p>Every score names the signals that produced it, and every field a data source cannot provide
comes back <code>null</code> rather than a guess — so an agent can tell "we looked and it is clean"
apart from "we could not see".</p>

<h2>Endpoints</h2>
<div class="endpoints">
${endpointList(entries)}
</div>

<h2>How paying works</h2>
<p>Call an endpoint without payment and you get <code>HTTP 402</code> with the terms in the
<code>payment-required</code> header, including a Bazaar discovery extension describing the input
schema. Pay, repeat the request, get the answer. A caller needs USDC and nothing else.</p>
<pre><code>curl -X POST ${esc(config.baseUrl)}/token/analyze \\
  -H "Content-Type: application/json" \\
  -d '{"asset": "31566704", "chain": "algorand"}'</code></pre>

<h2>Clients</h2>
<p>An MCP server, so any MCP-capable agent can call these tools directly:</p>
<pre><code>npx -y verdict-mcp</code></pre>
<p>Or the typed TypeScript client, which handles the 402 exchange for you:</p>
<pre><code>npm install verdict-sdk</code></pre>
<p>No Algorand wallet yet? <a href="/fund">GET /fund</a> is a free recipe for getting an agent from
zero to able-to-pay. Circle's CCTP does not bridge to Algorand, so it describes the route that
actually works.</p>

<h2>Machine-readable</h2>
<p><a href="/llms.txt">/llms.txt</a> · <a href="/.well-known/x402">/.well-known/x402</a> ·
<a href="/">service card (JSON)</a> · <a href="/health">/health</a> · <a href="/ready">/ready</a></p>
<p>Both catalogues are generated from the same route configuration the paywall enforces, so they
cannot drift from what a 402 demands.</p>

<h2>Settlement</h2>
${settlementTable()}

<footer>
<p>Source: <a href="${esc(SITE.repo)}">${esc(SITE.repo)}</a> · MIT licensed ·
<a href="${esc(SITE.mcpPackage)}">verdict-mcp</a> · <a href="${esc(SITE.sdkPackage)}">verdict-sdk</a></p>
</footer>
</main>
</body>
</html>
`;
}

/**
 * Served for a GET on a paid route. The Bazaar catalogue publishes these exact
 * URLs, so they are what a crawler or a curious developer lands on first — a
 * bare 404 there wastes the only introduction the service gets.
 */
export function renderEndpointPage(entry: ManifestEntry): string {
  const path = pathOf(entry.resource);
  const title = `${entry.method} ${path} — ${SITE.name}`;
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description: entry.description, canonical: entry.resource })}
</head>
<body>
<main>
<h1>${esc(entry.method)} ${esc(path)}</h1>
<p class="tagline">${esc(entry.price)} per request · <a href="/">${esc(SITE.name)}</a></p>
<p>${esc(entry.description)}</p>

<h2>Calling it</h2>
<p>This endpoint answers <code>${esc(entry.method)}</code> only, and it is paid. Send the request
without payment to receive <code>HTTP 402</code> and the terms, including the input schema:</p>
<pre><code>curl -X ${esc(entry.method)} ${esc(entry.resource)} \\
  -H "Content-Type: application/json" \\
  -d '{ ... }'</code></pre>
<p>The full input and output schema for this endpoint is in
<a href="/.well-known/x402">/.well-known/x402</a> and in the <code>payment-required</code> header of
the 402 itself.</p>

<h2>Settlement</h2>
${settlementTable()}

<footer>
<p><a href="/">All endpoints</a> · <a href="${esc(SITE.repo)}">Source</a> ·
<a href="/llms.txt">/llms.txt</a></p>
</footer>
</main>
</body>
</html>
`;
}

/** Inline mark, small enough to serve from memory. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0d1117"/>
<path d="M14 44 L32 16 L50 44" fill="none" stroke="#5aa2ff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M23 38 L41 38" fill="none" stroke="#5aa2ff" stroke-width="7" stroke-linecap="round"/>
</svg>`;

// Self-hosted CORS proxy for SoCalMapFishing, meant to replace/supplement the
// free public relays (api.codetabs.com, corsproxy.io, api.allorigins.win)
// that index.html races in proxyUrlsFor() — those have no SLA and have shown
// real outages/policy changes (corsproxy.io started refusing this kind of
// request entirely; codetabs has returned server errors). This Worker only
// proxies the specific NOAA/third-party hosts the app actually needs (not an
// open proxy to anywhere), and runs on Cloudflare's free tier — 100,000
// requests/day, resets daily, no forced upgrade, no credit card required.
//
// Deploy (no local tooling needed):
//   1. Sign up free at https://dash.cloudflare.com/sign-up
//   2. Workers & Pages -> Create -> Create Worker
//   3. Delete the default starter code, paste this whole file in, click Deploy
//   4. Copy the worker's URL (looks like https://<name>.<subdomain>.workers.dev)
//   5. Add it to proxyUrlsFor() in index.html:
//        `https://<your-worker>.workers.dev/?url=${encodeURIComponent(targetUrl)}`
//      alongside (not replacing) the existing three, so the app keeps its
//      existing fallback behavior if this Worker is ever unreachable too.

const ALLOWED_HOSTS = new Set([
  'coastwatch.pfeg.noaa.gov',   // SST, currents, chlorophyll, wave forecast (ERDDAP)
  'www.sandiegofishreports.com', // fish counts
  'www.ndbc.noaa.gov',           // real-time buoy swell
  'api.opentopodata.org',        // depth lookup
]);

function corsHeaders(extra) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: corsHeaders() });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('Invalid target URL', { status: 400, headers: corsHeaders() });
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, { status: 403, headers: corsHeaders() });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': 'SoCalMapFishing-Proxy/1.0 (+https://gavenobrecht.github.io/SoCalMapFishing/)' },
        cf: { cacheTtl: 0 }, // this app already caches responses itself (proxyResponseCache) — no need to double-cache here
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: corsHeaders() });
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: corsHeaders({ 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' }),
    });
  },
};

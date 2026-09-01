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
//
// Updating an already-deployed Worker: same dashboard, Workers & Pages ->
// your worker -> Edit code -> select all, paste this file's new contents
// in, Deploy. No new signup, no new URL — index.html doesn't need any
// changes for this update.
//
// 2026-08-13: added edge caching (see cacheTtlSeconds/caches.default below)
// — this is the actual fix for coastwatch.pfeg.noaa.gov's confirmed-live
// ~40-60% reliability *from Cloudflare's network specifically* (verified
// live with curl: direct, non-Cloudflare requests to the same URL are
// consistently fast and reliable). Retrying harder can't fix an unreliable
// origin; serving repeat requests from cache without touching the origin
// again can. Unverified as of this comment whether caches.default actually
// works on a bare *.workers.dev subdomain (some Cloudflare docs/versions
// have scoped the Cache API to custom domains only) — confirm this is
// actually caching (e.g. a second identical request coming back
// near-instantly) after redeploying, don't just assume it from this code.

const ALLOWED_HOSTS = new Set([
  'coastwatch.pfeg.noaa.gov',   // SST, chlorophyll, wave forecast (ERDDAP)
  'coastwatch.noaa.gov',        // offshore currents (ERDDAP) — see 2026-09-01 note below
  'www.sandiegofishreports.com', // fish counts
  'www.ndbc.noaa.gov',           // real-time buoy swell
  'api.opentopodata.org',        // depth lookup
]);

// 2026-09-01: offshore currents moved off coastwatch.pfeg.noaa.gov's
// `miamicurrents` dataset (confirmed dead — it 302-redirects to
// cwcgom.aoml.noaa.gov, which hard-403s every relay, see index.html's
// fetchOffshoreCurrentGrid comment) onto coastwatch.noaa.gov's
// `noaacwBLENDEDNRTcurrentsDaily`, a live near-real-time replacement with
// the same u_current/v_current variable names. That host has its own quirk
// confirmed live via curl: it 403s any non-browser-looking User-Agent
// (bare curl UA and this Worker's old identifying UA string both got 403;
// a Chrome UA got 200) — that's why the fetch below now sends a browser UA
// instead of a self-identifying one. Confirmed that swap doesn't break any
// of the other ALLOWED_HOSTS (all 200 with the browser UA too).

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

// Per-host edge-cache TTL, in seconds. This is the actual fix for the
// biggest reliability problem this proxy has: coastwatch.pfeg.noaa.gov is
// confirmed-live only ~40-60% reliable *specifically from Cloudflare's
// network* (direct requests from a normal residential/dev IP are fine), so
// no amount of client-side retrying fully solves it — the origin itself is
// the unreliable part. Caching successful responses at Cloudflare's edge
// means only the FIRST successful fetch for a given query ever has to
// survive that coin flip; every request after it (from this user reloading
// the page, or a different visitor entirely) is served from the edge and
// never touches the flaky origin at all.
//
// TTLs are host-aware, not a single blanket policy, specifically to avoid
// reproducing a bug the client's own cache (proxyResponseCache in
// index.html) already had to special-case: that cache treats any ERDDAP
// query without a literal "(last)" in it as historical/never-changing —
// correct for a "(last-N days)" SST query, wrong for a fish-counts or
// buoy-swell query, which don't use ERDDAP's syntax at all but still
// change throughout the day. See fetchTextViaProxies's callers in
// index.html, which route around fetchJsonViaProxies's cache entirely for
// exactly this reason.
function cacheTtlSeconds(hostname, targetUrlStr) {
  if (hostname === 'api.opentopodata.org') return 86400; // bathymetry at a given point is static
  if (hostname === 'www.sandiegofishreports.com') return 600; // dock totals change through the day as boats report in
  if (hostname === 'www.ndbc.noaa.gov') return 600; // buoy readings update roughly hourly; 10 min stays responsive
  // Both ERDDAP hosts (coastwatch.pfeg.noaa.gov and coastwatch.noaa.gov):
  // "(last)" means live/current-conditions
  // (including the wave-forecast strip's own query, which ends in a
  // "...:(last)]" range and so still matches this — appropriate, since its
  // answer changes daily and a short TTL keeps it from ever going stale
  // rather than accidentally landing in the long-lived historical bucket).
  // Anything else is a "(last-N)" historical query that never changes once
  // published, so it can be cached far longer.
  return targetUrlStr.includes('(last)') ? 300 : 86400;
}

export default {
  async fetch(request, env, ctx) {
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

    // Keyed on the worker's own request URL, which already fully encodes
    // the target (dataset+bounds+stride+day, or fish-counts date, etc.) via
    // the ?url= param — so two different queries never collide, and the
    // exact same query from any visitor is a cache hit.
    const cache = caches.default;
    const cacheKey = new Request(reqUrl.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // coastwatch.pfeg.noaa.gov specifically has confirmed-live ~50% odds of
    // hanging/failing per attempt *from Cloudflare's network* (not a general
    // internet issue — direct requests from a normal residential/dev IP are
    // reliable), even though the client above only sees one shot per relay
    // per round. Retrying here, server-to-server, is cheap and turns that
    // coin flip into much better odds before the client's own 3-round races
    // ever come into play, instead of relying on the client to out-wait it.
    let upstream, lastErr;
    for (let attempt = 0; attempt < 3 && !upstream; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        upstream = await fetch(targetUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
          cf: { cacheTtl: 0 }, // Cloudflare's own origin-fetch cache is separate from (and redundant with) the caches.default use below — disabled here so there's exactly one cache layer to reason about, not two.
          signal: controller.signal,
        });
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!upstream) {
      return new Response('Upstream fetch failed: ' + (lastErr && lastErr.message), { status: 502, headers: corsHeaders() });
    }

    const body = await upstream.arrayBuffer();
    const response = new Response(body, {
      status: upstream.status,
      headers: corsHeaders({ 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' }),
    });

    // Only cache genuine successes — caching a 502/403/etc. would mean
    // everyone gets served that same failure for the rest of the TTL
    // instead of getting a fresh shot at the origin.
    if (upstream.ok) {
      const ttl = cacheTtlSeconds(targetUrl.hostname, target);
      const cacheable = new Response(body, {
        status: response.status,
        headers: corsHeaders({
          'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
          'Cache-Control': `public, max-age=${ttl}`,
        }),
      });
      ctx.waitUntil(cache.put(cacheKey, cacheable));
    }

    return response;
  },
};

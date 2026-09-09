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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

// ---------- Stripe subscription billing (Premium tier) ----------
// Added 2026-09-09 so the fish-movement scrub/trend can actually be gated
// to paying subscribers instead of the static ENABLE_DAY_SCRUB_AND_TREND
// flag in index.html, which currently just hides the UI for everyone or
// no one with no concept of who's actually paid. Three new routes below
// (checked against request.url's pathname before the GET-only CORS-proxy
// logic further down, which stays the default/fallback behavior):
//   POST /create-checkout-session  { uid, email, plan, successUrl, cancelUrl } -> { url }
//   POST /stripe-webhook           (Stripe calls this directly)
//   GET  /subscription-status?uid=<uid> -> { status, plan, currentPeriodEnd }
//
// Subscription status lives in a Cloudflare KV namespace (binding name
// SUBSCRIPTIONS, created + bound in the dashboard, not in this file) keyed
// by the app's Firebase uid — not Firestore, so this Worker never needs a
// Google service-account credential just to write one field. The uid gets
// onto the Stripe Subscription object itself via subscription_data.metadata
// at Checkout Session creation time, so every later subscription lifecycle
// webhook (updated/deleted) already carries it in event.data.object.metadata
// without a separate customer-id-to-uid lookup table.
//
// Needs three secrets set in the Worker's dashboard (Settings -> Variables
// and Secrets) before any of this actually works: STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET (from the webhook endpoint's settings in the Stripe
// dashboard, created after this Worker is deployed so the URL exists to
// paste in), STRIPE_PRICE_MONTHLY and STRIPE_PRICE_ANNUAL (the two
// recurring Price ids from the Premium product). Until those are set,
// /create-checkout-session and /stripe-webhook return a clear 501 rather
// than a confusing crash.

async function handleCreateCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_MONTHLY || !env.STRIPE_PRICE_ANNUAL) {
    return jsonResponse({ error: 'Billing is not configured yet on the server.' }, 501);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { uid, email, plan, successUrl, cancelUrl } = body || {};
  if (!uid || !successUrl || !cancelUrl) {
    return jsonResponse({ error: 'Missing uid, successUrl, or cancelUrl' }, 400);
  }
  const priceId = plan === 'annual' ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('client_reference_id', uid);
  if (email) params.set('customer_email', email);
  // Propagates onto the Subscription object Stripe creates from this
  // session, not just the Checkout Session itself — see this section's own
  // comment above for why that matters for the webhook handler below.
  params.set('subscription_data[metadata][uid]', uid);
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const session = await stripeRes.json();
  if (!stripeRes.ok) {
    return jsonResponse({ error: (session.error && session.error.message) || 'Stripe error' }, 502);
  }
  return jsonResponse({ url: session.url });
}

// Stripe signs each webhook payload as HMAC-SHA256("<timestamp>.<raw body>",
// the endpoint's signing secret) and sends it as the Stripe-Signature header
// (format: "t=<unix ts>,v1=<hex digest>[,v0=...]"). Verifying this (rather
// than trusting any POST to this URL) is the only thing stopping someone
// from forging a "checkout completed" event and granting themselves
// Premium for free — this MUST run against the untouched raw request text,
// not a JSON.parse-then-reserialize of it, or the digest won't match.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => {
    const [k, v] = kv.split('=');
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${rawBody}`));
  const expectedHex = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return expectedHex === parts.v1;
}

async function putSubscription(env, uid, data) {
  await env.SUBSCRIPTIONS.put(uid, JSON.stringify({ ...data, updatedAt: Date.now() }));
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Billing is not configured yet on the server.' }, 501);
  }
  const rawBody = await request.text();
  const ok = await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response('Invalid signature', { status: 400, headers: corsHeaders() });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400, headers: corsHeaders() });
  }

  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      // Fires once at the end of the initial checkout — before Stripe's own
      // customer.subscription.created event, sometimes by a few seconds, so
      // this is what makes the app show "Premium" right away instead of
      // waiting on that second event to land.
      const uid = obj && (obj.client_reference_id || (obj.metadata && obj.metadata.uid));
      if (uid) {
        await putSubscription(env, uid, {
          status: 'active',
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.subscription,
        });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const uid = obj && obj.metadata && obj.metadata.uid;
      if (uid) {
        const active = obj.status === 'active' || obj.status === 'trialing';
        await putSubscription(env, uid, {
          // Anything other than active/trialing (past_due, unpaid, etc.)
          // stores its real Stripe status rather than being flattened to a
          // generic "inactive" — lets the client show a more specific
          // message later if it ever wants to (e.g. "payment failed") even
          // though today it only checks status === 'active'.
          status: active ? 'active' : obj.status,
          plan: obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price && obj.items.data[0].price.id,
          currentPeriodEnd: obj.current_period_end,
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.id,
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const uid = obj && obj.metadata && obj.metadata.uid;
      if (uid) await putSubscription(env, uid, { status: 'canceled' });
      break;
    }
    // Other event types (invoice.*, payment_intent.*, etc.) aren't
    // subscribed to in the Stripe dashboard yet — Stripe only sends what
    // the webhook endpoint is configured to receive, so nothing else needs
    // a case here until a feature actually needs it.
  }
  return new Response('ok', { status: 200, headers: corsHeaders() });
}

async function handleSubscriptionStatus(request, env) {
  const uid = new URL(request.url).searchParams.get('uid');
  if (!uid) return jsonResponse({ error: 'Missing uid' }, 400);
  const raw = await env.SUBSCRIPTIONS.get(uid);
  return jsonResponse(raw ? JSON.parse(raw) : { status: 'none' });
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

    // Billing routes, checked by path before the GET-only CORS-proxy logic
    // below (which stays the default/fallback for everything else, same as
    // before this section existed) — see this section's own comment above
    // handleCreateCheckoutSession for the full design.
    const pathname = new URL(request.url).pathname;
    if (pathname === '/create-checkout-session' && request.method === 'POST') {
      return handleCreateCheckoutSession(request, env);
    }
    if (pathname === '/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (pathname === '/subscription-status' && request.method === 'GET') {
      return handleSubscriptionStatus(request, env);
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

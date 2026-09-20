/**
 * Worker entry point (Workers + Static Assets model).
 *
 * Replaces the old Cloudflare Pages Functions (`functions/api/*.js`) +
 * `_redirects` setup. Pages is being deprecated in favor of Workers with a
 * `main` script + an `assets` binding — see wrangler.jsonc.
 *
 * Routes handled here:
 *   POST /api/track   — pageview / event analytics (writes to ANALYTICS_KV)
 *   POST /api/submit  — warranty registration (writes to ANALYTICS_KV)
 *   GET  /api/stats   — dashboard data (reads from ANALYTICS_KV, secret-gated)
 *   GET  /dashboard    — rewritten (not redirected) to /dashboard.html
 *   everything else    — served from static assets via env.ASSETS
 *
 * Bindings required (declared in wrangler.jsonc, not the Dashboard):
 *   ANALYTICS_KV  — KV namespace
 *   STATS_SECRET  — secret, set via `wrangler secret put STATS_SECRET`
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const CORS_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  /**
   * @param {Request} request
   * @param {{ ANALYTICS_KV?: KVNamespace, STATS_SECRET?: string, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/track') {
      if (request.method === 'OPTIONS') return handleOptions();
      if (request.method === 'POST') return handleTrack(request, env);
    }

    if (url.pathname === '/api/submit') {
      if (request.method === 'OPTIONS') return handleOptions();
      if (request.method === 'POST') return handleSubmit(request, env);
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    // Rewrite (not redirect) /dashboard → /dashboard.html, same as the old
    // Pages `_redirects` rule: "/dashboard  /dashboard.html  200"
    if (url.pathname === '/dashboard') {
      const assetUrl = new URL('/dashboard.html', url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Everything else: serve from the static assets directory (./public)
    return env.ASSETS.fetch(request);
  },
};

function handleOptions() {
  return new Response(null, { headers: CORS_PREFLIGHT_HEADERS });
}

/**
 * POST /api/track — records a pageview/event and increments KV counters.
 */
async function handleTrack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false }), { status: 400, headers: CORS_HEADERS });
  }

  const { event, lang = 'unknown', ts } = body;
  const day = new Date().toISOString().slice(0, 10); // "2025-03-15"

  if (!env.ANALYTICS_KV) {
    // KV not bound yet — still return 200 so front-end doesn't error
    return new Response(JSON.stringify({ ok: true, warn: 'KV not bound' }), { headers: CORS_HEADERS });
  }

  try {
    // ── 1. Increment daily counter: "stats:YYYY-MM-DD:event" ──────
    const counterKey = `stats:${day}:${event}`;
    const existing = await env.ANALYTICS_KV.get(counterKey);
    const count = existing ? parseInt(existing, 10) + 1 : 1;
    await env.ANALYTICS_KV.put(counterKey, String(count), {
      expirationTtl: 60 * 60 * 24 * 90, // keep 90 days
    });

    // ── 2. Increment per-language counter ─────────────────────────
    const langKey = `stats:${day}:${event}:${lang}`;
    const langExisting = await env.ANALYTICS_KV.get(langKey);
    const langCount = langExisting ? parseInt(langExisting, 10) + 1 : 1;
    await env.ANALYTICS_KV.put(langKey, String(langCount), {
      expirationTtl: 60 * 60 * 24 * 90,
    });

    // ── 3. Append raw event (last 500 per day) ────────────────────
    const rawKey = `raw:${day}`;
    const rawExisting = await env.ANALYTICS_KV.get(rawKey, { type: 'json' });
    const rawEvents = rawExisting || [];
    rawEvents.push({ event, lang, ts: ts || Date.now() });
    // Keep only last 500 entries to stay under 25MB KV value limit
    const trimmed = rawEvents.slice(-500);
    await env.ANALYTICS_KV.put(rawKey, JSON.stringify(trimmed), {
      expirationTtl: 60 * 60 * 24 * 90,
    });
  } catch (err) {
    console.error('KV write error:', err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
}

/**
 * POST /api/submit — validates and stores a warranty registration
 * (email + order suffix + optional marketing consent).
 */
async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), { status: 400, headers: CORS_HEADERS });
  }

  const { email, order_suffix, lang = 'unknown', marketing_consent = false } = body;

  // Basic server-side validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid email' }), { status: 422, headers: CORS_HEADERS });
  }
  if (!order_suffix || !/^\d{4}$/.test(order_suffix)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid order suffix' }), { status: 422, headers: CORS_HEADERS });
  }

  if (!env.ANALYTICS_KV) {
    return new Response(JSON.stringify({ ok: true, warn: 'KV not bound' }), { headers: CORS_HEADERS });
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ts = now.toISOString();

  try {
    // ── 1. Store individual registration ──────────────────────────
    // Key: "lead:YYYY-MM-DD:email" (deduplicates by day+email)
    const leadKey = `lead:${day}:${email.toLowerCase()}`;
    const existing = await env.ANALYTICS_KV.get(leadKey, { type: 'json' });
    if (!existing) {
      await env.ANALYTICS_KV.put(leadKey, JSON.stringify({
        email, order_suffix, lang, ts,
        marketing_consent: Boolean(marketing_consent),
        status: 'registered',
      }), {
        expirationTtl: 60 * 60 * 24 * 180, // keep 6 months
      });
    }

    // ── 2. Add to daily registrations list ────────────────────────
    const listKey = `leads:${day}`;
    const existingList = await env.ANALYTICS_KV.get(listKey, { type: 'json' });
    const list = existingList || [];
    // Avoid duplicate emails in list
    if (!list.find((l) => l.email === email.toLowerCase())) {
      list.push({
        email: email.toLowerCase(), order_suffix, lang, ts,
        marketing_consent: Boolean(marketing_consent),
      });
      await env.ANALYTICS_KV.put(listKey, JSON.stringify(list), {
        expirationTtl: 60 * 60 * 24 * 180,
      });
    }

    // ── 3. Increment total submission counter ─────────────────────
    const cKey = `stats:${day}:submit`;
    const cVal = await env.ANALYTICS_KV.get(cKey);
    await env.ANALYTICS_KV.put(cKey, String(cVal ? parseInt(cVal, 10) + 1 : 1), {
      expirationTtl: 60 * 60 * 24 * 90,
    });
  } catch (err) {
    console.error('Submit KV error:', err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
}

/**
 * GET /api/stats?secret=YOUR_SECRET&days=7 — dashboard data, secret-gated.
 */
async function handleStats(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  const daysParam = parseInt(url.searchParams.get('days') || '7', 10);

  const headers = { 'Content-Type': 'application/json' };

  // Auth check
  if (!env.STATS_SECRET || secret !== env.STATS_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
  }

  if (!env.ANALYTICS_KV) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), { status: 500, headers });
  }

  // Build date range
  const days = [];
  for (let i = daysParam - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const LANGS = ['de', 'fr', 'it', 'es', 'nl', 'pl', 'se', 'en'];

  const results = [];
  for (const day of days) {
    const [pv, sub, leads, ...langVals] = await Promise.all([
      env.ANALYTICS_KV.get(`stats:${day}:pageview`),
      env.ANALYTICS_KV.get(`stats:${day}:submit`),
      env.ANALYTICS_KV.get(`leads:${day}`, { type: 'json' }),
      ...LANGS.map((lang) => env.ANALYTICS_KV.get(`stats:${day}:pageview:${lang}`)),
    ]);

    const pageviews = parseInt(pv || '0', 10);
    const submissions = parseInt(sub || '0', 10);
    const byLang = {};
    LANGS.forEach((lang, i) => { byLang[lang] = parseInt(langVals[i] || '0', 10); });

    results.push({
      date: day,
      pageviews,
      submissions,
      conversion_rate: pageviews > 0 ? ((submissions / pageviews) * 100).toFixed(1) + '%' : '0%',
      by_lang: byLang,
      leads_count: (leads || []).length,
    });
  }

  // Totals
  const totals = results.reduce((acc, r) => ({
    pageviews: acc.pageviews + r.pageviews,
    submissions: acc.submissions + r.submissions,
    leads: acc.leads + r.leads_count,
  }), { pageviews: 0, submissions: 0, leads: 0 });

  return new Response(JSON.stringify({
    period: `Last ${daysParam} days`,
    totals: {
      ...totals,
      conversion_rate: totals.pageviews > 0
        ? ((totals.submissions / totals.pageviews) * 100).toFixed(1) + '%'
        : '0%',
    },
    daily: results,
  }, null, 2), { headers });
}

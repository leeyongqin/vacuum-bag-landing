/**
 * Worker entry point (Workers + Static Assets model).
 *
 * Replaces the old Cloudflare Pages Functions (`functions/api/*.js`) +
 * `_redirects` setup. Pages is being deprecated in favor of Workers with a
 * `main` script + an `assets` binding — see wrangler.jsonc.
 *
 * Routes handled here:
 *   POST /api/track   — pageview / event analytics (writes to ANALYTICS_KV)
 *   POST /api/submit  — warranty registration (writes to ANALYTICS_KV + email)
 *   GET  /api/stats   — dashboard data (reads from ANALYTICS_KV, secret-gated)
 *   GET  /dashboard    — rewritten (not redirected) to /dashboard.html
 *   everything else    — served from static assets via env.ASSETS
 *
 * Bindings required (declared in wrangler.jsonc, not the Dashboard):
 *   ANALYTICS_KV   — KV namespace
 *   STATS_SECRET   — secret, set via `wrangler secret put STATS_SECRET`
 *   RESEND_API_KEY — optional secret; without it confirmation emails are skipped
 *   FROM_EMAIL / BRAND_NAME / ALLOWED_ORIGINS — plain vars in wrangler.jsonc
 *
 * NOTE ON COUNTER ACCURACY: KV has no atomic increment, so every counter here
 * is a best-effort `get → +1 → put`. Under concurrent traffic counts can drift
 * low. That is acceptable for marketing analytics; use Durable Objects or
 * Analytics Engine if exact numbers ever become a requirement.
 */

import { buildEmail } from './emails.js';

const DEFAULT_ALLOWED_ORIGINS = 'https://amazon-feedback.aromelivii.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEV_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const SUBMIT_RATE_LIMIT = 5;            // max submissions per IP …
const SUBMIT_RATE_WINDOW_S = 60 * 60;   // … per hour

const DAY = 60 * 60 * 24;
const TTL_STATS = DAY * 90;             // pageview/event counters
const TTL_LEADS = DAY * 180;            // registration records
const TTL_LONG = DAY * 365;             // dedupe markers / lifetime totals

export default {
  /**
   * @param {Request} request
   * @param {{ ANALYTICS_KV?: KVNamespace, STATS_SECRET?: string, RESEND_API_KEY?: string,
   *           FROM_EMAIL?: string, BRAND_NAME?: string, ALLOWED_ORIGINS?: string,
   *           ASSETS: Fetcher }} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Reject cross-origin API calls from unknown sites. CORS headers alone
    // only stop a browser from *reading* the response — a hostile page could
    // still write junk into KV — so block before any handler runs.
    if (url.pathname.startsWith('/api/') && !originAllowed(request, env)) {
      return json({ ok: false, error: 'Origin not allowed' }, 403, request, env);
    }

    if (url.pathname === '/api/track') {
      if (request.method === 'OPTIONS') return handleOptions(request, env);
      if (request.method === 'POST') return handleTrack(request, env);
    }

    if (url.pathname === '/api/submit') {
      if (request.method === 'OPTIONS') return handleOptions(request, env);
      if (request.method === 'POST') return handleSubmit(request, env, ctx);
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

// ─────────────────────────────────────────────────────────────────────
// CORS helpers
// ─────────────────────────────────────────────────────────────────────

function allowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function safeHostname(origin) {
  try { return new URL(origin).hostname; } catch { return ''; }
}

function isTrustedOrigin(origin, env) {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  return DEV_ORIGIN_HOSTS.has(safeHostname(origin));
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  // No Origin header: same-origin navigation or a non-browser client (curl).
  if (!origin) return true;
  return isTrustedOrigin(origin, env);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allow = isTrustedOrigin(origin, env) ? origin : allowedOrigins(env)[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request, env) });
}

function handleOptions(request, env) {
  const origin = request.headers.get('Origin');
  const allow = isTrustedOrigin(origin, env) ? origin : allowedOrigins(env)[0];
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Best-effort increment. KV has no atomic add — see the file header note. */
async function bumpCounter(env, key, ttl) {
  const cur = await env.ANALYTICS_KV.get(key);
  const next = cur ? parseInt(cur, 10) + 1 : 1;
  await env.ANALYTICS_KV.put(key, String(next), { expirationTtl: ttl });
  return next;
}

/** Returns true when the caller already hit `limit` inside the window. */
async function isRateLimited(env, key, limit, ttl) {
  const cur = await env.ANALYTICS_KV.get(key);
  const n = cur ? parseInt(cur, 10) : 0;
  if (n >= limit) return true;
  await env.ANALYTICS_KV.put(key, String(n + 1), { expirationTtl: ttl });
  return false;
}

/**
 * POST /api/track — records a pageview/event and increments KV counters.
 */
async function handleTrack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400, request, env);
  }

  const { event, lang = 'unknown', ts } = body;
  const day = new Date().toISOString().slice(0, 10); // "2025-03-15"

  if (!env.ANALYTICS_KV) {
    // KV not bound yet — still return 200 so front-end doesn't error
    return json({ ok: true, warn: 'KV not bound' }, 200, request, env);
  }

  try {
    // ── 1. Increment daily counter: "stats:YYYY-MM-DD:event" ──────
    await bumpCounter(env, `stats:${day}:${event}`, TTL_STATS);

    // ── 2. Increment per-language counter ─────────────────────────
    await bumpCounter(env, `stats:${day}:${event}:${lang}`, TTL_STATS);

    // ── 3. Append raw event (last 500 per day) ────────────────────
    const rawKey = `raw:${day}`;
    const rawExisting = await env.ANALYTICS_KV.get(rawKey, { type: 'json' });
    const rawEvents = rawExisting || [];
    rawEvents.push({ event, lang, ts: ts || Date.now() });
    // Keep only last 500 entries to stay under 25MB KV value limit
    const trimmed = rawEvents.slice(-500);
    await env.ANALYTICS_KV.put(rawKey, JSON.stringify(trimmed), { expirationTtl: TTL_STATS });
  } catch (err) {
    console.error('KV write error:', err);
  }

  return json({ ok: true }, 200, request, env);
}

/**
 * POST /api/submit — validates and stores a warranty registration
 * (email + order suffix + optional marketing consent), then sends the
 * confirmation email the landing page promises.
 */
async function handleSubmit(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400, request, env);
  }

  const { email, order_suffix, lang = 'unknown', marketing_consent = false } = body;

  // Basic server-side validation
  if (!email || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'Invalid email' }, 422, request, env);
  }
  if (!order_suffix || !/^\d{4}$/.test(order_suffix)) {
    return json({ ok: false, error: 'Invalid order suffix' }, 422, request, env);
  }

  if (!env.ANALYTICS_KV) {
    return json({ ok: true, warn: 'KV not bound' }, 200, request, env);
  }

  // Throttle abuse: a real buyer registers once, so 5/hour/IP is generous.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hourBucket = Math.floor(Date.now() / 3600000);
  try {
    if (await isRateLimited(env, `rl:submit:${ip}:${hourBucket}`, SUBMIT_RATE_LIMIT, SUBMIT_RATE_WINDOW_S)) {
      return json({ ok: false, error: 'Too many requests' }, 429, request, env);
    }
  } catch (err) {
    console.error('Rate limit error:', err); // fail open — never block a real buyer
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ts = now.toISOString();
  const normalizedEmail = email.toLowerCase();

  try {
    // ── 1. Store individual registration ──────────────────────────
    // Key: "lead:YYYY-MM-DD:email" (deduplicates by day+email)
    const leadKey = `lead:${day}:${normalizedEmail}`;
    const existing = await env.ANALYTICS_KV.get(leadKey, { type: 'json' });
    if (!existing) {
      await env.ANALYTICS_KV.put(leadKey, JSON.stringify({
        email, order_suffix, lang, ts,
        marketing_consent: Boolean(marketing_consent),
        status: 'registered',
      }), { expirationTtl: TTL_LEADS });
    }

    // ── 2. Add to daily registrations list ────────────────────────
    const listKey = `leads:${day}`;
    const existingList = await env.ANALYTICS_KV.get(listKey, { type: 'json' });
    const list = existingList || [];
    // Avoid duplicate emails in list
    if (!list.find((l) => l.email === normalizedEmail)) {
      list.push({
        email: normalizedEmail, order_suffix, lang, ts,
        marketing_consent: Boolean(marketing_consent),
      });
      await env.ANALYTICS_KV.put(listKey, JSON.stringify(list), { expirationTtl: TTL_LEADS });
    }

    // ── 3. Cross-day dedupe marker ────────────────────────────────
    // The daily keys above can't tell "returning buyer" from "new lead", so a
    // lifetime marker keyed by the email hash decides what counts as a lead.
    const seenKey = `email:${await sha256Hex(normalizedEmail)}`;
    const seen = await env.ANALYTICS_KV.get(seenKey);
    const isNewLead = !seen;
    if (isNewLead) await env.ANALYTICS_KV.put(seenKey, ts, { expirationTtl: TTL_LONG });

    // ── 4. Increment counters ─────────────────────────────────────
    await bumpCounter(env, `stats:${day}:submit`, TTL_STATS);
    if (isNewLead) await bumpCounter(env, 'leads:total', TTL_LONG);
  } catch (err) {
    console.error('Submit KV error:', err);
  }

  // ── 5. Confirmation email ───────────────────────────────────────
  // Fire-and-forget: a delivery failure must never turn a successful
  // registration into an error for the buyer.
  const mail = sendConfirmationEmail(env, {
    email, orderSuffix: order_suffix, lang,
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(mail);
  else await mail;

  return json({ ok: true }, 200, request, env);
}

/**
 * Sends the localized warranty confirmation email.
 *
 * Provider: Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Swapping providers means rewriting only this function.
 * When RESEND_API_KEY / FROM_EMAIL are missing the send is skipped and logged
 * so the deployment keeps working before email is configured.
 */
async function sendConfirmationEmail(env, { email, orderSuffix, lang }) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.FROM_EMAIL;
  const brandName = env.BRAND_NAME || 'AromeLivii';

  if (!apiKey || !from) {
    console.warn('Email not configured (RESEND_API_KEY / FROM_EMAIL) — confirmation email skipped');
    return { skipped: true };
  }

  const { subject, html, text } = buildEmail(lang, {
    brandName,
    supportEmail: from,
    orderSuffix,
  });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${brandName} <${from}>`,
        to: [email],
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      console.error('Confirmation email failed:', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('Confirmation email error:', err);
    return { ok: false };
  }
}

/**
 * Reads the dashboard secret from the preferred header, falling back to the
 * legacy `?secret=` query parameter (kept so old bookmarks keep working, but
 * deprecated — query strings end up in access logs).
 */
function readSecret(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  const header = request.headers.get('X-Stats-Secret');
  if (header) return header.trim();

  return new URL(request.url).searchParams.get('secret');
}

/**
 * GET /api/stats?days=14 — dashboard data, secret-gated.
 * Secret via `X-Stats-Secret` header (preferred) or `Authorization: Bearer`.
 */
async function handleStats(request, env) {
  const url = new URL(request.url);
  const secret = readSecret(request);
  const requested = parseInt(url.searchParams.get('days') || '14', 10);
  const daysParam = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 90) : 14;

  const headers = { 'Content-Type': 'application/json', 'Vary': 'Origin' };

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

  const LANGS = ['de', 'fr', 'it', 'es', 'nl', 'en'];

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

  // Prefer the lifetime dedupe counter; summing daily lists double-counts the
  // same email whenever it appears on more than one day.
  const lifetimeLeads = await env.ANALYTICS_KV.get('leads:total');
  if (lifetimeLeads !== null && lifetimeLeads !== undefined) {
    totals.leads = parseInt(lifetimeLeads, 10) || 0;
  }

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

/**
 * POST /api/track
 * Receives analytics events (pageview, submit) and stores them in KV.
 *
 * KV bindings needed (set in Cloudflare Pages → Settings → Functions → KV):
 *   ANALYTICS_KV  — stores event counts and raw event logs
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false }), { status: 400, headers });
  }

  const { event, lang = 'unknown', ts } = body;
  const day = new Date().toISOString().slice(0, 10); // "2025-03-15"

  if (!env.ANALYTICS_KV) {
    // KV not bound yet — still return 200 so front-end doesn't error
    return new Response(JSON.stringify({ ok: true, warn: 'KV not bound' }), { headers });
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

  return new Response(JSON.stringify({ ok: true }), { headers });
}

// Handle preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

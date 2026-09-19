/**
 * POST /api/submit
 * Saves form submissions (email + order suffix + lang) to KV.
 *
 * KV bindings needed:
 *   ANALYTICS_KV  — shared with track.js
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { email, order_suffix, lang = 'unknown' } = body;

  // Basic server-side validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid email' }), { status: 422, headers });
  }
  if (!order_suffix || !/^\d{4}$/.test(order_suffix)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid order suffix' }), { status: 422, headers });
  }

  if (!env.ANALYTICS_KV) {
    return new Response(JSON.stringify({ ok: true, warn: 'KV not bound' }), { headers });
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ts = now.toISOString();

  try {
    // ── 1. Store individual lead ──────────────────────────────────
    // Key: "lead:YYYY-MM-DD:email" (deduplicates by day+email)
    const leadKey = `lead:${day}:${email.toLowerCase()}`;
    const existing = await env.ANALYTICS_KV.get(leadKey, { type: 'json' });
    if (!existing) {
      await env.ANALYTICS_KV.put(leadKey, JSON.stringify({
        email, order_suffix, lang, ts, status: 'pending'
      }), {
        expirationTtl: 60 * 60 * 24 * 180, // keep 6 months
      });
    }

    // ── 2. Add to daily leads list ────────────────────────────────
    const listKey = `leads:${day}`;
    const existing_list = await env.ANALYTICS_KV.get(listKey, { type: 'json' });
    const list = existing_list || [];
    // Avoid duplicate emails in list
    if (!list.find(l => l.email === email.toLowerCase())) {
      list.push({ email: email.toLowerCase(), order_suffix, lang, ts });
      await env.ANALYTICS_KV.put(listKey, JSON.stringify(list), {
        expirationTtl: 60 * 60 * 24 * 180,
      });
    }

    // ── 3. Increment total submission counter ─────────────────────
    const cKey = `stats:${day}:submit`;
    const cVal = await env.ANALYTICS_KV.get(cKey);
    await env.ANALYTICS_KV.put(cKey, String(cVal ? parseInt(cVal) + 1 : 1), {
      expirationTtl: 60 * 60 * 24 * 90,
    });

  } catch (err) {
    console.error('Submit KV error:', err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

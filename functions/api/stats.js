/**
 * GET /api/stats?secret=YOUR_SECRET&days=7
 * Returns analytics dashboard data from KV.
 *
 * Protect with a secret query param — set STATS_SECRET in
 * Cloudflare Pages → Settings → Environment Variables.
 */

export async function onRequestGet(context) {
  const { request, env } = context;
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

  const results = [];
  for (const day of days) {
    const [pv, sub, pvDE, pvFR, pvIT, pvES, pvEN, leads] = await Promise.all([
      env.ANALYTICS_KV.get(`stats:${day}:pageview`),
      env.ANALYTICS_KV.get(`stats:${day}:submit`),
      env.ANALYTICS_KV.get(`stats:${day}:pageview:de`),
      env.ANALYTICS_KV.get(`stats:${day}:pageview:fr`),
      env.ANALYTICS_KV.get(`stats:${day}:pageview:it`),
      env.ANALYTICS_KV.get(`stats:${day}:pageview:es`),
      env.ANALYTICS_KV.get(`stats:${day}:pageview:en`),
      env.ANALYTICS_KV.get(`leads:${day}`, { type: 'json' }),
    ]);

    const pageviews = parseInt(pv || '0', 10);
    const submissions = parseInt(sub || '0', 10);

    results.push({
      date: day,
      pageviews,
      submissions,
      conversion_rate: pageviews > 0 ? ((submissions / pageviews) * 100).toFixed(1) + '%' : '0%',
      by_lang: {
        de: parseInt(pvDE || '0', 10),
        fr: parseInt(pvFR || '0', 10),
        it: parseInt(pvIT || '0', 10),
        es: parseInt(pvES || '0', 10),
        en: parseInt(pvEN || '0', 10),
      },
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

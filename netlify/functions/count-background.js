// netlify/functions/count-background.js
// Endpoint HTTP wywoływany z Plexa (ticketing.html) — zlicza bilety dla podanych eventów.
// Wspólna logika w ./utils/counter.js.

const { getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase } = require('./utils/counter');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let events;
  try {
    const body = JSON.parse(event.body || '{}');
    events = body.events;
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Nieprawidłowy JSON' }) };
  }
  if (!events?.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Brak eventów' }) };
  }

  const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSession()]);
  const results = [];

  for (const ev of events) {
    try {
      const [ebResult, tmResult] = await Promise.all([
        fetchEbilet(ebToken, ev.name, ev.date),
        fetchTm(tmSession, ev.name, ev.date, ev.onSale),
      ]);
      await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
      results.push({ id: ev.id, tm: tmResult.tm, eb: ebResult.eb, ok: true });
    } catch(err) {
      results.push({ id: ev.id, error: err.message, ok: false });
    }
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ results }),
  };
};

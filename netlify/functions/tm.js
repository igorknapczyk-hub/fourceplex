/**
 * Netlify Function — Ticketmaster TM1 Reports Sales Data
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function getSessionId() {
  const url = `${process.env.TM_URL}/reports/login?apikey=${process.env.TM_API_KEY}`;
  const password = Buffer.from(process.env.TM_PASSWORD).toString('base64');
  const body = new URLSearchParams({
    username: process.env.TM_USERNAME,
    password,
    market:   process.env.TM_MARKET,
  });
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':       'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TM login error ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data.sessionId) throw new Error('TM nie zwróciło sessionId');
  return data.sessionId;
}

async function getEventSales(sessionId) {
  const url = `${process.env.TM_URL}/reports/eventSales?apikey=${process.env.TM_API_KEY}`;
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} 00:00:00`;

  // Podziel 365 dni na okresy po 31 dni
  const periods = [];
  const now = new Date();
  for (let i = 0; i < 365; i += 31) {
    const to = new Date(now);
    to.setDate(to.getDate() - i);
    const from = new Date(now);
    from.setDate(from.getDate() - Math.min(i + 31, 365));
    periods.push({ from: fmt(from), to: fmt(to) });
  }

  // Wyślij wszystkie zapytania równolegle
  const results = await Promise.all(periods.map(async period => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'sessionId':    sessionId,
        'marketCode':   process.env.TM_MARKET,
      },
      body: JSON.stringify({ from: period.from, to: period.to }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.transactions ?? data.items ?? []);
  }));

  // Połącz wszystkie wyniki w jedną tablicę
  return results.flat();
}

function filterAndCount(transactions, eventName, eventDate) {
  const target = new Date(eventDate);
  // Filtruj po nazwie (case-insensitive, fragment) i dacie eventu
  const filtered = transactions.filter(t => {
    if (!t.eventTitle) return false;
    const nameMatch = t.eventTitle.toLowerCase().includes(eventName.toLowerCase());
    if (!nameMatch) return false;
    if (!t.eventDate) return true;
    // eventDate z TM w formacie DD/MM/YY
    const parts = t.eventDate.split('/');
    if (parts.length !== 3) return true;
    const d = new Date(`20${parts[2]}-${parts[1]}-${parts[0]}`);
    return d.getFullYear() === target.getFullYear()
        && d.getMonth()    === target.getMonth()
        && d.getDate()     === target.getDate();
  });
  // Zlicz: Sold + Sold reserved, odejmij Cancelled Sale
  let sold = 0;
  filtered.forEach(t => {
    const s = (t.status || '').toLowerCase();
    if (s === 'sold' || s === 'sold reserved') sold++;
    if (s === 'cancelled sale') sold--;
  });
  return { tm: Math.max(0, sold), transactions: filtered.length };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Tylko POST' }) };
  }
  let eventName, eventDate;
  try {
    const body = JSON.parse(event.body || '{}');
    eventName = (body.eventName || '').trim();
    eventDate = (body.eventDate || '').trim();
  } catch {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Nieprawidłowy JSON' }) };
  }
  if (!eventName || !eventDate) {
    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Wymagane: eventName, eventDate (YYYY-MM-DD)' }) };
  }
  try {
    const sessionId   = await getSessionId();
    const transactions = await getEventSales(sessionId);
    if (!transactions.length) {
      return { statusCode: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Brak transakcji w TM dla tego okresu' }) };
    }
    const { tm, transactions: count } = filterAndCount(transactions, eventName, eventDate);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tm, transactionsTotal: transactions.length, transactionsMatched: count }),
    };
  } catch (err) {
    console.error('[tm]', err);
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }) };
  }
};

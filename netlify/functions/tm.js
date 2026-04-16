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

async function getEventSales(sessionId, eventDate, onSaleDate) {
  const url = `${process.env.TM_URL}/reports/eventSales?apikey=${process.env.TM_API_KEY}`;
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} 00:00:00`;

  // Startuj od eventDate + 7 dni, idź wstecz do onSaleDate (lub 365 dni)
  const anchor = new Date(eventDate);
  anchor.setDate(anchor.getDate() + 7);

  const totalDays = onSaleDate
    ? Math.ceil((anchor - new Date(onSaleDate)) / (1000 * 60 * 60 * 24))
    : 365;

  const periods = [];
  for (let i = 0; i < totalDays; i += 31) {
    const to = new Date(anchor);
    to.setDate(anchor.getDate() - i);
    const from = new Date(anchor);
    from.setDate(anchor.getDate() - Math.min(i + 31, totalDays));
    periods.push({ from: fmt(from), to: fmt(to) });
  }

  // Szeregowo — jeden request na raz
  const allTransactions = [];
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
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
    if (!res.ok) continue;
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.transactions ?? data.items ?? []);
    allTransactions.push(...rows);
  }
  return allTransactions;
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
  let eventName, eventDate, onSaleDate;
  try {
    const body = JSON.parse(event.body || '{}');
    eventName  = (body.eventName  || '').trim();
    eventDate  = (body.eventDate  || '').trim();
    onSaleDate = (body.onSaleDate || '').trim() || null;
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
    const transactions = await getEventSales(sessionId, eventDate, onSaleDate);
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

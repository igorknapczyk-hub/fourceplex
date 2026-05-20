async function getSessionId() {
  const url = `${process.env.TM_URL}/reports/login?apikey=${process.env.TM_API_KEY}`;
  const password = Buffer.from(process.env.TM_PASSWORD).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ username: process.env.TM_USERNAME, password, market: process.env.TM_MARKET }).toString(),
  });
  if (!res.ok) throw new Error(`TM login error ${res.status}`);
  const data = await res.json();
  if (!data.sessionId) throw new Error('TM nie zwróciło sessionId');
  return data.sessionId;
}

async function getEventSales(sessionId, eventDate, onSaleDate) {
  const url = `${process.env.TM_URL}/reports/eventSales?apikey=${process.env.TM_API_KEY}`;
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
  const anchor = new Date(eventDate);
  anchor.setDate(anchor.getDate() + 7);
  const totalDays = onSaleDate ? Math.ceil((anchor - new Date(onSaleDate)) / 86400000) : 365;
  const periods = [];
  for (let i = 0; i < totalDays; i += 31) {
    const to = new Date(anchor); to.setDate(anchor.getDate() - i);
    const from = new Date(anchor); from.setDate(anchor.getDate() - Math.min(i + 31, totalDays));
    periods.push({ from: fmt(from), to: fmt(to) });
  }
  const allTransactions = [];
  for (const period of periods) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', sessionId, marketCode: process.env.TM_MARKET },
      body: JSON.stringify({ from: period.from, to: period.to }),
    });
    if (!res.ok) continue;
    const data = await res.json();
    allTransactions.push(...(Array.isArray(data) ? data : (data.transactions ?? [])));
  }
  return allTransactions;
}

function filterAndCount(transactions, eventName, eventDate) {
  const target = new Date(eventDate);
  const filtered = transactions.filter(t => {
    if (!t.eventTitle) return false;
    if (!t.eventTitle.toLowerCase().includes(eventName.toLowerCase())) return false;
    if (!t.eventDate) return true;
    const parts = t.eventDate.split('/');
    if (parts.length !== 3) return true;
    const d = new Date(`20${parts[2]}-${parts[1]}-${parts[0]}`);
    return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate();
  });
  let sold = 0;
  filtered.forEach(t => {
    const s = (t.status || '').toLowerCase();
    if (s === 'sold' || s === 'sold reserved') sold++;
    if (s === 'cancelled sale') sold--;
  });
  return { tm: Math.max(0, sold), transactions: filtered.length };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Tylko POST' });
  const { eventName, eventDate, onSaleDate } = req.body || {};
  if (!eventName || !eventDate) return res.status(400).json({ error: 'Wymagane: eventName, eventDate' });
  try {
    const sessionId = await getSessionId();
    const transactions = await getEventSales(sessionId, eventDate, onSaleDate || null);
    if (!transactions.length) return res.status(404).json({ error: 'Brak transakcji w TM' });
    const { tm, transactions: count } = filterAndCount(transactions, eventName, eventDate);
    return res.status(200).json({ tm, transactionsTotal: transactions.length, transactionsMatched: count });
  } catch (err) {
    console.error('[tm]', err);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 300 };

// netlify/functions/utils/counter.js
// Wspólna logika liczenia biletów (TM + eBilet + zapis do Firebase).
// Importowana przez count-background.js i count-scheduled.js.

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function normalize(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

let db;
function getDb() {
  if (db) return db;
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  db = getFirestore();
  return db;
}

async function getEbiletToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.EBILET_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     process.env.EBILET_CLIENT_ID,
        client_secret: process.env.EBILET_CLIENT_SECRET,
        scope:         process.env.EBILET_SCOPE,
      }).toString(),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('eBilet token error');
  return data.access_token;
}

async function fetchEbilet(token, eventName, eventDate) {
  const res = await fetch(process.env.EBILET_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      query: `query($n:String){sales(filter:{event_name:{contains:$n}}orderBy:null){items{event_name event_time sales_ticket_count free_seats_without_reservations all_seats sales_gross}}}`,
      variables: { n: eventName },
    }),
  });
  const data = await res.json();
  const items = data?.data?.sales?.items ?? [];
  const target = new Date(eventDate);
  const matches = items.filter(item => {
    if (!item.event_time) return false;
    if (!normalize(item.event_name).includes(normalize(eventName))) return false;
    const d = new Date(item.event_time);
    return d.getFullYear() === target.getFullYear()
        && d.getMonth()    === target.getMonth()
        && d.getDate()     === target.getDate();
  });
  const paid = matches.filter(m => (m.sales_gross ?? 0) > 0);
  return {
    eb:      paid.reduce((s, m) => s + (m.sales_ticket_count ?? 0), 0),
    remains: matches.reduce((s, m) => s + (m.free_seats_without_reservations ?? 0), 0),
    cap:     matches.reduce((s, m) => s + (m.all_seats ?? 0), 0),
  };
}

async function getTmSession() {
  const res = await fetch(
    `${process.env.TM_URL}/reports/login?apikey=${process.env.TM_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        username: process.env.TM_USERNAME,
        password: Buffer.from(process.env.TM_PASSWORD).toString('base64'),
        market:   process.env.TM_MARKET,
      }).toString(),
    }
  );
  const data = await res.json();
  if (!data.sessionId) throw new Error('TM login error');
  return data.sessionId;
}

async function fetchTm(sessionId, eventName, eventDate, onSaleDate) {
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} 00:00:00`;
  const anchor = new Date(eventDate); anchor.setDate(anchor.getDate() + 7);
  const start  = onSaleDate ? new Date(onSaleDate) : new Date(anchor);
  if (!onSaleDate) start.setDate(start.getDate() - 365);
  const periods = [];
  let cursor = new Date(anchor);
  while (cursor > start) {
    const to   = new Date(cursor);
    const from = new Date(cursor); from.setDate(from.getDate() - 31);
    if (from < start) from.setTime(start.getTime());
    periods.push({ from: fmt(from), to: fmt(to) });
    cursor.setDate(cursor.getDate() - 31);
  }
  const allTrx = [];
  for (const period of periods) {
    const res = await fetch(
      `${process.env.TM_URL}/reports/eventSales?apikey=${process.env.TM_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          'sessionId':    sessionId,
          'marketCode':   process.env.TM_MARKET,
        },
        body: JSON.stringify({ from: period.from, to: period.to }),
      }
    );
    if (!res.ok) continue;
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.transactions ?? []);
    allTrx.push(...rows);
  }
  const target = new Date(eventDate);
  const filtered = allTrx.filter(t => {
    if (!normalize(t.eventTitle).includes(normalize(eventName))) return false;
    if (!t.eventDate) return true;
    const p = t.eventDate.split('/');
    if (p.length !== 3) return true;
    const d = new Date(`20${p[2]}-${p[1]}-${p[0]}`);
    return d.getFullYear() === target.getFullYear()
        && d.getMonth()    === target.getMonth()
        && d.getDate()     === target.getDate();
  });
  let sold = 0;
  filtered.forEach(t => {
    const s = (t.status||'').toLowerCase();
    if (s === 'sold' || s === 'sold reserved') sold++;
    if (s === 'cancelled sale') sold--;
  });
  return { tm: Math.max(0, sold) };
}

async function saveToFirebase(evId, ev, tm, eb, remains, ebCap) {
  const db = getDb();
  const tot = tm + eb + (ev.other || 0);
  const pct = ev.cap ? Math.round(tot / ev.cap * 100) : 0;
  const now = Date.now();
  await db.collection('ticketing_events').doc(evId).update({
    tm, eb, remains, ebCap: ebCap || 0, updatedAt: now, updatedBy: 'auto', lastCountedAt: now,
  });
  const d = new Date();
  const dateStr = `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()}`;
  const sid = `snap_${evId}_${dateStr.replace(/\./g,'_')}`;
  await db.collection('ticketing_snapshots').doc(sid).set({
    eventId: evId, eventName: ev.name, date: dateStr,
    tm, eb, other: ev.other||0, total: tot,
    remains, wraps: ev.wraps||0, pct,
    createdBy: 'auto', createdAt: now,
  });
}

module.exports = { getDb, getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase };

// netlify/functions/count-scheduled.js
// Funkcja cron — wywoływana codziennie o 8:00 przez Netlify Scheduled Functions.
// Pobiera aktywne eventy z Firebase i odpala count-background przez HTTP.

const { getDb } = require('./utils/counter');

exports.handler = async function() {
  console.log('[count-scheduled] Start:', new Date().toISOString());
  try {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0,0,0,0);
    const snap = await db.collection('ticketing_events').get();
    const evs = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (new Date(d.date) >= cutoff) {
        evs.push({ id: doc.id, ...d });
      }
    });
    console.log('[count-scheduled] Aktywne eventy:', evs.length);
    if (!evs.length) return { statusCode: 200, body: 'Brak aktywnych eventów' };
    const baseUrl = 'https://fource-plex-3103.netlify.app';
    const res = await fetch(`${baseUrl}/.netlify/functions/count-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: evs.map(ev => ({
        id: ev.id, name: ev.name, date: ev.date,
        onSale: ev.onSale, other: ev.other||0,
        wraps: ev.wraps||0, cap: ev.cap||0,
      })) }),
    });
    console.log('[count-scheduled] Background job odpalone, status:', res.status);
    return { statusCode: 200, body: 'OK' };
  } catch(err) {
    console.error('[count-scheduled] Błąd:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

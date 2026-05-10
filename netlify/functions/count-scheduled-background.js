// netlify/functions/count-scheduled-background.js
// Scheduled background function — odpala się codziennie o 7:30 UTC (9:30 CEST).
// Jako background function ma 15 minut timeoutu i nie wymaga HTTP fetch do siebie.

const { getDb, getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase } = require('./utils/counter');

exports.handler = async function() {
  console.log('[count-scheduled] Start:', new Date().toISOString());
  try {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);

    const snap = await db.collection('ticketing_events').get();
    const evs = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (new Date(d.date) >= cutoff) {
        evs.push({ id: doc.id, ...d });
      }
    });

    console.log('[count-scheduled] Aktywne eventy:', evs.length);
    if (!evs.length) {
      console.log('[count-scheduled] Brak aktywnych eventów, kończę.');
      return { statusCode: 200, body: 'Brak aktywnych eventów' };
    }

    const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSession()]);

    for (const ev of evs) {
      try {
        const [ebResult, tmResult] = await Promise.all([
          fetchEbilet(ebToken, ev.name, ev.date, ev.altName || ''),
          fetchTm(tmSession, ev.name, ev.date, ev.onSale, ev.altName || ''),
        ]);
        await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
        console.log(`[count-scheduled] OK: ${ev.name} — TM:${tmResult.tm} EB:${ebResult.eb}`);
      } catch (err) {
        console.error(`[count-scheduled] Błąd dla ${ev.name}:`, err.message);
      }
    }

    console.log('[count-scheduled] Zakończono.');
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('[count-scheduled] Błąd główny:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

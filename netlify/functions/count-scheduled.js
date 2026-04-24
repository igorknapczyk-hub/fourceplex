// netlify/functions/count-scheduled.js
// Funkcja cron — wywoływana codziennie o 10:00 przez Netlify Scheduled Functions.
// Sama pobiera aktywne eventy z Firebase i przelicza sprzedaż dla wszystkich.
// Wspólna logika w ./utils/counter.js.

const { getDb, getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase } = require('./utils/counter');

exports.handler = async function() {
  console.log('[count-scheduled] Start:', new Date().toISOString());

  // 1. Pobierz eventy z Firebase
  const db = getDb();
  const snap = await db.collection('ticketing_events').get();
  const allEvents = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 2. Filtruj aktywne — date >= dziś - 2 dni
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  cutoff.setHours(0, 0, 0, 0);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"

  const events = allEvents.filter(ev => ev.date && ev.date >= cutoffStr);
  console.log(`[count-scheduled] Aktywne eventy: ${events.length} (cutoff: ${cutoffStr})`);

  if (!events.length) {
    console.log('[count-scheduled] Brak aktywnych eventów — kończymy.');
    return { statusCode: 200, body: 'Brak aktywnych eventów.' };
  }

  // 3. Zaloguj się do TM i eBilet
  const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSession()]);

  // 4. Przelicz każdy event
  const results = [];
  for (const ev of events) {
    try {
      const [ebResult, tmResult] = await Promise.all([
        fetchEbilet(ebToken, ev.name, ev.date),
        fetchTm(tmSession, ev.name, ev.date, ev.onSale),
      ]);
      await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains);
      console.log(`[count-scheduled] OK: ${ev.name} — TM: ${tmResult.tm}, eBilet: ${ebResult.eb}`);
      results.push({ id: ev.id, name: ev.name, tm: tmResult.tm, eb: ebResult.eb, ok: true });
    } catch(err) {
      console.error(`[count-scheduled] BŁĄD: ${ev.name} —`, err.message);
      results.push({ id: ev.id, name: ev.name, error: err.message, ok: false });
    }
  }

  const ok   = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`[count-scheduled] Koniec: ${ok} OK, ${fail} błędów.`);

  return {
    statusCode: 200,
    body: JSON.stringify({ ok, fail, results }),
  };
};

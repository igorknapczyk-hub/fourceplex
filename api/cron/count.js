import { getDb, getEbiletToken, fetchEbilet, getTmSessionSafe, fetchTm, saveToFirebase } from '../lib/counter.js';

export default async function handler(req, res) {
  console.log('[count-cron] Start:', new Date().toISOString());
  try {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);
    const snap = await db.collection('ticketing_events').get();
    const evs = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (new Date(d.date) >= cutoff) evs.push({ id: doc.id, ...d });
    });
    console.log('[count-cron] Aktywne eventy:', evs.length);
    if (!evs.length) {
      console.log('[count-cron] Brak aktywnych eventów.');
      return res.status(200).json({ ok: true, processed: 0 });
    }
    const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSessionSafe()]);
    if (!tmSession) console.warn('[count-cron] TM niedostępny — zapis tylko eBilet (TM z fallbacku)');
    const BATCH_SIZE = 6;
    let ok = 0, errors = 0;
    async function processEvent(ev) {
      try {
        const [ebResult, tmResult] = await Promise.all([
          fetchEbilet(ebToken, ev.name, ev.date, ev.altName || '', ev.eventTime || ''),
          tmSession ? fetchTm(tmSession, ev.name, ev.date, ev.onSale, ev.altName || '', ev.eventTime || '') : Promise.resolve({ tm: null }),
        ]);
        await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
        console.log(`[count-cron] OK: ${ev.name} — TM:${tmResult.tm ?? 'fallback'} EB:${ebResult.eb}`);
        ok++;
      } catch (err) {
        console.error(`[count-cron] Błąd dla ${ev.name}:`, err.message);
        errors++;
      }
    }
    for (let i = 0; i < evs.length; i += BATCH_SIZE) {
      const batch = evs.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(processEvent));
    }
    if (ok < evs.length) {
      console.warn(`[count-cron] NIEPEŁNY PRZEBIEG: ${ok}/${evs.length} policzonych, ${errors} błędów — reszta doliczy się o 9:50 (count-retry)`);
    }
    return res.status(200).json({ ok: true, processed: ok, total: evs.length, errors, tmAvailable: !!tmSession });
  } catch (err) {
    console.error('[count-cron] Błąd główny:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 300 };

import { getDb, getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase } from '../lib/counter.js';

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
    const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSession()]);
    let ok = 0, errors = 0;
    for (const ev of evs) {
      try {
        const [ebResult, tmResult] = await Promise.all([
          fetchEbilet(ebToken, ev.name, ev.date, ev.altName || ''),
          fetchTm(tmSession, ev.name, ev.date, ev.onSale, ev.altName || ''),
        ]);
        await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
        console.log(`[count-cron] OK: ${ev.name} — TM:${tmResult.tm} EB:${ebResult.eb}`);
        ok++;
      } catch (err) {
        console.error(`[count-cron] Błąd dla ${ev.name}:`, err.message);
        errors++;
      }
    }
    return res.status(200).json({ ok: true, processed: ok, errors });
  } catch (err) {
    console.error('[count-cron] Błąd główny:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 300 };

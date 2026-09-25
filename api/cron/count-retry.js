import { getDb, getEbiletToken, fetchEbilet, getTmSessionSafe, fetchTm, saveToFirebase } from '../lib/counter.js';

function isTodayWarsaw(ts) {
  if (!ts) return false;
  const fmt = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  return fmt(ts) === fmt(Date.now());
}

export default async function handler(req, res) {
  console.log('[count-retry] Start:', new Date().toISOString());
  try {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);
    const snap = await db.collection('ticketing_events').get();
    const evs = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (new Date(d.date) >= cutoff && !isTodayWarsaw(d.lastCountedAt)) evs.push({ id: doc.id, ...d });
    });
    console.log('[count-retry] Do doliczenia:', evs.length);
    if (!evs.length) {
      console.log('[count-retry] Wszystko już policzone dziś rano — nic do zrobienia.');
      return res.status(200).json({ ok: true, processed: 0, skipped: true });
    }
    const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSessionSafe()]);
    if (!tmSession) console.warn('[count-retry] TM niedostępny — zapis tylko eBilet (TM z fallbacku)');
    let ok = 0, errors = 0;
    for (const ev of evs) {
      try {
        const [ebResult, tmResult] = await Promise.all([
          fetchEbilet(ebToken, ev.name, ev.date, ev.altName || ''),
          tmSession ? fetchTm(tmSession, ev.name, ev.date, ev.onSale, ev.altName || '') : Promise.resolve({ tm: null }),
        ]);
        await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
        console.log(`[count-retry] OK: ${ev.name} — TM:${tmResult.tm ?? 'fallback'} EB:${ebResult.eb}`);
        ok++;
      } catch (err) {
        console.error(`[count-retry] Błąd dla ${ev.name}:`, err.message);
        errors++;
      }
    }
    return res.status(200).json({ ok: true, processed: ok, total: evs.length, errors, tmAvailable: !!tmSession });
  } catch (err) {
    console.error('[count-retry] Błąd główny:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 300 };

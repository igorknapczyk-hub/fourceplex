import { getEbiletToken, fetchEbilet, getTmSession, fetchTm, saveToFirebase } from './lib/counter.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Tylko POST' });
  const { events } = req.body || {};
  if (!events?.length) return res.status(400).json({ error: 'Brak eventów' });
  const [ebToken, tmSession] = await Promise.all([getEbiletToken(), getTmSession()]);
  const results = [];
  for (const ev of events) {
    try {
      const [ebResult, tmResult] = await Promise.all([
        fetchEbilet(ebToken, ev.name, ev.date, ev.altName || ''),
        fetchTm(tmSession, ev.name, ev.date, ev.onSale, ev.altName || ''),
      ]);
      await saveToFirebase(ev.id, ev, tmResult.tm, ebResult.eb, ebResult.remains, ebResult.cap);
      results.push({ id: ev.id, tm: tmResult.tm, eb: ebResult.eb, ok: true });
    } catch (err) {
      results.push({ id: ev.id, error: err.message, ok: false });
    }
  }
  return res.status(200).json({ results });
}

export const config = { maxDuration: 300 };

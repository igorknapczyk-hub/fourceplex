const SETLISTFM_API_BASE = 'https://api.setlist.fm/rest/1.0';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.SETLISTFM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing SETLISTFM_API_KEY' });

  const { artistName, date } = req.body || {};
  if (!artistName || typeof artistName !== 'string' || !artistName.trim()) {
    return res.status(400).json({ error: 'artistName required' });
  }

  const name = artistName.trim();

  try {
    // ── EXACT MATCH: search by artist + date ──────────────────────────────
    let exactSetlist = null;

    if (date && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // Convert YYYY-MM-DD → DD-MM-YYYY (setlist.fm format)
      const [yyyy, mm, dd] = date.split('-');
      const fmDate = `${dd}-${mm}-${yyyy}`;

      const exactUrl = `${SETLISTFM_API_BASE}/search/setlists?artistName=${encodeURIComponent(name)}&date=${fmDate}`;
      const exactRes = await setlistFetch(exactUrl, apiKey);

      if (exactRes.status === 429) return res.status(429).json({ error: 'setlist.fm rate limit — spróbuj za chwilę' });
      if (exactRes.status >= 500) return res.status(502).json({ error: 'setlist.fm niedostępne' });

      if (exactRes.status === 200) {
        const exactData = exactRes.data;
        if (exactData.setlist && exactData.setlist.length > 0) {
          exactSetlist = exactData.setlist[0];
        }
      }
      // 404 = no results for this date → fall through to fallback
    }

    if (exactSetlist) {
      const songs = extractSongs(exactSetlist, name);
      return res.status(200).json({ found: true, isExactMatch: true, songs });
    }

    // ── FALLBACK: most recent setlist for artist ──────────────────────────
    const fallbackUrl = `${SETLISTFM_API_BASE}/search/setlists?artistName=${encodeURIComponent(name)}`;
    const fallbackRes = await setlistFetch(fallbackUrl, apiKey);

    if (fallbackRes.status === 429) return res.status(429).json({ error: 'setlist.fm rate limit — spróbuj za chwilę' });
    if (fallbackRes.status >= 500) return res.status(502).json({ error: 'setlist.fm niedostępne' });
    if (fallbackRes.status === 404 || !fallbackRes.data.setlist) {
      return res.status(200).json({ found: false });
    }

    // Filter out empty setlists, sort descending by date
    const candidates = (fallbackRes.data.setlist || [])
      .filter(s => {
        const sets = s.sets?.set || [];
        return sets.some(set => (set.song || []).some(song => !song.tape && song.name?.trim()));
      })
      .sort((a, b) => parseFmDate(b.eventDate) - parseFmDate(a.eventDate));

    if (candidates.length === 0) {
      return res.status(200).json({ found: false });
    }

    const fallbackSetlist = candidates[0];
    const songs = extractSongs(fallbackSetlist, name);
    const venue = fallbackSetlist.venue || {};
    const city = venue.city || {};

    return res.status(200).json({
      found: true,
      isExactMatch: false,
      fallbackInfo: {
        eventDate: fallbackSetlist.eventDate || null,
        venueName: venue.name || null,
        cityName: city.name || null,
        countryName: city.country?.name || null,
      },
      songs,
    });

  } catch (e) {
    console.error('setlist-fm error:', e);
    return res.status(500).json({ error: e.message || 'Nieznany błąd' });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function setlistFetch(url, apiKey) {
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
      'Accept-Language': 'en',
    },
  });
  if (res.status === 404) return { status: 404, data: {} };
  if (!res.ok) return { status: res.status, data: {} };
  const data = await res.json();
  return { status: res.status, data };
}

function extractSongs(setlistObj, artistName) {
  const sets = setlistObj.sets?.set || [];
  const songs = [];

  for (const set of sets) {
    for (const song of (set.song || [])) {
      if (song.tape === true) continue;
      if (!song.name || !song.name.trim()) continue;

      const title = song.name.trim();
      const performer = song.cover?.name
        ? `${song.cover.name} (cover by ${artistName})`
        : artistName;

      songs.push({ title, performer });
    }
  }

  return songs;
}

// Parse DD-MM-YYYY → timestamp for sorting
function parseFmDate(str) {
  if (!str || !/^\d{2}-\d{2}-\d{4}$/.test(str)) return 0;
  const [dd, mm, yyyy] = str.split('-');
  return new Date(`${yyyy}-${mm}-${dd}`).getTime() || 0;
}

export const config = { maxDuration: 30 };

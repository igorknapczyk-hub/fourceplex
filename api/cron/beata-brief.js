// api/cron/beata-brief.js
// Scheduled briefy Beaty do pokoju PL Brief Room na Google Chat.
// Harmonogram (zarządzany przez vercel.json):
//   Poniedziałek 08:00 → branżowo-newsowy + placeholder kalendarza
//   Wtorek 08:00       → marketingowy
//   Środa 08:00        → ticketingowy
//   Piątek 08:00       → marketingowy

import Anthropic from '@anthropic-ai/sdk';
import { getTicketingEvents, getMarketingShows, getAllMarketingCosts } from '../lib/firestore.js';
import { getActiveCampaigns, groupCampaignsByShow } from '../lib/meta.js';
import { sendToSpace } from '../lib/google-chat.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BRIEF_SPACE = 'AAQA68DAqsM';

// ── Pomocnicze ────────────────────────────────────────────────────────────────

function getWarsawDay() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  return warsaw.getDay(); // 0=nd, 1=pn, 2=wt, 3=sr, 4=cz, 5=pt, 6=sb
}

function getWarsawDate() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const dniTygodnia = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  const miesiace = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
    'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  return `${dniTygodnia[warsaw.getDay()]}, ${warsaw.getDate()} ${miesiace[warsaw.getMonth()]} ${warsaw.getFullYear()}`;
}

async function generateBrief(systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ── Typy briefów ──────────────────────────────────────────────────────────────

async function briefTicketing() {
  const events = await getTicketingEvents();
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
  const active = (events || [])
    .filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 15);

  if (!active.length) return '🎫 *Brief ticketingowy*\nBrak aktywnych eventów.';

  const lines = active.map(e => {
    const pct = e.cap ? Math.round(e.total / e.cap * 100) : null;
    const pctStr = pct !== null ? ` (${pct}%)` : '';
    const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
    return `• *${e.name}* ${e.date} — ${e.total ?? '—'} biletów${pctStr}, ${daysLeft}d`;
  }).join('\n');

  const systemPrompt = `Jesteś Beatą — asystentką agencji FOURCE. Piszesz zwięzły brief ticketingowy. Bądź konkretna, po polsku, max 3 zdania komentarza. Kończ 🦎`;
  const userPrompt = `Napisz krótki brief ticketingowy na ${getWarsawDate()}. Dane sprzedaży:\n${lines}\n\nPodaj 1-2 zdania obserwacji (co idzie dobrze, co słabo, czy coś niepokojącego). Nie przepisuj całej tabeli — ona już będzie widoczna.`;

  const komentarz = await generateBrief(systemPrompt, userPrompt);
  return `🎫 *Brief ticketingowy — ${getWarsawDate()}*\n\n${lines}\n\n${komentarz}`;
}

async function briefMarketing() {
  const [shows, costs, campaigns] = await Promise.all([
    getMarketingShows(),
    getAllMarketingCosts({ limit: 50 }),
    getActiveCampaigns({ days: 7 }).catch(err => {
      console.error('[beata-brief] Meta API error:', err.message);
      return [];
    }),
  ]);

  const active = (shows || []).filter(s => s.status !== 'archived').slice(0, 10);

  // Koszty z Firestore per show
  const firestoreSection = active.map(s => {
    const showCosts = (costs || []).filter(c => c.showId === s.id);
    const totalSpend = showCosts.reduce((sum, c) => sum + (c.amount || 0), 0);
    return `• *${s.name}* — budżet: ${s.budget ?? '—'} PLN, wydano (Plex): ${totalSpend} PLN`;
  }).join('\n') || 'Brak aktywnych showów.';

  // Dane Meta per show
  let metaSection = '';
  if (campaigns.length) {
    const groups = groupCampaignsByShow(campaigns, active);
    if (groups.length) {
      metaSection = '\n\n*Meta Ads — ostatnie 7 dni:*\n' + groups.map(g => {
        const lines = [`• *${g.showName}* — wydano: ${g.totalSpend} PLN, CTR: ${g.avgCtr}%`];
        if (g.alerts.length) lines.push(...g.alerts.map(a => `  ${a}`));
        return lines.join('\n');
      }).join('\n');
    }
  } else {
    metaSection = '\n\n_Meta Ads: brak danych (sprawdź token)_';
  }

  const allAlerts = campaigns.length
    ? groupCampaignsByShow(campaigns, active).flatMap(g => g.alerts)
    : [];

  const systemPrompt = `Jesteś Beatą — asystentką agencji FOURCE. Piszesz zwięzły brief marketingowy. Konkretna, po polsku, max 3 zdania. Kończ 🦎`;
  const userPrompt = `Napisz krótki brief marketingowy na ${getWarsawDate()}.
Dane z Plexa:\n${firestoreSection}
Dane Meta Ads (7 dni):\n${metaSection}
Alerty: ${allAlerts.length ? allAlerts.join(', ') : 'brak'}
Co wymaga uwagi? Gdzie budżet się kończy lub kampania odstaje? 1-2 zdania obserwacji.`;

  const komentarz = await generateBrief(systemPrompt, userPrompt);
  return `📢 *Brief marketingowy — ${getWarsawDate()}*\n\n${firestoreSection}${metaSection}\n\n${komentarz}`;
}

async function briefBranżowy() {
  const systemPrompt = `Jesteś Beatą — asystentką polskiej agencji koncertowej FOURCE. Piszesz tygodniowy brief branżowy. Szukasz aktualnych newsów ze świata muzyki i koncertów (Polska + świat). Konkretna, po polsku, max 5 punktów. Kończ 🦎`;
  const userPrompt = `Napisz tygodniowy brief branżowy na ${getWarsawDate()} dla agencji koncertowej. Szukaj: nowe trasy koncertowe ogłoszone w ostatnich 7 dniach, ważne newsy z rynku muzycznego (Polska i świat), ciekawostki sprzedażowe lub trendowe. Max 5 punktów, każdy 1 zdanie z datą/źródłem.`;

  const brief = await generateBrief(systemPrompt, userPrompt);

  const kalendarz = `📅 *Kalendarz:* brak dostępu, wkrótce`;
  return `🗞️ *Brief branżowy — ${getWarsawDate()}*\n\n${brief}\n\n${kalendarz}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const day = getWarsawDay();
    // 1=pn, 2=wt, 3=sr, 5=pt
    if (![1, 2, 3, 5].includes(day)) {
      return res.status(200).json({ skipped: true, day });
    }

    let text;
    if (day === 1) text = await briefBranżowy();       // poniedziałek
    else if (day === 2) text = await briefMarketing();  // wtorek
    else if (day === 3) text = await briefTicketing();  // środa
    else if (day === 5) text = await briefMarketing();  // piątek

    await sendToSpace(BRIEF_SPACE, text);
    console.log(`[beata-brief] Wysłano brief (dzień ${day}) do spaces/${BRIEF_SPACE}`);
    return res.status(200).json({ ok: true, day, length: text.length });
  } catch (err) {
    console.error('[beata-brief] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 120 };

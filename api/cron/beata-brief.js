// api/cron/beata-brief.js
// Scheduled briefy Beaty do pokoju PL Brief Room na Google Chat.
// Harmonogram (vercel.json, UTC):
//   Poniedziałek 08:00 UTC (10:00 PL) → marketingowo-sprzedażowy
//   Środa 08:00 UTC (10:00 PL)        → sprzedażowy
//   Piątek 08:00 UTC (10:00 PL)       → marketingowy (lekki)

import Anthropic from '@anthropic-ai/sdk';
import { getTicketingEvents, getTicketingSnapshots, getMarketingShows, getAllMarketingCosts } from '../lib/firestore.js';
import { getActiveCampaigns, groupCampaignsByShow } from '../lib/meta.js';
import { sendToSpace } from '../lib/google-chat.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BRIEF_SPACE = 'AAQA68DAqsM';

// ── Pomocnicze ────────────────────────────────────────────────────────────────

function getWarsawDay() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  return warsaw.getDay();
}

function getWarsawDate() {
  const now = new Date();
  const warsaw = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const dni = ['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'];
  const mies = ['stycznia','lutego','marca','kwietnia','maja','czerwca',
    'lipca','sierpnia','września','października','listopada','grudnia'];
  return `${dni[warsaw.getDay()]}, ${warsaw.getDate()} ${mies[warsaw.getMonth()]} ${warsaw.getFullYear()}`;
}

async function callClaude(systemPrompt, userPrompt, useWebSearch = false) {
  const tools = useWebSearch
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    : [];
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    ...(tools.length ? { tools } : {}),
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ── Poniedziałek: raport marketingowo-sprzedażowy ────────────────────────────

async function briefPoniedzialek() {
  const cutoff = new Date(); cutoff.setHours(0,0,0,0);

  const [events, campaigns] = await Promise.all([
    getTicketingEvents({ upcomingOnly: true }),
    getActiveCampaigns({ days: 30 }).catch(err => {
      console.error('[beata-brief] Meta error:', err.message);
      return [];
    }),
  ]);

  const active = (events || [])
    .filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Dane sprzedaży per event
  const salesLines = active.map(e => {
    const pct = e.cap ? Math.round((e.total||0) / e.cap * 100) : null;
    const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
    const pctStr = pct !== null ? ` (${pct}% cap)` : '';
    return `• ${e.name} | ${e.date} | ${e.total||0} biletów${pctStr} | ${daysLeft}d do koncertu | cap: ${e.cap||'?'}`;
  }).join('\n') || 'Brak aktywnych eventów.';

  // Kampanie Meta
  const campaignLines = campaigns.length
    ? campaigns.map(c =>
        `• ${c.name} [${c.status}] — spend: ${c.spend} PLN, CTR: ${c.ctr?.toFixed(2)}%, CPM: ${c.cpm?.toFixed(0)} PLN, reach: ${c.reach}`
      ).join('\n')
    : 'Brak danych z Meta (sprawdź token).';

  // Eventy bez kampanii
  const eventNames = active.map(e => e.name.toLowerCase());
  const eventsWithCampaign = new Set(
    campaigns.flatMap(c =>
      eventNames.filter(n => c.name.toLowerCase().includes(n.split(' ')[0]))
    )
  );
  const eventsNoCampaign = active.filter(e =>
    !campaigns.some(c => c.name.toLowerCase().includes(e.name.toLowerCase().split(' ')[0]))
  );
  const noCampaignLines = eventsNoCampaign.length
    ? eventsNoCampaign.map(e => `• ${e.name} (${e.date})`).join('\n')
    : 'Wszystkie aktywne eventy mają kampanie.';

  // Wybierz jeden concert do szczegółowej analizy (najniższy % sprzedaży)
  const toAnalyze = active
    .filter(e => e.cap && e.total !== undefined)
    .sort((a, b) => (a.total/a.cap) - (b.total/b.cap))[0];

  const system = `Jesteś Beatą — asystentką agencji koncertowej FOURCE. Piszesz tygodniowy raport marketingowo-sprzedażowy. Konkretna, operacyjna, po polsku. Kończ 🦎`;

  const user = `Napisz raport marketingowo-sprzedażowy na ${getWarsawDate()}.

WYNIKI SPRZEDAŻY (aktywne eventy):
${salesLines}

KAMPANIE META ADS (ostatnie 30 dni):
${campaignLines}

EVENTY BEZ KAMPANII:
${noCampaignLines}

CONCERT DO ANALIZY TARGETOWANIA: ${toAnalyze ? `${toAnalyze.name} (${toAnalyze.date}, ${toAnalyze.total||0}/${toAnalyze.cap||'?'} biletów)` : 'brak'}

Zrób raport w tej strukturze:
1. 🚨 ALERTY — kampanie z niepokojącymi sygnałami (niski CTR <0.8%, wysoki CPM >40 PLN, wstrzymane z budżetem)
2. 📊 SPRZEDAŻ vs KAMPANIE — które concerty trzeba przycisnąć z marketingiem, które można zwolnić (porównaj % sprzedaży z aktywnością kampanii)
3. ⚠️ BEZ KAMPANII — skomentuj eventy bez kampanii Meta, czy to problem
4. 🎯 TARGETOWANIE — dla ${toAnalyze?.name || 'wybranego concertu'} zaproponuj konkretnie: grupy docelowe, zainteresowania, wiek, zachowania jakie warto ustawić w Meta Ads
5. Dopisz na końcu kursywą: _Raport zostanie poszerzony o dane budżetowe Fource.Plex, gdy te zostaną wprowadzone._

Bądź konkretna, nie lej wody. Max 400 słów.`;

  const analiza = await callClaude(system, user, false);
  return `📊 *Raport marketingowo-sprzedażowy — ${getWarsawDate()}*\n\n${analiza}`;
}

// ── Środa: raport sprzedażowy ────────────────────────────────────────────────

async function briefTicketing() {
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
  const events = await getTicketingEvents({ upcomingOnly: true });
  const active = (events || [])
    .filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!active.length) return '🎫 *Raport sprzedażowy*\nBrak aktywnych eventów.';

  // Pobierz snapshoty wtorkowe dla każdego eventu (max 2 ostatnie)
  const withSnaps = await Promise.all(
    active.slice(0, 20).map(async e => {
      const snaps = await getTicketingSnapshots(e.id, { limit: 2 });
      const last = snaps[0] || null;
      const prev = snaps[1] || null;
      const weekDiff = (last && prev && last.total != null && prev.total != null)
        ? last.total - prev.total
        : null;
      return { e, last, weekDiff };
    })
  );

  // Formatowanie linii per event
  const lines = withSnaps.map(({ e, last, weekDiff }) => {
    const total = e.total ?? 0;
    const cap = e.cap || null;
    const pct = cap ? Math.round(total / cap * 100) : null;
    const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
    const snapDate = last?.date || null;

    // Ikona statusu
    let icon = '⬜';
    if (pct !== null) {
      if (pct >= 100) icon = '🟢';
      else if (pct >= 60) icon = '🟡';
      else if (pct < 20 && daysLeft <= 14) icon = '🔴';
      else icon = '⬜';
    }

    // Trend tygodniowy
    let trendStr = '';
    if (weekDiff !== null) {
      const sign = weekDiff >= 0 ? '+' : '';
      trendStr = ` (${sign}${weekDiff}/tydz)`;
    } else if (last) {
      trendStr = ' (brak poprzedniego snapshotu)';
    } else {
      trendStr = ' (brak snapshotu)';
    }

    // Sold out?
    if (pct !== null && pct >= 100) {
      return `${icon} *${e.name}* — ${e.date} — *SOLD OUT* 🎉`;
    }

    const pctStr = pct !== null ? ` (${pct}% cap)` : '';
    const capStr = cap ? `/${cap}` : '';
    const daysStr = daysLeft === 1 ? '⚠️ *JUTRO*' : daysLeft <= 7 ? `⚠️ *${daysLeft}d*` : `${daysLeft}d`;

    return `${icon} *${e.name}* — ${e.date} — ${total}${capStr} bil.${pctStr}${trendStr} — ${daysStr}`;
  }).join('\n');

  // Alerty — eventy wymagające uwagi
  const alerts = withSnaps
    .filter(({ e, weekDiff }) => {
      const total = e.total ?? 0;
      const cap = e.cap || null;
      const pct = cap ? total / cap : null;
      const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
      const slowTrend = weekDiff !== null && weekDiff < 10 && pct !== null && pct < 0.5;
      const urgentLow = daysLeft <= 7 && pct !== null && pct < 0.5;
      return slowTrend || urgentLow;
    })
    .map(({ e, weekDiff }) => {
      const total = e.total ?? 0;
      const cap = e.cap || null;
      const pct = cap ? Math.round(total / cap * 100) : null;
      const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
      const pctStr = pct !== null ? `${pct}% cap` : '—';
      const trendStr = weekDiff !== null ? `+${weekDiff}/tydz` : 'brak danych';
      return `⚠️ *${e.name}* — ${daysLeft}d, ${pctStr}, tempo: ${trendStr}`;
    });

  // Prognoza — 3 najbliższe niesprzedane eventy z wystarczającym trendem
  const forecasts = withSnaps
    .filter(({ e, weekDiff }) => {
      const pct = e.cap ? (e.total ?? 0) / e.cap : null;
      return weekDiff !== null && weekDiff > 0 && pct !== null && pct < 1;
    })
    .slice(0, 3)
    .map(({ e, weekDiff }) => {
      const total = e.total ?? 0;
      const cap = e.cap;
      const remaining = cap - total;
      const weeksToSell = weekDiff > 0 ? Math.round(remaining / weekDiff * 10) / 10 : '∞';
      const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
      const weeksLeft = Math.round(daysLeft / 7 * 10) / 10;
      const projected = Math.min(cap, Math.round(total + weekDiff * weeksLeft));
      const projectedPct = Math.round(projected / cap * 100);
      return `📈 *${e.name}* — prognoza: ~${projected} bil. (${projectedPct}% cap) przy tempie +${weekDiff}/tydz`;
    });

  // Złożenie raportu
  const header = `🎫 *Raport sprzedażowy — ${getWarsawDate()}*\n_(snapshot wtorek, dane live)_`;
  const alertSection = alerts.length
    ? `\n\n*ALERTY:*\n${alerts.join('\n')}`
    : '\n\n*ALERTY:* brak';
  const forecastSection = forecasts.length
    ? `\n\n*PROGNOZA:*\n${forecasts.join('\n')}`
    : '';

  return `${header}\n\n${lines}${alertSection}${forecastSection}`;
}

async function briefSroda() {
  return briefTicketing();
}

// ── Piątek: raport marketingowy (lekki) ─────────────────────────────────────

async function briefPiatek() {
  const campaigns = await getActiveCampaigns({ days: 7 }).catch(err => {
    console.error('[beata-brief] Meta error:', err.message);
    return [];
  });

  const campaignLines = campaigns.length
    ? campaigns.map(c =>
        `• ${c.name} [${c.status}] — spend: ${c.spend} PLN, CTR: ${c.ctr?.toFixed(2)}%, CPM: ${c.cpm?.toFixed(0)} PLN`
      ).join('\n')
    : 'Brak danych z Meta.';

  const system = `Jesteś Beatą — asystentką agencji koncertowej FOURCE. Piszesz krótki piątkowy raport marketingowy. Zwięzła, po polsku. Kończ życzeniem dobrego weekendu i 🦎`;

  const user = `Napisz krótki raport marketingowy na ${getWarsawDate()} (dane z ostatnich 7 dni).

KAMPANIE META:
${campaignLines}

Podaj max 3 zdania: co warto poprawić lub zwrócić uwagę przed weekendem. Żadnych długich analiz — to piątek. Na końcu życz dobrego weekendu zespołowi.`;

  const analiza = await callClaude(system, user, false);
  return `📢 *Raport marketingowy — ${getWarsawDate()}*\n\n${analiza}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const day = getWarsawDay();
    // 1=pn, 3=sr, 5=pt
    if (![1, 3, 5].includes(day)) {
      return res.status(200).json({ skipped: true, day });
    }

    let text;
    if (day === 1) text = await briefPoniedzialek();
    else if (day === 3) text = await briefSroda();
    else if (day === 5) text = await briefPiatek();

    await sendToSpace(BRIEF_SPACE, text);
    console.log(`[beata-brief] Wysłano brief (dzień ${day}) do spaces/${BRIEF_SPACE}`);
    return res.status(200).json({ ok: true, day, length: text.length });
  } catch (err) {
    console.error('[beata-brief] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 120 };

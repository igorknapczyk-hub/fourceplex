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

async function briefSroda() {
  const cutoff = new Date(); cutoff.setHours(0,0,0,0);
  const events = await getTicketingEvents({ upcomingOnly: true });
  const active = (events || [])
    .filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Pobierz ostatni snapshot (wtorek) dla każdego eventu
  const snapshotsData = await Promise.all(
    active.slice(0, 15).map(async e => {
      const snaps = await getTicketingSnapshots(e.id, { limit: 4 });
      const lastSnap = snaps[0]; // najnowszy (wtorek)
      const prevSnap = snaps[1]; // tydzień temu
      const weekDiff = (lastSnap && prevSnap)
        ? (lastSnap.total||0) - (prevSnap.total||0)
        : null;
      return { event: e, lastSnap, weekDiff };
    })
  );

  const lines = snapshotsData.map(({ event: e, lastSnap, weekDiff }) => {
    const pct = e.cap ? Math.round((e.total||0) / e.cap * 100) : null;
    const daysLeft = Math.ceil((new Date(e.date) - new Date()) / 86400000);
    const snapInfo = lastSnap
      ? ` | snapshot ${lastSnap.date}: ${lastSnap.total||0} biletów`
      : '';
    const diffInfo = weekDiff !== null
      ? ` | tydzień: ${weekDiff > 0 ? '+' : ''}${weekDiff}`
      : '';
    return `• ${e.name} | ${e.date} | ${e.total||0} bil. | ${pct !== null ? pct+'% cap' : '—'} | ${daysLeft}d${snapInfo}${diffInfo}`;
  }).join('\n') || 'Brak danych.';

  const system = `Jesteś Beatą — asystentką agencji koncertowej FOURCE. Piszesz tygodniowy raport sprzedażowy. Konkretna, po polsku. Kończ 🦎`;

  const user = `Napisz raport sprzedażowy na ${getWarsawDate()} (dane ze snapshotu wtorkowego).

DANE SPRZEDAŻY:
${lines}

Zrób raport w tej strukturze:
1. ✅ DOBRZE IDĄCE — concerty z wysoką sprzedażą lub pozytywnym trendem tygodniowym
2. ⚠️ WYMAGAJĄCE UWAGI — concerty z niską sprzedażą lub słabym trendem
3. 📈 PROGNOZY — na podstawie tempa sprzedaży (tygodniowy diff) oszacuj finalną sprzedaż dla 3 najbliższych concertów

Bądź konkretna, max 300 słów.`;

  const analiza = await callClaude(system, user, false);
  return `🎫 *Raport sprzedażowy — ${getWarsawDate()}*\n\n${analiza}`;
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

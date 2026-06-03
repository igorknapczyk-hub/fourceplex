// api/lib/meta.js
// Odczyt danych z Meta Ads API dla Beaty i scheduled briefów.
// Używa META_ACCESS_TOKEN i META_AD_ACCOUNT_ID z env vars.

const TOKEN = () => process.env.META_ACCESS_TOKEN;
const ACCOUNT = () => {
  const id = process.env.META_AD_ACCOUNT_ID || '';
  return id.startsWith('act_') ? id : `act_${id}`;
};

// ── Eksportowane funkcje ──────────────────────────────────────────────────────

/**
 * Pobiera kampanie z Meta Ads API.
 * Używa tego samego podejścia co meta-campaigns.js (zagnieżdżone insights, v20.0).
 */
export async function getActiveCampaigns({ days = 30 } = {}) {
  const datePreset = days <= 7 ? 'last_7d' : days <= 30 ? 'last_30d' : 'last_year';
  const fields = [
    'id', 'name', 'status', 'objective',
    `insights.date_preset(${datePreset}){spend,reach,impressions,clicks,cpm,ctr,frequency}`,
  ].join(',');

  const url = `https://graph.facebook.com/v20.0/${ACCOUNT()}/campaigns?fields=${encodeURIComponent(fields)}&limit=100&access_token=${TOKEN()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);

  return (data.data || []).map(c => {
    const ins = c.insights?.data?.[0] || {};
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective || null,
      spend: ins.spend ? parseFloat(ins.spend) : 0,
      impressions: ins.impressions ? parseInt(ins.impressions) : 0,
      reach: ins.reach ? parseInt(ins.reach) : 0,
      clicks: ins.clicks ? parseInt(ins.clicks) : 0,
      ctr: ins.ctr ? parseFloat(ins.ctr) : 0,
      cpm: ins.cpm ? parseFloat(ins.cpm) : 0,
      frequency: ins.frequency ? parseFloat(ins.frequency) : null,
      purchases: null,
    };
  });
}

/**
 * Grupuje kampanie per artysta/show na podstawie nazwy kampanii.
 * Matchuje nazwę artysty (fuzzy, lowercase) do listy showów z Firestore.
 * Zwraca array { showName, campaigns[], totalSpend, avgCtr, alerts[] }
 */
export function groupCampaignsByShow(campaigns, shows) {
  const result = [];

  for (const show of shows) {
    const showName = (show.name || '').toLowerCase();
    const matched = campaigns.filter(c =>
      c.name.toLowerCase().includes(showName) ||
      showName.split(' ').some(word => word.length > 3 && c.name.toLowerCase().includes(word))
    );

    if (!matched.length) continue;

    const totalSpend = matched.reduce((s, c) => s + c.spend, 0);
    const totalImpressions = matched.reduce((s, c) => s + c.impressions, 0);
    const avgCtr = matched.length
      ? matched.reduce((s, c) => s + c.ctr, 0) / matched.length
      : 0;

    const alerts = [];
    for (const c of matched) {
      if (c.ctr < 0.5 && c.impressions > 5000) {
        alerts.push(`⚠️ ${c.name}: CTR ${c.ctr.toFixed(2)}% — bardzo niski`);
      }
      if (c.cpm > 50) {
        alerts.push(`⚠️ ${c.name}: CPM ${c.cpm.toFixed(0)} PLN — wysoki`);
      }
      if (c.status === 'PAUSED' && c.spend > 0) {
        alerts.push(`⏸️ ${c.name}: kampania wstrzymana (wydano ${c.spend.toFixed(0)} PLN)`);
      }
    }

    result.push({
      showName: show.name,
      showDate: show.date,
      campaigns: matched,
      totalSpend: Math.round(totalSpend),
      totalImpressions,
      avgCtr: avgCtr.toFixed(2),
      alerts,
    });
  }

  // Kampanie bez matcha — zgrupuj jako "Inne"
  const matchedIds = new Set(result.flatMap(r => r.campaigns.map(c => c.id)));
  const unmatched = campaigns.filter(c => !matchedIds.has(c.id));
  if (unmatched.length) {
    result.push({
      showName: 'Inne / nieprzypisane',
      showDate: null,
      campaigns: unmatched,
      totalSpend: Math.round(unmatched.reduce((s, c) => s + c.spend, 0)),
      totalImpressions: unmatched.reduce((s, c) => s + c.impressions, 0),
      avgCtr: unmatched.length
        ? (unmatched.reduce((s, c) => s + c.ctr, 0) / unmatched.length).toFixed(2)
        : '0',
      alerts: [],
    });
  }

  return result;
}

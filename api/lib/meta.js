// api/lib/meta.js
// Odczyt danych z Meta Ads API dla Beaty i scheduled briefów.
// Używa META_ACCESS_TOKEN i META_AD_ACCOUNT_ID z env vars.

const META_API = 'https://graph.facebook.com/v21.0';
const TOKEN = () => process.env.META_ACCESS_TOKEN;
const ACCOUNT = () => process.env.META_AD_ACCOUNT_ID; // format: act_XXXXXXXXX

// ── Pomocnicze ────────────────────────────────────────────────────────────────

async function metaGet(path, params = {}) {
  const url = new URL(`${META_API}${path}`);
  url.searchParams.set('access_token', TOKEN());
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);
  return data;
}

// ── Eksportowane funkcje ──────────────────────────────────────────────────────

/**
 * Pobiera aktywne kampanie z ostatnich 30 dni z podstawowymi metrykami.
 * Zwraca tablicę kampanii z: id, name, status, spend, impressions, reach, clicks, ctr, cpm.
 */
export async function getActiveCampaigns({ days = 30 } = {}) {
  const datePreset = days <= 7 ? 'last_7d' : days <= 30 ? 'last_30d' : 'this_month';

  const data = await metaGet(`/${ACCOUNT()}/campaigns`, {
    fields: 'id,name,status,objective',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]),
    limit: 50,
  });

  const campaigns = data.data || [];
  if (!campaigns.length) return [];

  // Pobierz insights dla wszystkich kampanii naraz
  const insights = await metaGet(`/${ACCOUNT()}/insights`, {
    fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpm,actions',
    date_preset: datePreset,
    level: 'campaign',
    limit: 50,
  });

  const insightsMap = {};
  for (const i of (insights.data || [])) {
    insightsMap[i.campaign_id] = i;
  }

  return campaigns.map(c => {
    const ins = insightsMap[c.id] || {};
    const purchases = (ins.actions || []).find(a => a.action_type === 'purchase');
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      spend: parseFloat(ins.spend || 0),
      impressions: parseInt(ins.impressions || 0),
      reach: parseInt(ins.reach || 0),
      clicks: parseInt(ins.clicks || 0),
      ctr: parseFloat(ins.ctr || 0),
      cpm: parseFloat(ins.cpm || 0),
      purchases: purchases ? parseInt(purchases.value) : null,
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

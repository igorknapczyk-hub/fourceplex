/**
 * Netlify Function: meta-campaigns
 * Pobiera kampanie i metryki z Meta Marketing API (ads_read)
 *
 * Wymagane zmienne środowiskowe w Netlify:
 *   META_ACCESS_TOKEN  – token dostępu (ads_read)
 *   META_AD_ACCOUNT_ID – ID konta reklamowego (bez prefiksu "act_")
 *
 * Query params:
 *   search – opcjonalny filtr po nazwie kampanii
 *   range  – zakres czasowy: 90d (domyślnie) | 6m | 12m
 */

const DATE_PRESETS = {
  '90d': 'last_90d',
  '6m':  'last_6_months',
  '12m': 'last_year',
};

exports.handler = async function (event) {
  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

  if (!token || !accountId) {
    return err(500, 'Brak META_ACCESS_TOKEN lub META_AD_ACCOUNT_ID w zmiennych środowiskowych Netlify.');
  }

  const search    = (event.queryStringParameters?.search || '').trim().toLowerCase();
  const rangeKey  = event.queryStringParameters?.range || '90d';
  const preset    = DATE_PRESETS[rangeKey] || 'last_90d';

  const fields = [
    'id',
    'name',
    'status',
    'objective',
    `insights.date_preset(${preset}){spend,reach,impressions,clicks,cpm,ctr,frequency}`,
  ].join(',');

  const apiUrl =
    `https://graph.facebook.com/v20.0/act_${accountId}/campaigns` +
    `?fields=${encodeURIComponent(fields)}&limit=100&access_token=${token}`;

  let raw;
  try {
    const res = await fetch(apiUrl);
    raw = await res.json();
  } catch (e) {
    return err(502, 'Błąd połączenia z Meta API: ' + e.message);
  }

  if (raw.error) {
    return err(400, raw.error.message || 'Błąd Meta API');
  }

  let campaigns = (raw.data || []).map(c => {
    const ins = c.insights?.data?.[0] || {};
    return {
      id:          c.id,
      name:        c.name,
      status:      c.status,
      objective:   c.objective || null,
      spend:       ins.spend       ? parseFloat(ins.spend)       : null,
      reach:       ins.reach       ? parseInt(ins.reach)         : null,
      impressions: ins.impressions ? parseInt(ins.impressions)   : null,
      clicks:      ins.clicks      ? parseInt(ins.clicks)        : null,
      cpm:         ins.cpm         ? parseFloat(ins.cpm)         : null,
      ctr:         ins.ctr         ? parseFloat(ins.ctr)         : null,
      frequency:   ins.frequency   ? parseFloat(ins.frequency)   : null,
    };
  });

  if (search) {
    campaigns = campaigns.filter(c => c.name.toLowerCase().includes(search));
  }

  /* aktywne pierwsze, potem wg wydatków malejąco */
  campaigns.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return  1;
    return (b.spend || 0) - (a.spend || 0);
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify({ campaigns, range: rangeKey, fetched_at: new Date().toISOString() }),
  };
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function err(status, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify({ error: message }),
  };
}

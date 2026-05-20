const DATE_PRESETS = { '30d': 'last_30d', '90d': 'last_90d', '12m': 'last_year' };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  const token = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) return res.status(500).json({ error: 'Brak META_ACCESS_TOKEN lub META_AD_ACCOUNT_ID' });
  const search = (req.query.search || '').trim().toLowerCase();
  const rangeKey = req.query.range || '30d';
  const preset = DATE_PRESETS[rangeKey] || 'last_30d';
  const fields = ['id', 'name', 'status', 'objective',
    `insights.date_preset(${preset}){spend,reach,impressions,clicks,cpm,ctr,frequency}`].join(',');
  const apiUrl = `https://graph.facebook.com/v20.0/act_${accountId}/campaigns?fields=${encodeURIComponent(fields)}&limit=100&access_token=${token}`;
  let raw;
  try {
    const response = await fetch(apiUrl);
    raw = await response.json();
  } catch (e) {
    return res.status(502).json({ error: 'Błąd połączenia z Meta API: ' + e.message });
  }
  if (raw.error) return res.status(400).json({ error: raw.error.message });
  let campaigns = (raw.data || []).map(c => {
    const ins = c.insights?.data?.[0] || {};
    return {
      id: c.id, name: c.name, status: c.status, objective: c.objective || null,
      spend: ins.spend ? parseFloat(ins.spend) : null,
      reach: ins.reach ? parseInt(ins.reach) : null,
      impressions: ins.impressions ? parseInt(ins.impressions) : null,
      clicks: ins.clicks ? parseInt(ins.clicks) : null,
      cpm: ins.cpm ? parseFloat(ins.cpm) : null,
      ctr: ins.ctr ? parseFloat(ins.ctr) : null,
      frequency: ins.frequency ? parseFloat(ins.frequency) : null,
    };
  });
  if (search) campaigns = campaigns.filter(c => c.name.toLowerCase().includes(search));
  campaigns.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return 1;
    return (b.spend || 0) - (a.spend || 0);
  });
  return res.status(200).json({ campaigns, range: rangeKey, fetched_at: new Date().toISOString() });
}

export const config = { maxDuration: 30 };

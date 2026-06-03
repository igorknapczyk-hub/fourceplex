// api/test-meta.js — TYMCZASOWY, usuń po teście

export default async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;
  const account = process.env.META_AD_ACCOUNT_ID;

  if (!token) return res.status(200).json({ error: 'META_ACCESS_TOKEN brak' });
  if (!account) return res.status(200).json({ error: 'META_AD_ACCOUNT_ID brak' });

  const accountFmt = account.startsWith('act_') ? account : `act_${account}`;

  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${accountFmt}/campaigns?fields=id,name,status&limit=3&access_token=${token}`
    );
    const data = await r.json();
    return res.status(200).json({
      account_used: accountFmt,
      token_prefix: token.slice(0, 10) + '...',
      response: data,
    });
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
}

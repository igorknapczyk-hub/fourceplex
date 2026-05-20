const GRAPHQL_QUERY = `
query($eventName: String) {
  sales(
    filter: { event_name: { contains: $eventName } }
    orderBy: null
  ) {
    hasNextPage
    endCursor
    items {
      event_name
      event_time
      event_external_id
      sales_ticket_count
      free_seats_without_reservations
      all_seats
      taken_seats_without_reservations
      sales_gross
      sales_net
    }
  }
}
`;

async function getAccessToken() {
  const { EBILET_TENANT_ID, EBILET_CLIENT_ID, EBILET_CLIENT_SECRET, EBILET_SCOPE } = process.env;
  if (!EBILET_TENANT_ID || !EBILET_CLIENT_ID || !EBILET_CLIENT_SECRET || !EBILET_SCOPE) {
    throw new Error('Brak zmiennych eBilet');
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${EBILET_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: EBILET_CLIENT_ID,
        client_secret: EBILET_CLIENT_SECRET,
        scope: EBILET_SCOPE,
      }).toString(),
    }
  );
  if (!res.ok) throw new Error(`Azure AD token error ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Azure AD nie zwróciło access_token');
  return data.access_token;
}

async function querySales(token, eventName) {
  const graphqlUrl = process.env.EBILET_GRAPHQL_URL;
  if (!graphqlUrl) throw new Error('Brak EBILET_GRAPHQL_URL');
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { eventName } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP error ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(`GraphQL błąd: ${data.errors.map(e => e.message).join('; ')}`);
  return data?.data?.sales?.items ?? [];
}

function findAllMatchingEvents(items, eventDate) {
  const target = new Date(eventDate);
  return items.filter(item => {
    if (!item.event_time) return false;
    const d = new Date(item.event_time);
    return d.getFullYear() === target.getFullYear()
      && d.getMonth() === target.getMonth()
      && d.getDate() === target.getDate();
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Tylko POST' });
  const { eventName, eventDate } = req.body || {};
  if (!eventName || !eventDate) return res.status(400).json({ error: 'Wymagane: eventName, eventDate' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: 'eventDate musi być YYYY-MM-DD' });
  try {
    const token = await getAccessToken();
    const items = await querySales(token, eventName);
    if (!items.length) return res.status(404).json({ error: `Brak wyników dla "${eventName}"` });
    const matches = findAllMatchingEvents(items, eventDate);
    if (!matches.length) return res.status(404).json({ error: `Nie znaleziono eventu dla daty ${eventDate}`, resultsFound: items.length });
    const paid = matches.filter(m => (m.sales_gross ?? 0) > 0);
    const comps = matches.reduce((s, m) => s + ((m.sales_gross ?? 0) === 0 ? (m.sales_ticket_count ?? 0) : 0), 0);
    const eb = paid.reduce((s, m) => s + (m.sales_ticket_count ?? 0), 0);
    const remains = matches.reduce((s, m) => s + (m.free_seats_without_reservations ?? 0), 0);
    const cap = matches.reduce((s, m) => s + (m.all_seats ?? 0), 0);
    const taken = matches.reduce((s, m) => s + (m.taken_seats_without_reservations ?? 0), 0);
    return res.status(200).json({ eb, remains, cap, taken, comps, eventName: matches[0].event_name, eventDate: matches[0].event_time, matchedRecords: matches.length, raw: matches });
  } catch (err) {
    console.error('[ebilet]', err);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 60 };

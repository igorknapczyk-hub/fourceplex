/**
 * Netlify Function — eBilet Sales Data
 * Pobiera dane sprzedaży z eBilet API przez OAuth2 (Azure AD) + GraphQL
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GRAPHQL_QUERY = `
query($eventName: String) {
  sales(
    filter: {
      event_name: { contains: $eventName }
    }
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

/* ── Pobierz token z Azure AD ── */
async function getAccessToken() {
  const tenantId  = process.env.EBILET_TENANT_ID;
  const clientId  = process.env.EBILET_CLIENT_ID;
  const clientSecret = process.env.EBILET_CLIENT_SECRET;
  const scope     = process.env.EBILET_SCOPE;

  if (!tenantId || !clientId || !clientSecret || !scope) {
    throw new Error('Brak wymaganych zmiennych środowiskowych: EBILET_TENANT_ID, EBILET_CLIENT_ID, EBILET_CLIENT_SECRET, EBILET_SCOPE');
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         scope,
  });

  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure AD token error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Azure AD nie zwróciło access_token');
  }

  return data.access_token;
}

/* ── Zapytaj GraphQL ── */
async function querySales(token, eventName) {
  const graphqlUrl = process.env.EBILET_GRAPHQL_URL;
  if (!graphqlUrl) {
    throw new Error('Brak zmiennej środowiskowej: EBILET_GRAPHQL_URL');
  }

  const res = await fetch(graphqlUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query:     GRAPHQL_QUERY,
      variables: { eventName },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL HTTP error ${res.status}: ${text}`);
  }

  const data = await res.json();

  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map(e => e.message).join('; ');
    throw new Error(`GraphQL błąd: ${msg}`);
  }

  return data?.data?.sales?.items ?? [];
}

/* ── Filtruj po dacie (±2 dni) ── */
function findAllMatchingEvents(items, eventDate) {
  const target = new Date(eventDate);
  return items.filter(item => {
    if (!item.event_time) return false;
    const d = new Date(item.event_time);
    return d.getFullYear() === target.getFullYear()
        && d.getMonth()    === target.getMonth()
        && d.getDate()     === target.getDate();
  });
}

/* ── Handler ── */
exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Tylko metoda POST jest obsługiwana' }),
    };
  }

  // Parsuj body
  let eventName, eventDate;
  try {
    const body = JSON.parse(event.body || '{}');
    eventName = (body.eventName || '').trim();
    eventDate = (body.eventDate || '').trim();
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Nieprawidłowy JSON w body' }),
    };
  }

  if (!eventName || !eventDate) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Wymagane pola: eventName, eventDate (format YYYY-MM-DD)' }),
    };
  }

  // Walidacja daty
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || isNaN(new Date(eventDate).getTime())) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'eventDate musi być w formacie YYYY-MM-DD' }),
    };
  }

  try {
    // 1. Token OAuth2
    const token = await getAccessToken();

    // 2. Zapytanie GraphQL
    const items = await querySales(token, eventName);

    if (!items.length) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Brak wyników dla "${eventName}" od ${eventDate}` }),
      };
    }

    const matches = findAllMatchingEvents(items, eventDate);

    if (!matches.length) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Nie znaleziono eventu dla daty ${eventDate}`,
          resultsFound: items.length,
        }),
      };
    }

    const paid  = matches.filter(m => (m.sales_gross ?? 0) > 0);
    const comps = matches.reduce((s, m) => s + ((m.sales_gross ?? 0) === 0 ? (m.sales_ticket_count ?? 0) : 0), 0);

    const eb      = paid.reduce((s, m) => s + (m.sales_ticket_count ?? 0), 0);
    const remains = matches.reduce((s, m) => s + (m.free_seats_without_reservations ?? 0), 0);
    const cap     = matches.reduce((s, m) => s + (m.all_seats ?? 0), 0);
    const taken   = matches.reduce((s, m) => s + (m.taken_seats_without_reservations ?? 0), 0);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eb,
        remains,
        cap,
        taken,
        comps,
        eventName: matches[0].event_name,
        eventDate: matches[0].event_time,
        matchedRecords: matches.length,
        raw: matches,
      }),
    };

  } catch (err) {
    console.error('[ebilet]', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Nieznany błąd serwera' }),
    };
  }
};

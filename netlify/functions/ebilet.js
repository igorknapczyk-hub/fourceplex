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
query($eventName: String, $dateFrom: String, $dateTo: String) {
  sales(
    filter: {
      event_name: { contains: $eventName }
      event_time: { gt: $dateFrom, lt: $dateTo }
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
async function querySales(token, eventName, dateFrom, dateTo) {
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
      variables: { eventName, dateFrom, dateTo },
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
function findMatchingEvent(items, eventDate) {
  // eventDate: YYYY-MM-DD
  const target = new Date(eventDate);
  target.setHours(0, 0, 0, 0);
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  return items.find(item => {
    if (!item.event_time) return false;
    const d = new Date(item.event_time);
    return Math.abs(d.getTime() - target.getTime()) <= TWO_DAYS;
  }) ?? null;
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

    // 2. dateFrom = 3 dni przed eventDate (żeby złapać ±2 dni)
    const dateFromObj = new Date(eventDate);
    dateFromObj.setDate(dateFromObj.getDate() - 3);
    const dateFrom = dateFromObj.toISOString().slice(0, 10);

    const dateToObj = new Date(eventDate);
    dateToObj.setDate(dateToObj.getDate() + 4);
    const dateTo = dateToObj.toISOString().slice(0, 10);

    // 3. Zapytanie GraphQL
    const items = await querySales(token, eventName, dateFrom, dateTo);

    if (!items.length) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Brak wyników dla "${eventName}" od ${dateFrom}` }),
      };
    }

    // 4. Znajdź dokładny event (±2 dni)
    const match = findMatchingEvent(items, eventDate);

    if (!match) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Nie znaleziono eventu w oknie ±2 dni od ${eventDate}`,
          resultsFound: items.length,
        }),
      };
    }

    // 5. Odpowiedź
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eb:        match.sales_ticket_count            ?? 0,
        remains:   match.free_seats_without_reservations ?? 0,
        cap:       match.all_seats                     ?? 0,
        taken:     match.taken_seats_without_reservations ?? 0,
        eventName: match.event_name                    ?? eventName,
        eventDate: match.event_time                    ?? eventDate,
        raw:       match,
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

/**
 * Netlify Function — debug-raw
 * Zwraca surowe dane z eBilet i TM dla jednego eventu, żeby zbadać strukturę pól.
 * Użycie: POST /api/debug-raw  { "eventName": "...", "eventDate": "YYYY-MM-DD", "onSaleDate": "YYYY-MM-DD" }
 * UWAGA: usuń tę funkcję po zakończeniu diagnostyki!
 */

const { getEbiletToken, getTmSession } = require('./utils/counter');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let eventName, eventDate, onSaleDate;
  try {
    const body  = JSON.parse(event.body || '{}');
    eventName   = (body.eventName   || '').trim();
    eventDate   = (body.eventDate   || '').trim();
    onSaleDate  = (body.onSaleDate  || '').trim() || null;
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Nieprawidłowy JSON' }) };
  }
  if (!eventName || !eventDate) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Wymagane: eventName, eventDate' }) };
  }

  const result = { eventName, eventDate };

  /* ── eBilet: surowe items ── */
  try {
    const token = await getEbiletToken();
    const res = await fetch(process.env.EBILET_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      // sales → Pools → PriceZones (tylko skalary PriceZone — bez zagnieżdżeń)
      body: JSON.stringify({
        query: `query($n:String){sales(filter:{event_name:{contains:$n}}orderBy:null){items{
          event_name event_time sales_ticket_count sales_gross
          Pools { items {
            pool_name
            sales_ticket_count
            sales_gross
            all_seats
            PriceZones { items {
              sales_ticket_count
              sales_gross
              all_seats
              free_seats_without_reservations
              price_gross
              printouts_ticket_count
              taken_seats_without_reservations
            }}
          }}
        }}}`,
        variables: { n: eventName },
      }),
    });
    const data = await res.json();
    const items = data?.data?.sales?.items ?? [];

    // Filtruj tylko po dacie
    const target = new Date(eventDate);
    const dateMatched = items.filter(item => {
      if (!item.event_time) return false;
      const d = new Date(item.event_time);
      return d.getFullYear() === target.getFullYear()
          && d.getMonth()    === target.getMonth()
          && d.getDate()     === target.getDate();
    });

    // Introspection — pola typów Pool, TicketType, Sale, PriceZone + pola filtrów
    const introHelper = async (typeName) => {
      try {
        const r = await fetch(process.env.EBILET_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ query: `{ __type(name: "${typeName}") { fields { name type { name kind } } inputFields { name type { name kind } } } }` }),
        });
        const d = await r.json();
        const t = d?.data?.__type;
        if (!t) return null;
        return {
          fields:      (t.fields      ?? []).map(f => `${f.name}: ${f.type.kind}/${f.type.name}`),
          inputFields: (t.inputFields ?? []).map(f => `${f.name}: ${f.type.kind}/${f.type.name}`),
        };
      } catch { return null; }
    };

    const [poolFields, ticketTypeFields, saleFields, priceZoneFields, poolFilterFields] = await Promise.all([
      introHelper('Pool'),
      introHelper('TicketType'),
      introHelper('Sale'),
      introHelper('PriceZone'),
      introHelper('PoolFilterInput'),
    ]);

    // Zapytaj endpoint pools dla tego eventu
    let poolsRaw = null;
    if (poolFields && poolFields.length > 0) {
      try {
        const safeFields = poolFields.filter(f =>
          !['__typename'].includes(f)
        ).join(' ');
        const r = await fetch(process.env.EBILET_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            query: `query($n:String){ pools(filter:{event_name:{contains:$n}}orderBy:null){ items{ ${safeFields} } } }`,
            variables: { n: eventName },
          }),
        });
        const d = await r.json();
        poolsRaw = d?.data?.pools?.items ?? d?.errors ?? d;
      } catch (e) { poolsRaw = { error: e.message }; }
    }

    // Zapytaj endpoint ticketTypes dla tego eventu
    let ticketTypesRaw = null;
    if (ticketTypeFields && ticketTypeFields.length > 0) {
      try {
        const safeFields = ticketTypeFields.join(' ');
        const r = await fetch(process.env.EBILET_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            query: `query($n:String){ ticketTypes(filter:{event_name:{contains:$n}}orderBy:null){ items{ ${safeFields} } } }`,
            variables: { n: eventName },
          }),
        });
        const d = await r.json();
        ticketTypesRaw = d?.data?.ticketTypes?.items ?? d?.errors ?? d;
      } catch (e) { ticketTypesRaw = { error: e.message }; }
    }

    result.ebilet = {
      totalItemsReturned: items.length,
      itemsMatchingDate:  dateMatched.length,
      rawItems:           dateMatched,
      schema_Pool:        poolFields,
      schema_TicketType:  ticketTypeFields,
      schema_Sale:        saleFields,
      schema_PriceZone:   priceZoneFields,
      schema_PoolFilter:  poolFilterFields,
      pools:              poolsRaw,
      ticketTypes:        ticketTypesRaw,
    };
  } catch (err) {
    result.ebilet = { error: err.message };
  }

  /* ── Ticketmaster: pierwsze 20 surowych transakcji (żeby zobaczyć strukturę pól) ── */
  try {
    const sessionId = await getTmSession();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} 00:00:00`;
    const anchor = new Date(eventDate); anchor.setDate(anchor.getDate() + 7);
    const start  = onSaleDate ? new Date(onSaleDate) : new Date(anchor);
    if (!onSaleDate) start.setDate(start.getDate() - 365);

    // Pobierz tylko ostatni 31-dniowy okres (wystarczy na diagnostykę)
    const res = await fetch(
      `${process.env.TM_URL}/reports/eventSales?apikey=${process.env.TM_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          'sessionId':    sessionId,
          'marketCode':   process.env.TM_MARKET,
        },
        body: JSON.stringify({ from: fmt(start), to: fmt(anchor) }),
      }
    );
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.transactions ?? []);

    // Filtruj po nazwie eventu
    const matched = rows.filter(t =>
      (t.eventTitle || '').toLowerCase().includes(eventName.toLowerCase())
    );

    result.tm = {
      totalTransactions:   rows.length,
      matchedTransactions: matched.length,
      // Pierwsze 5 transakcji w całości — żeby zobaczyć WSZYSTKIE dostępne pola
      sampleTransactions:  matched.slice(0, 5),
      // Wszystkie unikalne klucze (pola) jakie pojawiają się w transakcjach
      allFieldNames: matched.length > 0
        ? [...new Set(matched.flatMap(t => Object.keys(t)))].sort()
        : [],
      // Unikalne wartości pól, które mogą zawierać "upgrade"
      uniqueEventTitles: [...new Set(matched.map(t => t.eventTitle))].slice(0, 20),
    };
  } catch (err) {
    result.tm = { error: err.message };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(result, null, 2),
  };
};

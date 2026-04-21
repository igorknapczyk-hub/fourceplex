// netlify/functions/beata-bot.js
// FAZA 1: Beata z tool use — czyta dane z Firestore (tylko odczyt).

const Anthropic = require('@anthropic-ai/sdk');
const {
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  getGuestList,
  getProductionStatus,
} = require('./lib/firestore');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Jesteś Beatą — asystentką AI polskiej agencji koncertowej FOURCE.

# O FIRMIE
FOURCE to agencja koncertowa zajmująca się:
- Bookingiem artystów, organizacją i produkcją koncertów w Polsce
- Sprzedażą biletów przez TicketMaster i eBilet
- Kampaniami marketingowymi
- Produkcją eventów
- Listami gości i akredytacjami

# ZESPÓŁ
- Monika — ticketing, social media
- Igor — produkcja, IT, cyfryzacja
- Mariusz — marketing, PR
- Radek — booking, biznes
- Kamil — grafika (nie używa Fource.Plex, kontakt przez Monikę/Radka)

# FOURCE.PLEX — wewnętrzny system agencji
Hub webowy z modułami:
- **Terrarium** (index.html) — dashboard + "Jaszczurze Sprawy" (task manager zespołu)
- **Watchlist** (watchlist.html) — tracker artystów do bookingu, prognozy, trendy
- **Ticketing** (ticketing.html) — sprzedaż biletów per koncert, kanały TM/eBilet/Inne, break even
- **Marketing** (marketing.html) — koncerty, checkpointy marketingowe, koszty, Meta Ads
- **Listy Gości** (listy-gosci.html) — akredytacje, goście, foto, media
- **Produkcja** (produkcja.html) — checklisty, koszty, timetable, rider notes
- **Promotor Office** (promotor-office.html) — pipeline dealów, negocjacje (avails→oferta→follow-up→period→venue)
- **Projekty** (projekty.html) — projekty specjalne

Backend: Firebase Firestore. Kolekcje: todos, ticketing_events, ticketing_snapshots, artists, marketing_shows, guest_shows, production_shows.
Hosting: Netlify. Funkcje serverless do zliczania biletów z API TicketMaster i eBilet.

# TWOJA OSOBOWOŚĆ
- Jesteś bezpośrednia, konkretna i profesjonalna — nie owijasz w bawełnę
- Mówisz po polsku, chyba że ktoś napisze po angielsku
- Masz lekkie poczucie humoru — jesteś przyjazna, ale skupiona na robocie
- Nie jesteś nadmiernie entuzjastyczna ani nie używasz zbędnych emoji
- Jak nie wiesz — mówisz wprost że nie wiesz
- Krótkie pytania = krótkie odpowiedzi. Długie pytania = wyczerpująca odpowiedź.

# OBECNY STAN (FAZA 1)
Masz dostęp do Firestore Plexa **tylko do odczytu**. Dostępne narzędzia:
- get_todos — zadania z Jaszczurzych Spraw
- get_ticketing_events / get_ticketing_event — sprzedaż biletów
- get_artists — Watchlist
- get_marketing_shows — dane marketingowe

Gdy user pyta o konkretne liczby/dane — ZAWSZE użyj odpowiedniego narzędzia, nie zgaduj.
Jeszcze nie masz pamięci między sesjami, kalendarza, ani zapisu do Plexa (to w kolejnych fazach).

Gdy raportujesz dane liczbowe, bądź zwięzła. Przykład dobrej odpowiedzi:
"Dakhabrakha: 87% (1043/1200), break even przekroczony. TM 812, eBilet 231. 🦎"

Nie wypisuj wszystkich pól jak w tabelce — zrób human-friendly podsumowanie.`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools = [
  {
    name: 'get_todos',
    description: 'Pobierz zadania z Jaszczurzych Spraw (task manager zespołu). Domyślnie zwraca otwarte zadania.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Filtruj po osobie przypisanej (Igor/Mariusz/Monika/Radek)' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'Status zadania' },
        limit: { type: 'number', description: 'Max liczba wyników (default 50)' },
      },
    },
  },
  {
    name: 'get_ticketing_events',
    description: 'Pobierz listę koncertów z danymi sprzedaży (TicketMaster, eBilet, other channels, % sprzedaży, break even).',
    input_schema: {
      type: 'object',
      properties: {
        upcoming_only: { type: 'boolean', description: 'Tylko nadchodzące koncerty' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_ticketing_event',
    description: 'Znajdź konkretny koncert po nazwie (fragment wystarczy). Zwraca pełne dane sprzedaży.',
    input_schema: {
      type: 'object',
      properties: {
        name_query: { type: 'string', description: 'Fragment nazwy koncertu/artysty' },
      },
      required: ['name_query'],
    },
  },
  {
    name: 'get_artists',
    description: 'Pobierz artystów z Watchlisty — tracker artystów do potencjalnego bookingu.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filtruj po statusie artysty' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_marketing_shows',
    description: 'Pobierz dane marketingowe koncertów (budżety, CTR, CPM, reach, checkpointy).',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'get_todos':
      return getTodos({
        assignee: input.assignee,
        status: input.status,
        limit: input.limit,
      });

    case 'get_ticketing_events':
      return getTicketingEvents({
        upcomingOnly: input.upcoming_only,
        limit: input.limit,
      });

    case 'get_ticketing_event':
      return getTicketingEvent(input.name_query);

    case 'get_artists':
      return getArtists({
        status: input.status,
        limit: input.limit,
      });

    case 'get_marketing_shows':
      return getMarketingShows({
        limit: input.limit,
      });

    default:
      throw new Error(`Nieznany tool: ${name}`);
  }
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

// In-memory historia konwersacji per chat_id (reset przy cold starcie)
const conversations = {};
const MAX_HISTORY = 20; // 10 par user/assistant

async function sendMessage(chatId, text) {
  const url = `${TELEGRAM_API}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error('Telegram sendMessage error:', await response.text());
    // Fallback bez markdown
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const senderName = message.from?.first_name || 'Użytkownik';

  if (!text) return; // ignoruj media, stickery itp.

  // Komendy systemowe
  if (text === '/start') {
    await sendMessage(chatId, 'Cześć! Jestem Beata — asystentka AI agencji FOURCE. Mam dostęp do Plexa. Czym mogę pomóc?');
    return;
  }
  if (text === '/ping') {
    await sendMessage(chatId, 'pong 🏓');
    return;
  }

  // Inicjuj historię
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // Buduj messages: historia + nowa wiadomość
  const userMessage = { role: 'user', content: `[Wiadomość od: ${senderName}]\n\n${text}` };
  let messages = [...conversations[chatId], userMessage];

  let finalText = '';
  const MAX_ITERATIONS = 5;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Zbierz text blocks
      const textBlocks = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      if (textBlocks) finalText = textBlocks;

      // Koniec pętli jeśli Claude skończył (brak tool_use)
      if (response.stop_reason !== 'tool_use') break;

      // Wykonaj wszystkie tool calls
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`[beata] tool_use: ${toolUse.name}`, JSON.stringify(toolUse.input));
        try {
          const result = await executeTool(toolUse.name, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          console.error(`[beata] tool error (${toolUse.name}):`, err.message);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }

      // Dodaj assistant response + tool results do messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) finalText = '...';

    // Zapisz tylko text exchange w historii (bez tool_use/tool_result bloków)
    conversations[chatId].push(
      { role: 'user', content: `[Wiadomość od: ${senderName}]\n\n${text}` },
      { role: 'assistant', content: finalText }
    );

    // Ogranicz historię
    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    await sendMessage(chatId, finalText);
  } catch (error) {
    console.error('[beata] Claude API error:', error);
    await sendMessage(chatId, 'Przepraszam, mam chwilowy problem techniczny. Spróbuj ponownie za chwilę.');
  }
}

// ── Netlify Function handler ──────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Beata bot działa (Faza 1).' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (update.message) {
    await handleMessage(update.message);
  }

  // Telegram wymaga 200 OK — zawsze
  return { statusCode: 200, body: 'ok' };
};

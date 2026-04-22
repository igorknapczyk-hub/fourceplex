// netlify/functions/beata-bot.js
// FAZA 2.1: bugfix + nowe tools (artyści, koszty marketingowe, checklisty, notatki).

const Anthropic = require('@anthropic-ai/sdk');
const {
  // Read — Faza 1
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  // Read — Faza 2 / 2.1
  getGuestShow,
  getProductionShow,
  getProductionExpenses,
  getMarketingCostsForShow,
  getAllMarketingCosts,
  getArtist,
  getProjects,
  getTicketingSnapshots,
  // Write — Faza 2
  addTodo,
  updateTodoStatus,
  addTodoNote,
  updateTodo,
  addGuestToShow,
  updateProductionChecklist,
  updateMarketingCheckpoint,
  addTicketingSnapshot,
  // Write — Faza 2.1
  addArtistToWatchlist,
  updateArtistFlags,
  addMarketingCost,
  updateMarketingCost,
  updateProductionChecklistItem,
  updateProductionNotes,
  updateMarketingNotes,
} = require('./lib/firestore');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Pending actions (in-memory, TTL 10 min) ──────────────────────────────────
const pendingActions = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

const WRITE_TOOLS = new Set([
  'add_todo',
  'update_todo_status',
  'add_todo_note',
  'update_todo',
  'add_guest_to_show',
  'update_production_checklist',
  'update_marketing_checkpoint',
  'add_ticketing_snapshot',
  'add_artist_to_watchlist',
  'update_artist_flags',
  'add_marketing_cost',
  'update_marketing_cost',
  'update_production_checklist_item',
  'update_production_notes',
  'update_marketing_notes',
]);

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
- **Terrarium** — dashboard + "Jaszczurze Sprawy" (task manager)
- **Watchlist** — tracker artystów do bookingu, prognozy, trendy
- **Ticketing** — sprzedaż biletów per koncert, TM/eBilet/Inne, break even
- **Marketing** — checkpointy, koszty, Meta Ads
- **Listy Gości** — akredytacje (foto/media/rozdane)
- **Produkcja** — checklisty, koszty, timetable, rider notes
- **Promotor Office** — pipeline dealów (avails→oferta→follow-up→period→venue)
- **Projekty** — projekty specjalne

Backend: Firebase Firestore. Hosting: Netlify.

# TWOJA OSOBOWOŚĆ
- Jesteś bezpośrednia, konkretna i profesjonalna — nie owijasz w bawełnę
- Mówisz po polsku, chyba że ktoś napisze po angielsku
- Masz lekkie poczucie humoru — jesteś przyjazna, ale skupiona na robocie
- Nie jesteś nadmiernie entuzjastyczna ani nie używasz zbędnych emoji
- Jak nie wiesz — mówisz wprost że nie wiesz
- Krótkie pytania = krótkie odpowiedzi. Długie pytania = wyczerpująca odpowiedź.
- Gdy raportujesz liczby, bądź zwięzła: "Dakhabrakha: 87% (1043/1200). TM 812, eBilet 231. 🦎"

# OBECNY STAN (FAZA 2.1)
Masz dostęp do Firestore Plexa:

**Czytanie:** get_todos, get_ticketing_events, get_ticketing_event, get_artists, get_artist, get_marketing_shows, get_guest_show, get_production_show, get_production_expenses, get_marketing_costs_for_show, get_all_marketing_costs, get_projects, get_ticketing_snapshots.

**Pisanie (z potwierdzeniem):** add_todo, update_todo_status, add_todo_note, update_todo, add_guest_to_show, add_artist_to_watchlist, update_artist_flags, add_marketing_cost, update_marketing_cost, update_production_checklist_item, update_production_notes, update_marketing_notes, update_marketing_checkpoint, add_ticketing_snapshot.

WAŻNE zasady pisania:
1. Gdy user prosi o zmianę — najpierw upewnij się że masz wszystkie info. Dopytaj jeśli trzeba.
2. Gdy masz komplet — wywołaj tool. System wyświetli userowi przycisk confirm. Napisz krótko "Sprawdź niżej." lub nic.
3. Dla update_todo_status — najpierw get_todos, zidentyfikuj zadanie po tekście, pokaż userowi i dopiero wywołaj tool. Do update_todo_status przekaż też todo_text_hint = treść zadania (pierwsze 60 znaków), żeby potwierdzenie było czytelne.

# ZASADY ROZMAWIANIA O KONCERTACH I ARTYSTACH

- Używaj ZAWSZE nazw wykonawców (np. "Dakhabrakha", "Conan Gray") gdy piszesz do usera.
  NIGDY nie pokazuj userom ID dokumentów (np. "8EbGkb4c6Lrah..."). ID możesz używać wewnętrznie przy wywołaniach toolsów.

- W guest_shows koncert identyfikowany jest przez pole artistName.
  Nie szukaj po showId w guest_shows — tego pola tam nie ma.
  Lista gości jest w tablicach foto, media, rozdane bezpośrednio w dokumencie.

- W marketing_costs showId = doc ID z ticketing_events.
  Gdy user mówi o koszcie dla "Dakhabrakha", najpierw get_ticketing_event("Dakhabrakha"),
  weź doc ID jako showId.

- W artists (Watchlist) pole listeners to STRING (np. "638.3K") — nie parsuj jako number.

- Gdy tool zwraca _multipleMatches: true — pokaż userowi listę z datami i poproś o doprecyzowanie.
  Nie wywołuj write toola gdy jest wiele matchów — dopytaj najpierw.

# ZASADY POTWIERDZANIA ZMIAN

- NIE wyświetlaj ID dokumentów w komunikatach do usera. Zamiast
  "Dodać koszt do showId WWACndvxBa...?" pisz
  "Dodać koszt 1500 PLN (Druk/OOH) do koncertu Pentatonix?"

- Gdy dodajesz koszt marketingowy — zawsze podaj artistName czytelnie w confirm.

# DODAWANIE ARTYSTÓW DO WATCHLISTY

Gdy user prosi o dodanie artysty do Watchlisty, dopytaj o brakujące pola jeśli ich nie podał:
- nazwa (wymagana)
- gatunek (warto dopytać)
- monthly listeners Spotify jako string (np. "2.5M" — nie liczba, format jak na Spotify)
- notatka (kontekst, potencjał w PL, uzasadnienie — min 1-2 zdania)
- predykcja sali (pred_min, pred_max) — orientacyjnie wg skali:
  Chmury <200, Hydrozagadka 200-400, Niebo 401-700, Proxima 701-1000,
  Progresja 1001-1800, COS Torwar 1801-5000, Arena 5001+
- czy grał kiedyś solo w PL (pl_show: "NIE" albo info o miejscu i roku)
- spotify_url (opcjonalnie, jeśli user poda)

Jeśli user nie wie pred_min/pred_max — zaproponuj oszacowanie na podstawie listeners i gatunku.
Jeśli user nie wie pl_show — domyślnie "NIE" (Plex traktuje to jako "nie grał solo w PL").

Jeszcze NIE masz: kalendarza Google, pamięci między sesjami, usuwania danych, Meta Ads API, scheduled briefów.`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools = [
  // ── READ TOOLS ──
  {
    name: 'get_todos',
    description: 'Pobierz zadania z Jaszczurzych Spraw. Domyślnie zwraca otwarte.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Filtruj po osobie (Igor/Mariusz/Monika/Radek)' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_ticketing_events',
    description: 'Lista koncertów z danymi sprzedaży (TM, eBilet, %, break even).',
    input_schema: {
      type: 'object',
      properties: {
        upcoming_only: { type: 'boolean', description: 'Tylko nadchodzące' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_ticketing_event',
    description: 'Znajdź konkretny koncert po fragmencie nazwy. Zwraca pełne dane + doc ID (do użycia jako showId w marketing_costs).',
    input_schema: {
      type: 'object',
      properties: {
        name_query: { type: 'string', description: 'Fragment nazwy artysty/koncertu' },
      },
      required: ['name_query'],
    },
  },
  {
    name: 'get_artists',
    description: 'Lista artystów z Watchlisty. Filtruj hot:true żeby zobaczyć tylko "gorących".',
    input_schema: {
      type: 'object',
      properties: {
        hot: { type: 'boolean', description: 'Tylko artyści z flagą hot' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_artist',
    description: 'Znajdź konkretnego artystę po fragmencie nazwy. Zwraca pełne dane z flagami.',
    input_schema: {
      type: 'object',
      properties: {
        name_query: { type: 'string', description: 'Fragment nazwy artysty' },
      },
      required: ['name_query'],
    },
  },
  {
    name: 'get_marketing_shows',
    description: 'Dane marketingowe koncertów (budżety, CTR, CPM, checkpointy).',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_guest_show',
    description: 'Lista gości dla koncertu — szuka po nazwie artysty (polu artistName). Zwraca tablice foto/media/rozdane.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty' },
      },
      required: ['artist_name_query'],
    },
  },
  {
    name: 'get_production_show',
    description: 'Dane produkcji koncertu: checklist, timetable, rider notes.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty/koncertu' },
      },
      required: ['artist_name_query'],
    },
  },
  {
    name: 'get_production_expenses',
    description: 'Koszty produkcji dla koncertu (po showId z get_ticketing_event).',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'Doc ID z get_ticketing_event' },
      },
      required: ['show_id'],
    },
  },
  {
    name: 'get_marketing_costs_for_show',
    description: 'Koszty marketingowe dla konkretnego koncertu (po showId). Zwraca listę + total.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'Doc ID z get_ticketing_event' },
      },
      required: ['show_id'],
    },
  },
  {
    name: 'get_all_marketing_costs',
    description: 'Wszystkie koszty marketingowe (sortowane od najnowszych).',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max liczba (default 50)' } },
    },
  },
  {
    name: 'get_projects',
    description: 'Lista projektów.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_ticketing_snapshots',
    description: 'Historyczne snapshoty sprzedaży dla eventu.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Doc ID z get_ticketing_event' },
        limit: { type: 'number' },
      },
      required: ['event_id'],
    },
  },

  // ── WRITE TOOLS ──
  {
    name: 'add_todo',
    description: 'Dodaj zadanie do Jaszczurzych Spraw. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Treść zadania' },
        assignee: { type: 'string', description: 'Osoba (Igor/Mariusz/Monika/Radek)' },
        due_date: { type: 'string', description: 'Termin YYYY-MM-DD (opcjonalnie)' },
        pilne: { type: 'boolean' },
        note: { type: 'string', description: 'Notatka (opcjonalnie)' },
      },
      required: ['text', 'assignee'],
    },
  },
  {
    name: 'update_todo_status',
    description: 'Zmień status zadania. Wymaga potwierdzenia. Przekaż todo_text_hint = fragment treści zadania (do 60 znaków) żeby confirm był czytelny.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'ID zadania (z get_todos)' },
        new_status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        todo_text_hint: { type: 'string', description: 'Fragment tekstu zadania (do wyświetlenia w confirm)' },
      },
      required: ['todo_id', 'new_status'],
    },
  },
  {
    name: 'add_todo_note',
    description: 'Dopisz notatkę wykonawczą do zadania. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'ID zadania' },
        note: { type: 'string', description: 'Treść notatki' },
        todo_text_hint: { type: 'string', description: 'Fragment tekstu zadania (do confirm)' },
      },
      required: ['todo_id', 'note'],
    },
  },
  {
    name: 'update_todo',
    description: 'Zaktualizuj pola zadania. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string' },
        text: { type: 'string' },
        due_date: { type: 'string' },
        pilne: { type: 'boolean' },
        note: { type: 'string' },
        assignee: { type: 'string' },
        todo_text_hint: { type: 'string', description: 'Fragment tekstu zadania (do confirm)' },
      },
      required: ['todo_id'],
    },
  },
  {
    name: 'add_guest_to_show',
    description: 'Dodaj gościa do listy gości koncertu (foto/media/rozdane). Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty (nie ID!)' },
        list_type: { type: 'string', enum: ['foto', 'media', 'rozdane'], description: 'Typ listy' },
        guest_name: { type: 'string', description: 'Imię i nazwisko gościa' },
        guest_email: { type: 'string', description: 'Email (opcjonalnie)' },
        guest_from: { type: 'string', description: 'Skąd/organizacja (opcjonalnie)' },
        guest_tickets: { type: 'number', description: 'Liczba biletów' },
      },
      required: ['artist_name_query', 'list_type', 'guest_name', 'guest_tickets'],
    },
  },
  {
    name: 'add_artist_to_watchlist',
    description: 'Dodaj artystę do Watchlisty — trackera artystów do potencjalnego bookingu. Domyślny status: check (do weryfikacji).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nazwa wykonawcy' },
        genre: { type: 'string', description: 'Gatunek, np. "folk-pop", "electronic"' },
        listeners: { type: 'string', description: 'Monthly Spotify listeners jako string, np. "2.5M", "640K"' },
        notes: { type: 'string', description: 'Opis, kontekst, uzasadnienie, potencjał w PL' },
        spotify_url: { type: 'string', description: 'URL do profilu Spotify artysty (jeśli znany)' },
        pl_show: { type: 'string', description: 'Info o poprzednich występach w PL albo "NIE"' },
        pred_min: { type: 'number', description: 'Predykcja min frekwencji solo headliner w Warszawie' },
        pred_max: { type: 'number', description: 'Predykcja max frekwencji solo headliner w Warszawie' },
        source_tip: { type: 'string', description: 'Źródło rekomendacji (od kogo, kto polecił)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_artist_flags',
    description: 'Zaktualizuj flagi/dane artysty na Watchliście. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty' },
        hot: { type: 'boolean' },
        in_promotor: { type: 'boolean' },
        pl_checked: { type: 'boolean' },
        notes: { type: 'string' },
        genre: { type: 'string' },
        listeners: { type: 'string' },
      },
      required: ['artist_name_query'],
    },
  },
  {
    name: 'add_marketing_cost',
    description: 'Dodaj koszt marketingowy do koncertu. Wymaga potwierdzenia. showId = doc ID z get_ticketing_event.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'Doc ID z ticketing_events (z get_ticketing_event)' },
        artist_name: { type: 'string', description: 'Nazwa artysty — czytelna, do potwierdzenia' },
        amount: { type: 'number', description: 'Kwota w PLN' },
        category: { type: 'string', description: 'Kategoria (np. Druk/OOH, Social Media, PR)' },
        cost_date: { type: 'string', description: 'Data kosztu YYYY-MM-DD' },
        description: { type: 'string', description: 'Opis kosztu' },
      },
      required: ['show_id', 'artist_name', 'amount', 'category'],
    },
  },
  {
    name: 'update_marketing_cost',
    description: 'Zaktualizuj istniejący koszt marketingowy po ID dokumentu. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        cost_id: { type: 'string', description: 'ID dokumentu kosztu' },
        amount: { type: 'number' },
        category: { type: 'string' },
        cost_date: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['cost_id'],
    },
  },
  {
    name: 'update_production_checklist_item',
    description: 'Zaznacz/odznacz element checklisty produkcji. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty/koncertu' },
        item_key: { type: 'string', description: 'Klucz elementu checklisty (np. "plakaty", "rider")' },
        new_value: { description: 'Nowa wartość (true/false lub string)' },
      },
      required: ['artist_name_query', 'item_key', 'new_value'],
    },
  },
  {
    name: 'update_production_notes',
    description: 'Zaktualizuj notatki/rider notes produkcji. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        artist_name_query: { type: 'string', description: 'Fragment nazwy artysty' },
        new_notes: { type: 'string', description: 'Nowa treść notatek' },
      },
      required: ['artist_name_query', 'new_notes'],
    },
  },
  {
    name: 'update_marketing_notes',
    description: 'Zaktualizuj notatki marketingowe koncertu. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        show_name_query: { type: 'string', description: 'Fragment nazwy artysty/koncertu' },
        new_notes: { type: 'string', description: 'Nowa treść notatek' },
      },
      required: ['show_name_query', 'new_notes'],
    },
  },
  {
    name: 'update_marketing_checkpoint',
    description: 'Zaktualizuj checkpoint marketingowy koncertu (po show_id). Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'Doc ID z marketing_shows' },
        artist_name_hint: { type: 'string', description: 'Nazwa artysty (do confirm, nie do zapisu)' },
        checkpoint_key: { type: 'string' },
        new_value: { description: 'bool lub string' },
      },
      required: ['show_id', 'checkpoint_key', 'new_value'],
    },
  },
  {
    name: 'add_ticketing_snapshot',
    description: 'Dodaj ręczny snapshot sprzedaży biletów. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Doc ID z ticketing_events' },
        artist_name_hint: { type: 'string', description: 'Nazwa artysty (do confirm)' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        tm: { type: 'number' },
        eb: { type: 'number' },
        other: { type: 'number' },
      },
      required: ['event_id', 'date', 'tm', 'eb', 'other'],
    },
  },
];

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const url = `${TELEGRAM_API}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('sendMessage error:', await res.text());
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

async function sendConfirmMessage(chatId, text, actionId) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ TAK, wykonaj', callback_data: `confirm:${actionId}` },
          { text: '❌ Anuluj', callback_data: `cancel:${actionId}` },
        ]],
      },
    }),
  });
  if (!res.ok) console.error('sendConfirmMessage error:', await res.text());
}

async function answerCallbackQuery(callbackId, text = '') {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

async function editMessageText(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

// ── Confirm message builders ──────────────────────────────────────────────────

function buildConfirmText(toolName, input) {
  switch (toolName) {
    case 'add_todo': {
      let msg = `Na pewno? Dodać zadanie:\n📝 ${input.text}\n👤 ${input.assignee}`;
      if (input.due_date) msg += `\n📅 ${input.due_date}`;
      if (input.pilne) msg += `\n🔴 PILNE`;
      if (input.note) msg += `\n📌 ${input.note}`;
      return msg;
    }
    case 'update_todo_status': {
      const hint = input.todo_text_hint ? `"${input.todo_text_hint}"` : `(ID: ${input.todo_id})`;
      return `Na pewno? Zmienić status zadania ${hint} na *${input.new_status}*?`;
    }
    case 'add_todo_note': {
      const hint = input.todo_text_hint ? `"${input.todo_text_hint}"` : `(ID: ${input.todo_id})`;
      return `Na pewno? Dopisać notatkę do zadania ${hint}:\n📌 "${input.note}"`;
    }
    case 'update_todo': {
      const hint = input.todo_text_hint ? `"${input.todo_text_hint}"` : `(ID: ${input.todo_id})`;
      const changes = Object.entries(input)
        .filter(([k]) => !['todo_id', 'todo_text_hint'].includes(k))
        .map(([k, v]) => `  • ${k}: ${v}`)
        .join('\n');
      return `Na pewno? Zaktualizować zadanie ${hint}:\n${changes}`;
    }
    case 'add_guest_to_show':
      return `Na pewno? Dodać gościa do listy *${input.list_type}* — *${input.artist_name_query}*:\n👤 ${input.guest_name}\n🎫 ${input.guest_tickets} bilet(ów)${input.guest_from ? `\n📍 ${input.guest_from}` : ''}`;
    case 'add_artist_to_watchlist': {
      let msg = `Na pewno? Dodać do Watchlisty:\n🎵 *${input.name}*\n🎸 ${input.genre || '—'}`;
      if (input.listeners) msg += `\n👂 ${input.listeners}`;
      if (input.pl_show && input.pl_show !== 'NIE') msg += `\n🇵🇱 ${input.pl_show}`;
      else msg += `\n🇵🇱 Nie grał w PL`;
      if (input.pred_min || input.pred_max) msg += `\n📊 Predykcja: ${input.pred_min || 0}–${input.pred_max || 0} os.`;
      if (input.source_tip) msg += `\n💡 Tip od: ${input.source_tip}`;
      if (input.notes) msg += `\n📌 ${input.notes}`;
      return msg;
    }
    case 'update_artist_flags': {
      const changes = Object.entries(input)
        .filter(([k]) => k !== 'artist_name_query')
        .map(([k, v]) => `  • ${k}: ${v}`)
        .join('\n');
      return `Na pewno? Zaktualizować *${input.artist_name_query}*:\n${changes}`;
    }
    case 'add_marketing_cost': {
      const date = input.cost_date || 'dziś';
      return `Na pewno? Dodać koszt:\n💰 ${input.amount} PLN — ${input.category}\n🎵 Koncert: *${input.artist_name}*\n📅 ${date}${input.description ? `\n📝 ${input.description}` : ''}`;
    }
    case 'update_marketing_cost':
      return `Na pewno? Zaktualizować koszt (ID: ${input.cost_id}):\n${Object.entries(input).filter(([k]) => k !== 'cost_id').map(([k, v]) => `  • ${k}: ${v}`).join('\n')}`;
    case 'update_production_checklist_item':
      return `Na pewno? Zaktualizować checklistę produkcji:\n🎵 *${input.artist_name_query}*\n  ✓ ${input.item_key} → ${input.new_value}`;
    case 'update_production_notes':
      return `Na pewno? Zaktualizować rider notes/notatki produkcji:\n🎵 *${input.artist_name_query}*\n\n"${String(input.new_notes).slice(0, 120)}${String(input.new_notes).length > 120 ? '...' : ''}"`;
    case 'update_marketing_notes':
      return `Na pewno? Zaktualizować notatki marketingowe:\n🎵 *${input.show_name_query}*`;
    case 'update_marketing_checkpoint': {
      const name = input.artist_name_hint || input.show_id;
      return `Na pewno? Zaktualizować checkpoint marketingowy:\n🎵 *${name}*\n  ${input.checkpoint_key} → ${input.new_value}`;
    }
    case 'add_ticketing_snapshot': {
      const total = (input.tm || 0) + (input.eb || 0) + (input.other || 0);
      const name = input.artist_name_hint || input.event_id;
      return `Na pewno? Dodać snapshot sprzedaży:\n🎵 *${name}*\n📅 ${input.date}\n  TM: ${input.tm} | eBilet: ${input.eb} | Inne: ${input.other}\n📊 Total: ${total}`;
    }
    default:
      return `Na pewno wykonać akcję *${toolName}*?`;
  }
}

function describeAction(toolName, result) {
  switch (toolName) {
    case 'add_todo':         return `Zadanie "${result.text}" dodane → ${result.assignee}`;
    case 'update_todo_status': return `Status zmieniony na "${result.status}"`;
    case 'add_todo_note':    return `Notatka dopisana (łącznie: ${result.notesCount})`;
    case 'update_todo':      return `Zadanie zaktualizowane (pola: ${result.updated.join(', ')})`;
    case 'add_guest_to_show': return `Gość "${result.guestName}" dodany do listy ${result.listType} — ${result.artistName}`;
    case 'add_artist_to_watchlist': return `Dodano do Watchlisty: ${result.name}`;
    case 'update_artist_flags': return `Zaktualizowano ${result.name} (pola: ${result.updatedFields.join(', ')})`;
    case 'add_marketing_cost': return `Dodano koszt: ${result.amount} PLN dla ${result.artistName}`;
    case 'update_marketing_cost': return `Koszt zaktualizowany (pola: ${result.updatedFields.join(', ')})`;
    case 'update_production_checklist_item': return `Zaznaczono "${result.itemKey}" dla ${result.artistName}`;
    case 'update_production_notes': return `Rider notes/notatki produkcji zaktualizowane dla ${result.artistName}`;
    case 'update_marketing_notes': return `Notatki marketingowe zaktualizowane dla ${result.artistName}`;
    case 'update_marketing_checkpoint': return `Checkpoint "${result.checkpointKey}" → ${result.newValue}`;
    case 'add_ticketing_snapshot': return `Snapshot ${result.date}: total ${result.total} biletów`;
    default: return JSON.stringify(result);
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeWriteTool(toolName, input, authorName) {
  switch (toolName) {
    case 'add_todo':
      return addTodo({ text: input.text, assignee: input.assignee, dueDate: input.due_date, pilne: input.pilne, note: input.note, addedBy: authorName });
    case 'update_todo_status':
      return updateTodoStatus(input.todo_id, input.new_status);
    case 'add_todo_note':
      return addTodoNote(input.todo_id, input.note, authorName);
    case 'update_todo':
      return updateTodo(input.todo_id, { text: input.text, dueDate: input.due_date, pilne: input.pilne, note: input.note, assignee: input.assignee });
    case 'add_guest_to_show':
      return addGuestToShow(input.artist_name_query, input.list_type, {
        name: input.guest_name, email: input.guest_email, from: input.guest_from, tickets: input.guest_tickets,
      });
    case 'add_artist_to_watchlist':
      return addArtistToWatchlist({
        name: input.name,
        genre: input.genre,
        listeners: input.listeners,
        notes: input.notes,
        addedBy: authorName,
        spotifyUrl: input.spotify_url,
        plShow: input.pl_show,
        predMin: input.pred_min,
        predMax: input.pred_max,
        sourceTip: input.source_tip,
      });
    case 'update_artist_flags':
      return updateArtistFlags(input.artist_name_query, { hot: input.hot, inPromotor: input.in_promotor, plChecked: input.pl_checked, notes: input.notes, genre: input.genre, listeners: input.listeners });
    case 'add_marketing_cost':
      return addMarketingCost({ showId: input.show_id, artistName: input.artist_name, amount: input.amount, category: input.category, costDate: input.cost_date, description: input.description, addedBy: authorName });
    case 'update_marketing_cost':
      return updateMarketingCost(input.cost_id, { amount: input.amount, category: input.category, costDate: input.cost_date, description: input.description });
    case 'update_production_checklist_item':
      return updateProductionChecklistItem(input.artist_name_query, input.item_key, input.new_value);
    case 'update_production_notes':
      return updateProductionNotes(input.artist_name_query, input.new_notes);
    case 'update_marketing_notes':
      return updateMarketingNotes(input.show_name_query, input.new_notes);
    case 'update_marketing_checkpoint':
      return updateMarketingCheckpoint(input.show_id, input.checkpoint_key, input.new_value);
    case 'add_ticketing_snapshot':
      return addTicketingSnapshot(input.event_id, { date: input.date, tm: input.tm, eb: input.eb, other: input.other });
    default:
      throw new Error(`Nieznany write tool: ${toolName}`);
  }
}

async function executeTool(name, input, chatId, userId, senderName) {
  if (WRITE_TOOLS.has(name)) {
    const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingActions.set(actionId, { chatId, userId, senderName: senderName || 'Użytkownik', toolName: name, input, createdAt: Date.now() });
    await sendConfirmMessage(chatId, buildConfirmText(name, input), actionId);
    return 'Pending user confirmation. Poinformuj użytkownika że czeka na jego decyzję i przestań (zakończ turę).';
  }

  switch (name) {
    case 'get_todos':
      return getTodos({ assignee: input.assignee, status: input.status, limit: input.limit });
    case 'get_ticketing_events':
      return getTicketingEvents({ upcomingOnly: input.upcoming_only, limit: input.limit });
    case 'get_ticketing_event':
      return getTicketingEvent(input.name_query);
    case 'get_artists':
      return getArtists({ hot: input.hot, limit: input.limit });
    case 'get_artist':
      return getArtist(input.name_query);
    case 'get_marketing_shows':
      return getMarketingShows({ limit: input.limit });
    case 'get_guest_show':
      return getGuestShow(input.artist_name_query);
    case 'get_production_show':
      return getProductionShow(input.artist_name_query);
    case 'get_production_expenses':
      return getProductionExpenses(input.show_id);
    case 'get_marketing_costs_for_show':
      return getMarketingCostsForShow(input.show_id);
    case 'get_all_marketing_costs':
      return getAllMarketingCosts({ limit: input.limit });
    case 'get_projects':
      return getProjects({ limit: input.limit });
    case 'get_ticketing_snapshots':
      return getTicketingSnapshots(input.event_id, { limit: input.limit });
    default:
      throw new Error(`Nieznany tool: ${name}`);
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

const conversations = {};
const MAX_HISTORY = 20;

// ── Message handlers ──────────────────────────────────────────────────────────

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const senderName = message.from?.first_name || 'Użytkownik';
  const userId = message.from?.id;

  if (!text) return;

  if (text === '/start') {
    await sendMessage(chatId, 'Cześć! Jestem Beata — asystentka AI FOURCE. Czytam i piszę do Plexa. Czym mogę pomóc?');
    return;
  }
  if (text === '/ping') {
    await sendMessage(chatId, 'pong 🏓');
    return;
  }

  if (!conversations[chatId]) conversations[chatId] = [];

  let messages = [
    ...conversations[chatId],
    { role: 'user', content: `[Wiadomość od: ${senderName}]\n\n${text}` },
  ];
  let finalText = '';
  const MAX_ITERATIONS = 6;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (textBlocks) finalText = textBlocks;

      if (response.stop_reason !== 'tool_use') break;

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`[beata] tool_use: ${toolUse.name}`, JSON.stringify(toolUse.input));
        try {
          const result = await executeTool(toolUse.name, toolUse.input, chatId, userId, senderName);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        } catch (err) {
          console.error(`[beata] tool error (${toolUse.name}):`, err.message);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}`, is_error: true });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) finalText = '...';

    conversations[chatId].push(
      { role: 'user', content: `[Wiadomość od: ${senderName}]\n\n${text}` },
      { role: 'assistant', content: finalText }
    );
    if (conversations[chatId].length > MAX_HISTORY) {
      conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
    }

    await sendMessage(chatId, finalText);
  } catch (error) {
    console.error('[beata] Claude API error:', error);
    await sendMessage(chatId, 'Przepraszam, mam chwilowy problem techniczny. Spróbuj ponownie za chwilę.');
  }
}

async function handleCallbackQuery(cb) {
  const data = cb.data || '';
  const colonIdx = data.indexOf(':');
  const action = data.slice(0, colonIdx);
  const actionId = data.slice(colonIdx + 1);
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const senderName = cb.from?.first_name || 'Użytkownik';

  await answerCallbackQuery(cb.id);

  const pending = pendingActions.get(actionId);

  if (pending && Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingActions.delete(actionId);
    await editMessageText(chatId, messageId, '⚠️ Ta akcja wygasła. Poproś Beatę jeszcze raz.');
    return;
  }
  if (!pending) {
    await editMessageText(chatId, messageId, '⚠️ Ta akcja wygasła lub jest nieznana.');
    return;
  }

  pendingActions.delete(actionId);

  if (action === 'cancel') {
    await editMessageText(chatId, messageId, '❌ Anulowano.');
    return;
  }

  if (action === 'confirm') {
    try {
      const result = await executeWriteTool(pending.toolName, pending.input, senderName);
      await editMessageText(chatId, messageId, `✅ Zrobione: ${describeAction(pending.toolName, result)}`);
    } catch (err) {
      console.error('[beata] executeWriteTool error:', err.message);
      await editMessageText(chatId, messageId, `❌ Błąd: ${err.message}`);
    }
  }
}

// ── Netlify Function handler ──────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Beata bot działa (Faza 2.1).' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  } else if (update.message) {
    await handleMessage(update.message);
  }

  return { statusCode: 200, body: 'ok' };
};

// netlify/functions/beata-bot.js
// Faza 2.1 + optymalizacja: Haiku 4.5, prompt caching, dynamiczna data, usage logger.

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
  getUsageStats,
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
  // Usage logger
  logUsage,
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

// ── System prompt (dynamiczna data per request) ───────────────────────────────

function getSystemPrompt() {
  const now = new Date();
  const warsawNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));

  const dniTygodnia = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  const miesiace = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];

  const dzienTygodnia = dniTygodnia[warsawNow.getDay()];
  const dzien = warsawNow.getDate();
  const miesiac = miesiace[warsawNow.getMonth()];
  const rok = warsawNow.getFullYear();
  const iso = warsawNow.toISOString().slice(0, 10);
  const godzina = warsawNow.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });

  return `Jesteś Beatą — asystentką polskiej agencji koncertowej FOURCE. Zwięzła, konkretna, po polsku.

# AKTUALNA DATA I CZAS
Dziś: ${dzienTygodnia}, ${dzien} ${miesiac} ${rok} (${iso}). Godzina: ${godzina} (Warszawa).
Gdy user mówi "piątek" — rozumie najbliższy piątek (licząc od dziś). "Jutro" = dzień po ${iso}. "Za tydzień" = 7 dni od dziś. Gdy user nie precyzuje roku — zakładaj bieżący (${rok}), chyba że data już minęła — wtedy następny (${rok + 1}).
Przy zapisach do Firestore daty w formacie YYYY-MM-DD.

# ZESPÓŁ
- Igor — produkcja, IT, cyfryzacja
- Monika — ticketing, marketing assistant
- Mariusz — marketing, PR
- Radek — booking, biznes
- Kamil — grafika (nie używa Plexa, kontakt przez Monikę/Mariusza)

# FOURCE.PLEX — wewnętrzny system
Moduły i kolekcje Firestore:
- Terrarium/Todos — todos
- Ticketing — ticketing_events, ticketing_snapshots
- Watchlist — artists
- Marketing — marketing_shows, marketing_costs
- Listy Gości — guest_shows
- Produkcja — production_shows, production_expenses
- Projekty — projekty

# STYL
Konkretna, krótko, bez wstępów. Bez "Oczywiście", "chętnie pomogę". Emoji max 1-2 per wiadomość.
Raporty scheduled kończ 🦎. Krótkie odpowiedzi — nie.
Nie zmyślaj liczb. Gdy nie ma danych — użyj toola. Gdy tool zwraca null/pustkę — powiedz wprost.

# ZASADY DANYCH
- Używaj nazw wykonawców, nigdy ID dokumentów.
- guest_shows: identyfikacja przez artistName (nie showId). Goście w polu foto (array), nie subkolekcja.
- marketing_costs: showId = doc ID z ticketing_events.
- artists.listeners to STRING (np. "638.3K"), nie number.
- Gdy tool zwraca _multipleMatches: true — pokaż listę z datami, poproś o doprecyzowanie. Nie wywołuj write toola bez pewności.

# ZAPISY (z confirm)
Gdy user prosi o zmianę: dopytaj o brakujące pola, potem wywołaj tool. System sam pokaże przyciski potwierdzenia. NIE pisz "teraz poproszę o potwierdzenie" — wywołaj tool i ewentualnie krótkie "Dodaję..." lub nic.
Przy update_todo_status — najpierw get_todos, zidentyfikuj po tekście, przekaż todo_text_hint = fragment treści (do 60 znaków).
Przy datach — "na piątek" = najbliższy piątek od ${iso}. "Następny piątek" — dopytaj.

# DODAWANIE ARTYSTÓW DO WATCHLISTY
Wymagane: name. Warto dopytać: genre, listeners (string jak "2.5M"), notes, predMin/predMax (skala: Chmury<200, Hydro 200-400, Niebo 401-700, Proxima 701-1000, Progresja 1001-1800, Torwar 1801-5000, Arena 5001+), plShow (default "NIE"), spotifyUrl.

# CZEGO NIE MASZ JESZCZE
Kalendarza Google, scheduled briefów, Meta Ads, usuwania.`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools = [
  // ── READ TOOLS ──
  {
    name: 'get_todos',
    description: 'Zadania z Jaszczurzych Spraw (domyślnie otwarte).',
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
    description: 'Lista koncertów + sprzedaż biletów.',
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
    description: 'Konkretny koncert po nazwie — zwraca też doc ID (jako showId w kosztach).',
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
    description: 'Artyści z Watchlisty. hot:true = tylko gorący.',
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
    description: 'Konkretny artysta po fragmencie nazwy.',
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
    description: 'Dane marketingowe koncertów (budżety, CTR, checkpointy).',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_guest_show',
    description: 'Lista gości koncertu (foto/media/rozdane) po nazwie artysty.',
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
    description: 'Dane produkcji: checklist, timetable, rider notes.',
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
    description: 'Koszty produkcji (po showId z get_ticketing_event).',
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
    description: 'Koszty marketingowe + total dla koncertu (po showId).',
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
    description: 'Wszystkie koszty marketingowe (od najnowszych).',
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
    description: 'Historyczne snapshoty sprzedaży eventu.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Doc ID z get_ticketing_event' },
        limit: { type: 'number' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_usage_stats',
    description: 'Statystyki zużycia Beaty: koszty, tokeny, per user i dzień.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Ile dni wstecz (default 7)' },
      },
    },
  },

  // ── WRITE TOOLS ──
  {
    name: 'add_todo',
    description: 'Dodaj zadanie. Wymaga potwierdzenia.',
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
    description: 'Zmień status zadania. Wymaga potwierdzenia.',
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
    description: 'Dopisz notatkę do zadania. Wymaga potwierdzenia.',
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
    description: 'Dodaj gościa do listy gości (foto/media/rozdane). Wymaga potwierdzenia.',
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
    description: 'Dodaj artystę do Watchlisty (status: check). Wymaga potwierdzenia.',
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
    description: 'Dodaj koszt marketingowy. showId z get_ticketing_event. Wymaga potwierdzenia.',
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
    description: 'Zaktualizuj istniejący koszt marketingowy po ID. Wymaga potwierdzenia.',
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
    description: 'Zaktualizuj rider notes/notatki produkcji. Wymaga potwierdzenia.',
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
    description: 'Zaktualizuj notatki marketingowe. Wymaga potwierdzenia.',
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
    description: 'Zaktualizuj checkpoint marketingowy (po show_id). Wymaga potwierdzenia.',
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
    cache_control: { type: 'ephemeral' },
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
    case 'get_usage_stats':
      return getUsageStats({ days: input.days });
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

  // Wylicz prompt raz per request (świeża data, cache ephemeral ~5 min)
  const systemPrompt = getSystemPrompt();

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools,
        messages,
      });

      // Usage logger — fire-and-forget, nie blokuje odpowiedzi
      if (response.usage) {
        logUsage({
          chatId,
          userName: senderName,
          model: response.model,
          inputTokens: response.usage.input_tokens || 0,
          outputTokens: response.usage.output_tokens || 0,
          cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
          stopReason: response.stop_reason,
        }).catch(err => console.error('logUsage failed:', err));
      }

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
    return { statusCode: 200, body: 'Beata bot działa (Faza 2.1 + Haiku).' };
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

// netlify/functions/beata-bot.js
// FAZA 2: Beata z tool use — czytanie + zapis do Firestore (z confirm buttons).

const Anthropic = require('@anthropic-ai/sdk');
const {
  // Faza 1 — read
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  // Faza 2D — nowe read
  getGuestShow,
  getProductionShow,
  getProductionExpenses,
  getMarketingCosts,
  getProjects,
  getTicketingSnapshots,
  // Faza 2C — write
  addTodo,
  updateTodoStatus,
  addTodoNote,
  updateTodo,
  addGuestToShow,
  updateProductionChecklist,
  updateMarketingCheckpoint,
  addTicketingSnapshot,
} = require('./lib/firestore');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Pending actions (in-memory, TTL 10 min) ──────────────────────────────────
// { actionId → { chatId, userId, senderName, toolName, input, createdAt } }
const pendingActions = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

// Zbiór nazw toolsów zapisujących
const WRITE_TOOLS = new Set([
  'add_todo',
  'update_todo_status',
  'add_todo_note',
  'update_todo',
  'add_guest_to_show',
  'update_production_checklist',
  'update_marketing_checkpoint',
  'add_ticketing_snapshot',
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
Hub webowy z modułami:
- **Terrarium** (index.html) — dashboard + "Jaszczurze Sprawy" (task manager zespołu)
- **Watchlist** (watchlist.html) — tracker artystów do bookingu, prognozy, trendy
- **Ticketing** (ticketing.html) — sprzedaż biletów per koncert, kanały TM/eBilet/Inne, break even
- **Marketing** (marketing.html) — koncerty, checkpointy marketingowe, koszty, Meta Ads
- **Listy Gości** (listy-gosci.html) — akredytacje, goście, foto, media
- **Produkcja** (produkcja.html) — checklisty, koszty, timetable, rider notes
- **Promotor Office** (promotor-office.html) — pipeline dealów (avails→oferta→follow-up→period→venue)
- **Projekty** (projekty.html) — projekty specjalne

Backend: Firebase Firestore. Hosting: Netlify.

# TWOJA OSOBOWOŚĆ
- Jesteś bezpośrednia, konkretna i profesjonalna — nie owijasz w bawełnę
- Mówisz po polsku, chyba że ktoś napisze po angielsku
- Masz lekkie poczucie humoru — jesteś przyjazna, ale skupiona na robocie
- Nie jesteś nadmiernie entuzjastyczna ani nie używasz zbędnych emoji
- Jak nie wiesz — mówisz wprost że nie wiesz
- Krótkie pytania = krótkie odpowiedzi. Długie pytania = wyczerpująca odpowiedź.

# OBECNY STAN (FAZA 2)
Masz dostęp do Firestore Plexa:

**Czytanie (dowolnie):** get_todos, get_ticketing_events, get_ticketing_event, get_artists, get_marketing_shows, get_guest_show, get_production_show, get_production_expenses, get_marketing_costs, get_projects, get_ticketing_snapshots.

**Pisanie (z potwierdzeniem użytkownika):** add_todo, update_todo_status, add_todo_note, update_todo, add_guest_to_show, update_production_checklist, update_marketing_checkpoint, add_ticketing_snapshot.

WAŻNE zasady pisania:
1. Gdy user prosi o zmianę (dodaj zadanie, zamknij, zaktualizuj) — najpierw upewnij się że masz wszystkie potrzebne info. Dopytaj jeśli trzeba (np. "Przypisać do kogo?", "Na kiedy termin?").
2. Gdy masz komplet — wywołaj odpowiedni tool. System wyświetli userowi przycisk potwierdzenia. NIE powtarzaj tej informacji — nie pisz "teraz poproszę o potwierdzenie". Po prostu wywołaj tool i milcz albo napisz krótko "Dodaję... (potwierdź niżej)".
3. Nie przypuszczaj — pytaj. Jeśli user mówi "dodaj zadanie do produkcji" — zapytaj kto ma to zrobić.
4. Dla update_todo_status — najpierw znajdź zadanie przez get_todos, zidentyfikuj po tekście, pokaż userowi które zadanie zamierzasz zmienić, wywołaj tool.

Gdy raportujesz dane liczbowe, bądź zwięzła. Przykład:
"Dakhabrakha: 87% (1043/1200), break even przekroczony. TM 812, eBilet 231. 🦎"

Jeszcze NIE masz: kalendarza Google, pamięci między sesjami, usuwania danych, scheduled briefów.`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools = [
  // ── READ TOOLS ──
  {
    name: 'get_todos',
    description: 'Pobierz zadania z Jaszczurzych Spraw (task manager zespołu). Domyślnie zwraca otwarte zadania.',
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
    description: 'Pobierz listę koncertów z danymi sprzedaży (TM, eBilet, %, break even).',
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
    description: 'Znajdź konkretny koncert po nazwie (fragment wystarczy).',
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
    description: 'Pobierz artystów z Watchlisty — tracker do potencjalnego bookingu.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_marketing_shows',
    description: 'Pobierz dane marketingowe koncertów (budżety, CTR, CPM, reach, checkpointy).',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_guest_show',
    description: 'Pobierz listę gości dla koncertu (fragment nazwy wystarczy).',
    input_schema: {
      type: 'object',
      properties: {
        show_name_query: { type: 'string', description: 'Fragment nazwy koncertu' },
      },
      required: ['show_name_query'],
    },
  },
  {
    name: 'get_production_show',
    description: 'Pobierz dane produkcji koncertu: checklist, timetable, rider notes.',
    input_schema: {
      type: 'object',
      properties: {
        show_name_query: { type: 'string', description: 'Fragment nazwy koncertu' },
      },
      required: ['show_name_query'],
    },
  },
  {
    name: 'get_production_expenses',
    description: 'Pobierz koszty produkcji dla concertu (po showId).',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'ID koncertu' },
      },
      required: ['show_id'],
    },
  },
  {
    name: 'get_marketing_costs',
    description: 'Pobierz koszty marketingowe dla koncertu (po showId).',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'ID koncertu' },
      },
      required: ['show_id'],
    },
  },
  {
    name: 'get_projects',
    description: 'Pobierz listę projektów z Projektów.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_ticketing_snapshots',
    description: 'Pobierz historyczne snapshoty sprzedaży dla konkretnego eventu.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'ID eventu z get_ticketing_event' },
        limit: { type: 'number', description: 'Max liczba snapshotów (default 12)' },
      },
      required: ['event_id'],
    },
  },

  // ── WRITE TOOLS ──
  {
    name: 'add_todo',
    description: 'Dodaj nowe zadanie do Jaszczurzych Spraw. Wymaga potwierdzenia użytkownika.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Treść zadania' },
        assignee: { type: 'string', description: 'Osoba odpowiedzialna (Igor/Mariusz/Monika/Radek)' },
        due_date: { type: 'string', description: 'Termin w formacie YYYY-MM-DD (opcjonalnie)' },
        pilne: { type: 'boolean', description: 'Czy zadanie jest pilne' },
        note: { type: 'string', description: 'Dodatkowa notatka (opcjonalnie)' },
      },
      required: ['text', 'assignee'],
    },
  },
  {
    name: 'update_todo_status',
    description: 'Zmień status zadania (todo/doing/done). Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'ID zadania (z get_todos)' },
        new_status: { type: 'string', enum: ['todo', 'doing', 'done'] },
      },
      required: ['todo_id', 'new_status'],
    },
  },
  {
    name: 'add_todo_note',
    description: 'Dopisz notatkę wykonawczą do istniejącego zadania. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'ID zadania' },
        note: { type: 'string', description: 'Treść notatki' },
      },
      required: ['todo_id', 'note'],
    },
  },
  {
    name: 'update_todo',
    description: 'Zaktualizuj pola zadania (tekst, termin, priorytet, przypisanie). Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'ID zadania' },
        text: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        pilne: { type: 'boolean' },
        note: { type: 'string' },
        assignee: { type: 'string' },
      },
      required: ['todo_id'],
    },
  },
  {
    name: 'add_guest_to_show',
    description: 'Dodaj gościa do listy gości koncertu. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'ID koncertu (z get_guest_show)' },
        name: { type: 'string', description: 'Imię i nazwisko gościa' },
        tickets: { type: 'number', description: 'Liczba biletów' },
        media: { type: 'string', description: 'Media/rola gościa (opcjonalnie)' },
      },
      required: ['show_id', 'name', 'tickets'],
    },
  },
  {
    name: 'update_production_checklist',
    description: 'Zaktualizuj element checklisty produkcji. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string', description: 'ID koncertu' },
        item_key: { type: 'string', description: 'Klucz elementu checklisty' },
        new_status: { description: 'Nowy status (true/false lub string)' },
      },
      required: ['show_id', 'item_key', 'new_status'],
    },
  },
  {
    name: 'update_marketing_checkpoint',
    description: 'Zaktualizuj checkpoint marketingowy koncertu. Wymaga potwierdzenia.',
    input_schema: {
      type: 'object',
      properties: {
        show_id: { type: 'string' },
        checkpoint_key: { type: 'string', description: 'Klucz w obiekcie checkpoints' },
        new_value: { description: 'Nowa wartość (bool lub string)' },
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
        event_id: { type: 'string', description: 'ID eventu (z get_ticketing_event)' },
        date: { type: 'string', description: 'Data snapshota YYYY-MM-DD' },
        tm: { type: 'number', description: 'Sprzedane przez TicketMaster' },
        eb: { type: 'number', description: 'Sprzedane przez eBilet' },
        other: { type: 'number', description: 'Inne kanały' },
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
    // Fallback bez markdown
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

async function sendConfirmMessage(chatId, text, actionId) {
  const url = `${TELEGRAM_API}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ TAK, wykonaj', callback_data: `confirm:${actionId}` },
        { text: '❌ Anuluj', callback_data: `cancel:${actionId}` },
      ]],
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('sendConfirmMessage error:', await res.text());
  }
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

async function editMessageReplyMarkup(chatId, messageId, replyMarkup = {}) {
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
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
    case 'update_todo_status':
      return `Na pewno? Zmienić status zadania na *${input.new_status}*?\nID: \`${input.todo_id}\``;
    case 'add_todo_note':
      return `Na pewno? Dopisać notatkę do zadania \`${input.todo_id}\`:\n📌 "${input.note}"`;
    case 'update_todo': {
      const changes = Object.entries(input)
        .filter(([k]) => k !== 'todo_id')
        .map(([k, v]) => `  • ${k}: ${v}`)
        .join('\n');
      return `Na pewno? Zaktualizować zadanie \`${input.todo_id}\`:\n${changes}`;
    }
    case 'add_guest_to_show':
      return `Na pewno? Dodać gościa do listy:\n👤 ${input.name}\n🎫 ${input.tickets} bilet(ów)\n📺 ${input.media || '—'}`;
    case 'update_production_checklist':
      return `Na pewno? Zaktualizować checklistę produkcji:\n📋 Koncert: \`${input.show_id}\`\n  ${input.item_key} → ${input.new_status}`;
    case 'update_marketing_checkpoint':
      return `Na pewno? Zaktualizować checkpoint marketingowy:\n📊 Koncert: \`${input.show_id}\`\n  ${input.checkpoint_key} → ${input.new_value}`;
    case 'add_ticketing_snapshot': {
      const total = (input.tm || 0) + (input.eb || 0) + (input.other || 0);
      return `Na pewno? Dodać snapshot sprzedaży:\n🎫 Event: \`${input.event_id}\`\n📅 Data: ${input.date}\n  TM: ${input.tm} | eBilet: ${input.eb} | Inne: ${input.other}\n📊 Total: ${total}`;
    }
    default:
      return `Na pewno wykonać akcję *${toolName}*?`;
  }
}

function describeAction(toolName, result) {
  switch (toolName) {
    case 'add_todo':
      return `Zadanie "${result.text}" dodane i przypisane do ${result.assignee}`;
    case 'update_todo_status':
      return `Status zadania zmieniony na "${result.status}"`;
    case 'add_todo_note':
      return `Notatka dopisana (łącznie notatek: ${result.notesCount})`;
    case 'update_todo':
      return `Zadanie zaktualizowane (pola: ${result.updated.join(', ')})`;
    case 'add_guest_to_show':
      return `Gość "${result.guestName}" dodany do listy`;
    case 'update_production_checklist':
      return `Checklist "${result.itemKey}" → ${result.newStatus}`;
    case 'update_marketing_checkpoint':
      return `Checkpoint "${result.checkpointKey}" → ${result.newValue}`;
    case 'add_ticketing_snapshot':
      return `Snapshot z ${result.date}: total ${result.total} biletów`;
    default:
      return JSON.stringify(result);
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────

/**
 * Wykonaj write tool po potwierdzeniu przez usera.
 */
async function executeWriteTool(toolName, input, authorName) {
  switch (toolName) {
    case 'add_todo':
      return addTodo({
        text: input.text,
        assignee: input.assignee,
        dueDate: input.due_date,
        pilne: input.pilne,
        note: input.note,
        addedBy: authorName,
      });
    case 'update_todo_status':
      return updateTodoStatus(input.todo_id, input.new_status);
    case 'add_todo_note':
      return addTodoNote(input.todo_id, input.note, authorName);
    case 'update_todo':
      return updateTodo(input.todo_id, {
        text: input.text,
        dueDate: input.due_date,
        pilne: input.pilne,
        note: input.note,
        assignee: input.assignee,
        assignees: input.assignees,
      });
    case 'add_guest_to_show':
      return addGuestToShow(input.show_id, {
        name: input.name,
        tickets: input.tickets,
        media: input.media,
      });
    case 'update_production_checklist':
      return updateProductionChecklist(input.show_id, input.item_key, input.new_status);
    case 'update_marketing_checkpoint':
      return updateMarketingCheckpoint(input.show_id, input.checkpoint_key, input.new_value);
    case 'add_ticketing_snapshot':
      return addTicketingSnapshot(input.event_id, {
        date: input.date,
        tm: input.tm,
        eb: input.eb,
        other: input.other,
      });
    default:
      throw new Error(`Nieznany write tool: ${toolName}`);
  }
}

/**
 * Główny router toolsów.
 * Write tools → pending action + confirm message.
 * Read tools → wywołaj bezpośrednio.
 */
async function executeTool(name, input, chatId, userId, senderName) {
  // WRITE — nie wykonuj, stwórz pending action
  if (WRITE_TOOLS.has(name)) {
    const actionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingActions.set(actionId, {
      chatId,
      userId,
      senderName: senderName || 'Użytkownik',
      toolName: name,
      input,
      createdAt: Date.now(),
    });
    const confirmText = buildConfirmText(name, input);
    await sendConfirmMessage(chatId, confirmText, actionId);
    return 'Pending user confirmation. Poinformuj użytkownika że czeka na jego decyzję i przestań (zakończ turę).';
  }

  // READ
  switch (name) {
    case 'get_todos':
      return getTodos({ assignee: input.assignee, status: input.status, limit: input.limit });
    case 'get_ticketing_events':
      return getTicketingEvents({ upcomingOnly: input.upcoming_only, limit: input.limit });
    case 'get_ticketing_event':
      return getTicketingEvent(input.name_query);
    case 'get_artists':
      return getArtists({ status: input.status, limit: input.limit });
    case 'get_marketing_shows':
      return getMarketingShows({ limit: input.limit });
    case 'get_guest_show':
      return getGuestShow(input.show_name_query);
    case 'get_production_show':
      return getProductionShow(input.show_name_query);
    case 'get_production_expenses':
      return getProductionExpenses(input.show_id);
    case 'get_marketing_costs':
      return getMarketingCosts(input.show_id);
    case 'get_projects':
      return getProjects({ limit: input.limit });
    case 'get_ticketing_snapshots':
      return getTicketingSnapshots(input.event_id, { limit: input.limit });
    default:
      throw new Error(`Nieznany tool: ${name}`);
  }
}

// ── In-memory conversation history ───────────────────────────────────────────

const conversations = {};
const MAX_HISTORY = 20;

// ── Handlers ─────────────────────────────────────────────────────────────────

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

  const userMessage = {
    role: 'user',
    content: `[Wiadomość od: ${senderName}]\n\n${text}`,
  };
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

      const textBlocks = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
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
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) finalText = '...';

    // Zapisz tylko text exchange w historii (bez tool_use/tool_result bloków)
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

  // Zawsze odpowiedz — usuwa spinner
  await answerCallbackQuery(cb.id);

  const pending = pendingActions.get(actionId);

  // Sprawdź TTL
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
      const desc = describeAction(pending.toolName, result);
      await editMessageText(chatId, messageId, `✅ Zrobione: ${desc}`);
    } catch (err) {
      console.error('[beata] executeWriteTool error:', err.message);
      await editMessageText(chatId, messageId, `❌ Błąd: ${err.message}`);
    }
  }
}

// ── Netlify Function handler ──────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Beata bot działa (Faza 2).' };
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

  // Telegram wymaga 200 OK — zawsze
  return { statusCode: 200, body: 'ok' };
};

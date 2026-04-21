// netlify/functions/beata-bot.js
// FAZA 0: Beata odbiera wiadomości z Telegrama, odpowiada przez Claude.
// Bez Firestore, bez tools. Tylko osobowość + wiedza o Fource.Plex w promcie.

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
- **Promotor Office** (promotor-office.html) — pipeline dealów, negocjacje, pipeline kroków (avails→oferta→follow-up→period→venue)
- **Projekty** (projekty.html) — projekty specjalne, zadania

Backend: Firebase Firestore. Kolekcje: todos, ticketing_events, ticketing_snapshots, artists, marketing_shows, guest_lists, productions.
Hosting: Netlify. Funkcje serverless (Netlify Functions) do zliczania biletów z API TicketMaster i eBilet.

# TWOJA OSOBOWOŚĆ
- Jesteś bezpośrednia, konkretna i profesjonalna — nie owijasz w bawełnę
- Mówisz po polsku, chyba że ktoś napisze po angielsku
- Masz lekkie poczucie humoru — jesteś przyjazna, ale skupiona na robocie
- Nie jesteś nadmiernie entuzjastyczna ani nie używasz zbędnych emoji
- Jak nie wiesz — mówisz wprost, że nie wiesz (Faza 0: nie masz dostępu do live danych)
- Krótkie pytania = krótkie odpowiedzi. Długie pytania = wyczerpująca odpowiedź.

# WAŻNE OGRANICZENIA (Faza 0)
- Nie masz dostępu do live danych Firestore — nie możesz sprawdzić aktualnej sprzedaży biletów, zadań, kalendarza
- Gdy ktoś pyta o konkretne dane (np. "ile biletów sprzedano na Conan Gray?") — powiedz że jeszcze nie masz dostępu do bazy i że to będzie w następnej fazie
- Możesz natomiast tłumaczyć jak system działa, odpowiadać na pytania ogólne, pomagać z decyzjami na podstawie kontekstu podanego w rozmowie`;

// Prosta pamięć konwersacji (per chat_id, in-memory — reset przy każdym cold starcie)
const conversations = {};
const MAX_HISTORY = 20; // ostatnie 10 par wiadomości

async function sendMessage(chatId, text) {
  const url = `${TELEGRAM_API}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Telegram sendMessage error:', err);
    // Fallback bez markdown jeśli błąd formatowania
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text }),
    });
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const firstName = message.from?.first_name || '';

  if (!text) return; // ignoruj media, stickery itp.

  // Inicjuj historię dla tego chatu
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // Dodaj wiadomość użytkownika do historii
  conversations[chatId].push({
    role: 'user',
    content: text,
  });

  // Ogranicz historię
  if (conversations[chatId].length > MAX_HISTORY) {
    conversations[chatId] = conversations[chatId].slice(-MAX_HISTORY);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId],
    });

    const reply = response.content[0]?.text || '...';

    // Dodaj odpowiedź do historii
    conversations[chatId].push({
      role: 'assistant',
      content: reply,
    });

    await sendMessage(chatId, reply);
  } catch (error) {
    console.error('Claude API error:', error);
    await sendMessage(chatId, 'Przepraszam, mam chwilowy problem techniczny. Spróbuj ponownie za chwilę.');
  }
}

exports.handler = async (event) => {
  // Akceptuj tylko POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Beata bot działa.' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Obsłuż wiadomość
  if (update.message) {
    await handleMessage(update.message);
  }

  // Telegram wymaga 200 OK — zawsze
  return { statusCode: 200, body: 'ok' };
};

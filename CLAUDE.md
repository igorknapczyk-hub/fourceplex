# Fource.Plex — kontekst projektu dla Claude Code

## Stack
- **Frontend:** vanilla HTML/JS (bez frameworka)
- **Backend:** Vercel Functions (`api/` — pliki `.js`)
- **Hosting:** Vercel Pro — `fourceplex.vercel.app`
- **Baza danych:** Firebase Firestore (projekt: `fourceplex-market`)
- **AI:** Anthropic API przez `/api/claude` (proxy) — model `claude-sonnet-4-6`
- **Auth:** Google OAuth — tylko @fource.com; PROMOTOR_USERS=['Radek','Igor']
- **Repo:** `igorknapczyk-hub/fourceplex` (GitHub)

## Workflow programisty (KRYTYCZNE)
- Pliki wgrywane ręcznie przez GitHub web interface
- Prompty do Code muszą być **wąskie i precyzyjne**: dokładny fragment do znalezienia, dokładne zastąpienie, weryfikacja grep
- Szerokie prompty psują kod
- Po każdym zadaniu: weryfikacja grep, potem commit
- Po każdym commicie: `/clear` w Claude Code

## Moduły — pliki HTML

### index.html — Terrarium (dashboard / centrum zadań)
- Główny hub agencji: zadania (todo), notatki, powiadomienia
- Powiadomienia w nawigacji: notif-todo, notif-notes, notif-wtoku, notif-zlecone
- Pillsy zadań: filtry, assignee, pilne, daty, linki do Drive

### watchlist.html — Watchlist artystów
- Baza artystów do obserwacji i oceny potencjału bookingowego
- Firestore: kolekcje `artists`, `users`
- AI: `autoFill()` — web search (max_uses:3, max_tokens:1500) — research artysty
- AI: `aiDiscover()` — odkrywanie nowych artystów
- Pola artysty: genre, similar, listeners, predMin/predMax, predictReasoning,
  notes, plShow, spotifyUrl
- PROMOTOR_USERS mają dostęp do autoFill i edycji

### ticketing.html — Ticketing
- Śledzenie sprzedaży biletów dla aktywnych koncertów
- Firestore: `ticketing_events`, `ticketing_snapshots`
- Statystyki: aktywne eventy, sprzedaż łączna, średnia, sold-out, alerty 5%/10%
- Kanały sprzedaży: TicketMaster (TM), eBilet, Frisco i inne
- Zewnętrzny link do TM1 Ticketmaster w nawigacji
- Brak wywołań Claude API

### marketing.html — Marketing
- Planowanie i rozliczanie kosztów marketingowych dla showów
- Firestore: `marketing_shows`, `marketing_costs`
- Zakładki: aktywne / archiwum
- AI: czat marketingowy (Sonnet 4.6, max_tokens:1000) — strategia targetowania,
  analiza fanbase, grupy dotarcia; historia konwersacji w aiHistory[]
- System prompt: strateg marketingu muzycznego FOURCE

### produkcja.html — Produkcja
- Zarządzanie produkcją showów (checkpointy, budżet, logistyka)
- Zakładki: aktywne / archiwum; panel szczegółów po prawej (slide-panel)
- Pola produkcji: backline, hospitality, dinner, curfews, merch i in.
- Brak wywołań Claude API

### listy-gosci.html — Listy Gości
- Zarządzanie listami gości i wejściówkami (comps) dla showów
- Firestore: `guest_shows`, `guests`
- Funkcje: inline editing gości, flush do Firestore, trailing empty row
- Typy wejść: koncert, media, foto, VIP i inne
- Brak wywołań Claude API

### promotor-office.html — Promotor Office
- Moduł tylko dla PROMOTOR_USERS (Radek, Igor) — access denied dla innych
- Zarządzanie relacjami z artystami: avails, oferty, followup, status negocjacji
- Firestore: `artists`, `todos`
- Statusy: progress, done, wtoku, zrobione, zablokowane
- Venue reference, predykcja sal, notatki z auto-save
- Brak wywołań Claude API

### login.html — Logowanie
- Google OAuth popup, restrykcja do @fource.com (hd:'fource.com')
- Po zalogowaniu redirect do index.html

## Wspólne elementy (każdy moduł)
- `fourceplex-auth.js` — wspólny moduł auth (Firebase)
- `fourceplex-theme.css` — motyw (dark/light, CSS vars)
- Nawigacja z powiadomieniami (notif-todo, notif-notes, notif-wtoku, notif-zlecone)
- Firebase compat SDK 9.23.0
- firebaseConfig: projektId `fourceplex-market`

## Backend — api/
- `claude.js` — czyste proxy do Anthropic API; przepuszcza body w całości
  (w tym cache_control, beta headers); loguje data.usage (planowane)
- `beata-bot.js` — bot Telegram WYŁĄCZONY (`return res.status(200).send('ok')`
  na początku handlera)

## Stan projektu
- Migracja Netlify → Vercel: zakończona
- Google OAuth: wdrożony
- Seed data: usunięty
- Beata: wyłączona

## Backlog
- Zabezpieczenie `/api/claude`: whitelist modeli, limit max_tokens, x-fource-key
- Log `usage` tokenów w `api/claude.js`
- Firestore security rules
- Skrócenie tekstowej odpowiedzi autoFill (notes 1 zd., predictReasoning 2-3 zd.)
- Przekierowanie webhooka Telegrama Beaty na Vercel
- Reprojekt pillsów zadań w Terrarium

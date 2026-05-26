# Fource.Plex — kontekst projektu dla Claude Code

## Stack
- **Frontend:** vanilla HTML/JS (bez frameworka)
- **Backend:** Vercel Functions (`api/` — pliki `.js`)
- **Hosting:** Vercel Pro — `fourceplex.vercel.app`
- **Baza danych:** Firebase Firestore (`fourceplex-market`)
- **AI:** Anthropic API przez `/api/claude` (proxy)
- **Auth:** Google OAuth — tylko @fource.com
- **Repo:** `igorknapczyk-hub/fourceplex` (GitHub)

## Struktura plików
```
index.html          — Terrarium (dashboard)
watchlist.html      — Watchlist artystów
ticketing.html
marketing.html
produkcja.html
listy-gosci.html
projekty.html
promotor-office.html
login.html
fourceplex-auth.js  — wspólny moduł auth
fourceplex-theme.css
api/
  claude.js         — proxy do Anthropic API
  beata-bot.js      — bot Telegram (WYŁĄCZONY)
```

## Workflow programisty (KRYTYCZNE)
- Pliki wgrywane ręcznie przez GitHub web interface
- Prompty do Code muszą być **wąskie i precyzyjne**: dokładny fragment do znalezienia, dokładne zastąpienie, weryfikacja grep
- Szerokie prompty psują kod
- Po każdym zadaniu: weryfikacja grep, potem commit

## Model AI
- Aktualny model: `claude-sonnet-4-6` (nie zmieniaj na inny bez instrukcji)
- Endpoint: `/api/claude` — aktualnie otwarte proxy, zabezpieczenie planowane

## Stan projektu
- Migracja Netlify → Vercel: zakończona
- Google OAuth: wdrożony
- Seed data: usunięty
- Beata (bot Telegram): wyłączona — `api/beata-bot.js` ma `return res.status(200).send('ok')` na początku handlera

## Rzeczy do zrobienia (backlog)
- Zabezpieczenie `/api/claude`: whitelist modeli, limit max_tokens, sekret x-fource-key
- Log `usage` tokenów w `api/claude.js`
- Firestore security rules (punkt 3)
- Przekierowanie webhooka Telegrama Beaty na Vercel
- Reprojekt pillsów zadań w Terrarium

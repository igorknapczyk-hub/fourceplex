// netlify/functions/lib/firestore.js
// Helpery do czytania Firestore dla Beaty (i przyszłych scheduled functions).
// TYLKO ODCZYT — żadnych operacji zapisu (add/set/update/delete).

const admin = require('firebase-admin');

// Singleton init — nie duplikuj przy warm startach
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'fourceplex-market',
  });
}

const db = admin.firestore();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Konwertuj dokument Firestore na czysty JS object.
 * - Timestampy → ISO string
 * - DocumentReference → path string (np. "ticketing_events/abc123")
 * - Reszta bez zmian
 */
function convertDoc(doc) {
  const data = doc.data();
  if (!data) return null;
  const result = { id: doc.id };
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (typeof value.toDate === 'function') {
      // Firestore Timestamp
      result[key] = value.toDate().toISOString();
    } else if (value && value.constructor && value.constructor.name === 'DocumentReference') {
      result[key] = value.path;
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item.toDate === 'function' ? item.toDate().toISOString() : item
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function todayString() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Pobierz zadania z Jaszczurzych Spraw.
 * Domyślnie: otwarte (done: false), limit 50, posortowane po createdAt malejąco.
 * @param {{ assignee?: string, status?: 'todo'|'doing'|'done', limit?: number }} opts
 */
async function getTodos({ assignee, status, limit = 50 } = {}) {
  try {
    let q = db.collection('todos');

    if (status === 'done') {
      q = q.where('done', '==', true);
    } else if (status) {
      // 'todo' lub 'doing' — otwarte + konkretny status
      q = q.where('done', '==', false).where('status', '==', status);
    } else {
      // domyślnie: tylko otwarte
      q = q.where('done', '==', false);
    }

    if (assignee) {
      // assignees to tablica stringów; assignee to legacy string
      // Firestore nie pozwala na dwa array-contains naraz, używamy assignee string field
      // jako fallback — jeśli model zmienił się na tablicę, sprawdź oba pola
      q = q.where('assignees', 'array-contains', assignee);
    }

    q = q.orderBy('createdAt', 'desc').limit(limit);
    const snap = await q.get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    // Fallback jeśli composite index nie istnieje — pobierz wszystko i filtruj w JS
    console.warn('getTodos index fallback:', err.message);
    const snap = await db.collection('todos').limit(200).get();
    let docs = snap.docs.map(convertDoc).filter(Boolean);

    if (status === 'done') {
      docs = docs.filter(d => d.done === true);
    } else {
      docs = docs.filter(d => !d.done);
      if (status) docs = docs.filter(d => d.status === status);
    }
    if (assignee) {
      docs = docs.filter(d =>
        (Array.isArray(d.assignees) && d.assignees.includes(assignee)) ||
        d.assignee === assignee
      );
    }
    return docs.slice(0, limit);
  }
}

/**
 * Pobierz listę koncertów z danymi sprzedaży.
 * @param {{ limit?: number, upcomingOnly?: boolean }} opts
 */
async function getTicketingEvents({ limit = 20, upcomingOnly = false } = {}) {
  try {
    let q = db.collection('ticketing_events');

    if (upcomingOnly) {
      q = q.where('date', '>=', todayString());
    }

    q = q.orderBy('date', 'asc').limit(limit);
    const snap = await q.get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.warn('getTicketingEvents fallback:', err.message);
    const snap = await db.collection('ticketing_events').limit(100).get();
    let docs = snap.docs.map(convertDoc).filter(Boolean);
    if (upcomingOnly) {
      const today = todayString();
      docs = docs.filter(d => d.date >= today);
    }
    docs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return docs.slice(0, limit);
  }
}

/**
 * Znajdź konkretny koncert po fragmencie nazwy (case-insensitive).
 * @param {string} nameQuery
 */
async function getTicketingEvent(nameQuery) {
  try {
    const snap = await db.collection('ticketing_events').get();
    const query = nameQuery.toLowerCase().trim();
    const docs = snap.docs.map(convertDoc).filter(Boolean);
    const match = docs.find(d => (d.name || '').toLowerCase().includes(query));
    return match || null;
  } catch (err) {
    console.error('getTicketingEvent error:', err.message);
    return null;
  }
}

/**
 * Pobierz artystów z Watchlisty.
 * @param {{ status?: string, limit?: number }} opts
 */
async function getArtists({ status, limit = 30 } = {}) {
  try {
    let q = db.collection('artists');
    if (status) {
      q = q.where('status', '==', status);
    }
    q = q.limit(limit);
    const snap = await q.get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.warn('getArtists fallback:', err.message);
    const snap = await db.collection('artists').limit(100).get();
    let docs = snap.docs.map(convertDoc).filter(Boolean);
    if (status) docs = docs.filter(d => d.status === status);
    return docs.slice(0, limit);
  }
}

/**
 * Pobierz dane marketingowe koncertów.
 * @param {{ limit?: number }} opts
 */
async function getMarketingShows({ limit = 20 } = {}) {
  try {
    const snap = await db.collection('marketing_shows').limit(limit).get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getMarketingShows error:', err.message);
    return [];
  }
}

/**
 * Pobierz listę gości dla koncertu.
 * UWAGA: struktura guest_shows w Plex może być oparta na subkolekcjach
 * lub dokumentach z polem showId. Implementacja zakłada płaską kolekcję
 * z polem showId. Jeśli dane są puste — sprawdź strukturę w Firestore Console.
 * @param {string} showId
 */
async function getGuestList(showId) {
  try {
    const snap = await db.collection('guest_shows')
      .where('showId', '==', showId)
      .get();
    const docs = snap.docs.map(convertDoc).filter(Boolean);

    // TODO (Faza 2): jeśli guest_shows używa subkolekcji per showId,
    // zmień na: db.collection('guest_shows').doc(showId).collection('guests')
    return docs;
  } catch (err) {
    console.error('getGuestList error:', err.message);
    return [];
  }
}

/**
 * Pobierz status produkcji koncertu.
 * @param {string} showId
 */
async function getProductionStatus(showId) {
  try {
    const snap = await db.collection('production_shows')
      .where('showId', '==', showId)
      .limit(1)
      .get();

    if (snap.empty) {
      // Spróbuj po ID dokumentu
      const docSnap = await db.collection('production_shows').doc(showId).get();
      return docSnap.exists ? convertDoc(docSnap) : null;
    }
    return convertDoc(snap.docs[0]);
  } catch (err) {
    console.error('getProductionStatus error:', err.message);
    return null;
  }
}

module.exports = {
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  getGuestList,
  getProductionStatus,
};

// netlify/functions/lib/firestore.js
// Helpery Firestore dla Beaty (i przyszłych scheduled functions).
// Faza 2: czytanie + zapis (8 write functions, wszystkie z audit logiem).

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
const FieldValue = admin.firestore.FieldValue;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Konwertuj dokument Firestore na czysty JS object.
 * - Timestamp → ISO string
 * - DocumentReference → path string
 */
function convertDoc(doc) {
  const data = doc.data();
  if (!data) return null;
  const result = { id: doc.id };
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (typeof value.toDate === 'function') {
      result[key] = value.toDate().toISOString();
    } else if (value && value.constructor && value.constructor.name === 'DocumentReference') {
      result[key] = value.path;
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (item && typeof item.toDate === 'function') return item.toDate().toISOString();
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          // Konwertuj Timestampy zagnieżdżone w obiektach (np. execNotes)
          const converted = {};
          for (const [k, v] of Object.entries(item)) {
            converted[k] = (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
          }
          return converted;
        }
        return item;
      });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Zagnieżdżone obiekty (np. checkpoints, steps)
      const nested = {};
      for (const [k, v] of Object.entries(value)) {
        nested[k] = (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
      }
      result[key] = nested;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function todayString() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ── FAZA 1: READ FUNCTIONS ────────────────────────────────────────────────────

/**
 * Pobierz zadania z Jaszczurzych Spraw.
 * Domyślnie: otwarte (done: false), limit 50, sort createdAt desc.
 */
async function getTodos({ assignee, status, limit = 50 } = {}) {
  try {
    let q = db.collection('todos');

    if (status === 'done') {
      q = q.where('done', '==', true);
    } else if (status) {
      q = q.where('done', '==', false).where('status', '==', status);
    } else {
      q = q.where('done', '==', false);
    }

    if (assignee) {
      q = q.where('assignees', 'array-contains', assignee);
    }

    q = q.orderBy('createdAt', 'desc').limit(limit);
    const snap = await q.get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
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
 */
async function getTicketingEvents({ limit = 20, upcomingOnly = false } = {}) {
  try {
    let q = db.collection('ticketing_events');
    if (upcomingOnly) q = q.where('date', '>=', todayString());
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
 */
async function getTicketingEvent(nameQuery) {
  try {
    const snap = await db.collection('ticketing_events').get();
    const query = nameQuery.toLowerCase().trim();
    const docs = snap.docs.map(convertDoc).filter(Boolean);
    return docs.find(d => (d.name || '').toLowerCase().includes(query)) || null;
  } catch (err) {
    console.error('getTicketingEvent error:', err.message);
    return null;
  }
}

/**
 * Pobierz artystów z Watchlisty.
 */
async function getArtists({ status, limit = 30 } = {}) {
  try {
    let q = db.collection('artists');
    if (status) q = q.where('status', '==', status);
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
 * Pobierz listę gości dla koncertu po showId.
 * (legacy helper, pozostawiony dla kompatybilności)
 */
async function getGuestList(showId) {
  try {
    const snap = await db.collection('guest_shows')
      .where('showId', '==', showId)
      .get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getGuestList error:', err.message);
    return [];
  }
}

/**
 * Pobierz status produkcji koncertu po showId.
 */
async function getProductionStatus(showId) {
  try {
    const snap = await db.collection('production_shows')
      .where('showId', '==', showId)
      .limit(1)
      .get();
    if (snap.empty) {
      const docSnap = await db.collection('production_shows').doc(showId).get();
      return docSnap.exists ? convertDoc(docSnap) : null;
    }
    return convertDoc(snap.docs[0]);
  } catch (err) {
    console.error('getProductionStatus error:', err.message);
    return null;
  }
}

// ── FAZA 2 CZĘŚĆ D: NOWE READ FUNCTIONS ──────────────────────────────────────

/**
 * Pobierz show z listy gości po fragmencie nazwy.
 * UWAGA: struktura guest_shows weryfikowana w runtime.
 * Może mieć gości jako: array w dokumencie (pole 'guests'/'foto'/'rozdane')
 * lub subkolekcję 'guests'. Obsługujemy oba przypadki.
 */
async function getGuestShow(showNameQuery) {
  try {
    const snap = await db.collection('guest_shows').get();
    const query = showNameQuery.toLowerCase().trim();

    for (const doc of snap.docs) {
      const data = doc.data();
      // Szukaj po polu name, artist, lub ID dokumentu
      const nameFields = [data.name, data.artist, data.show, doc.id];
      const matches = nameFields.some(f => f && String(f).toLowerCase().includes(query));
      if (!matches) continue;

      const result = convertDoc(doc);

      // Jeśli brak tablicy guests — sprawdź subkolekcję
      const hasGuestsArray = Array.isArray(result.guests) && result.guests.length > 0;
      if (!hasGuestsArray) {
        try {
          const subSnap = await db
            .collection('guest_shows')
            .doc(doc.id)
            .collection('guests')
            .get();
          if (!subSnap.empty) {
            result.guests = subSnap.docs.map(convertDoc).filter(Boolean);
            result._guestsSource = 'subcollection';
          }
        } catch (_) {
          // subkolekcja nie istnieje — to OK, zostają dane z dokumentu
        }
      } else {
        result._guestsSource = 'array';
      }

      return result;
    }
    return null;
  } catch (err) {
    console.error('getGuestShow error:', err.message);
    return null;
  }
}

/**
 * Pobierz show produkcji po fragmencie nazwy.
 */
async function getProductionShow(showNameQuery) {
  try {
    const snap = await db.collection('production_shows').get();
    const query = showNameQuery.toLowerCase().trim();

    for (const doc of snap.docs) {
      const data = doc.data();
      const nameFields = [data.name, data.artist, data.show, doc.id];
      const matches = nameFields.some(f => f && String(f).toLowerCase().includes(query));
      if (matches) return convertDoc(doc);
    }
    return null;
  } catch (err) {
    console.error('getProductionShow error:', err.message);
    return null;
  }
}

/**
 * Pobierz koszty produkcji dla concertu.
 */
async function getProductionExpenses(showId) {
  try {
    const snap = await db.collection('production_expenses')
      .where('showId', '==', showId)
      .get();
    if (!snap.empty) return snap.docs.map(convertDoc).filter(Boolean);

    // Fallback: po ID dokumentu
    const docSnap = await db.collection('production_expenses').doc(showId).get();
    if (docSnap.exists) return [convertDoc(docSnap)];
    return [];
  } catch (err) {
    console.error('getProductionExpenses error:', err.message);
    return [];
  }
}

/**
 * Pobierz koszty marketingowe dla koncertu.
 */
async function getMarketingCosts(showId) {
  try {
    const snap = await db.collection('marketing_costs')
      .where('showId', '==', showId)
      .get();
    if (!snap.empty) return snap.docs.map(convertDoc).filter(Boolean);

    const docSnap = await db.collection('marketing_costs').doc(showId).get();
    if (docSnap.exists) return [convertDoc(docSnap)];
    return [];
  } catch (err) {
    console.error('getMarketingCosts error:', err.message);
    return [];
  }
}

/**
 * Pobierz projekty.
 */
async function getProjects({ limit = 20 } = {}) {
  try {
    const snap = await db.collection('projekty').limit(limit).get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getProjects error:', err.message);
    return [];
  }
}

/**
 * Pobierz snapshoty sprzedaży dla konkretnego eventu.
 */
async function getTicketingSnapshots(eventId, { limit = 12 } = {}) {
  try {
    const snap = await db.collection('ticketing_snapshots')
      .where('eventId', '==', eventId)
      .orderBy('date', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.warn('getTicketingSnapshots fallback:', err.message);
    const snap = await db.collection('ticketing_snapshots').limit(200).get();
    let docs = snap.docs.map(convertDoc).filter(Boolean);
    docs = docs.filter(d => d.eventId === eventId);
    docs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return docs.slice(0, limit);
  }
}

// ── FAZA 2 CZĘŚĆ C: WRITE FUNCTIONS ──────────────────────────────────────────
// Każda funkcja loguje co zrobiła (audit trail). Brak operacji delete.

/**
 * Dodaj nowe zadanie do Jaszczurzych Spraw.
 */
async function addTodo({ text, assignee, dueDate, pilne, note, addedBy }) {
  const docRef = await db.collection('todos').add({
    text,
    done: false,
    status: 'todo',
    pilne: pilne ?? false,
    note: note ?? '',
    driveLink: '',
    links: [],
    addedBy: addedBy || 'Beata',
    assignees: [assignee],
    assignee,
    dueDate: dueDate ?? null,
    execNotes: [],
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log(`[firestore] addTodo: "${text}" → ${assignee} (by ${addedBy}, id: ${docRef.id})`);
  return { id: docRef.id, text, assignee };
}

/**
 * Zmień status zadania.
 */
async function updateTodoStatus(todoId, newStatus) {
  const isDone = newStatus === 'done';
  await db.collection('todos').doc(todoId).update({
    status: newStatus,
    done: isDone,
  });
  console.log(`[firestore] updateTodoStatus: ${todoId} → ${newStatus}`);
  return { id: todoId, status: newStatus };
}

/**
 * Dopisz notatkę wykonawczą do zadania.
 * Uwaga: serverTimestamp() nie działa w arrayUnion — używamy ISO string.
 */
async function addTodoNote(todoId, note, authorName) {
  const newNote = {
    text: note,
    author: authorName || 'Beata',
    at: new Date().toISOString(),
  };
  await db.collection('todos').doc(todoId).update({
    execNotes: FieldValue.arrayUnion(newNote),
  });
  // Pobierz aktualną liczbę notatek
  const doc = await db.collection('todos').doc(todoId).get();
  const notesCount = (doc.data()?.execNotes || []).length;
  console.log(`[firestore] addTodoNote: ${todoId} by ${authorName} (total: ${notesCount})`);
  return { id: todoId, notesCount };
}

/**
 * Ogólna aktualizacja pól zadania. Allowed fields only.
 */
async function updateTodo(todoId, updates) {
  const ALLOWED = ['text', 'dueDate', 'pilne', 'note', 'assignee', 'assignees'];
  const filtered = {};
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  if (Object.keys(filtered).length === 0) {
    return { id: todoId, updated: [] };
  }
  await db.collection('todos').doc(todoId).update(filtered);
  console.log(`[firestore] updateTodo: ${todoId}`, Object.keys(filtered));
  return { id: todoId, updated: Object.keys(filtered) };
}

/**
 * Dodaj gościa do listy gości koncertu.
 * Obsługuje oba warianty struktury: array w dokumencie lub subkolekcja.
 */
async function addGuestToShow(showId, { name, tickets, media }) {
  const docRef = db.collection('guest_shows').doc(showId);
  const doc = await docRef.get();

  if (doc.exists) {
    const data = doc.data();
    const hasGuestsArray = data && Array.isArray(data.guests);

    if (hasGuestsArray) {
      // Struktura: array w dokumencie
      const guest = { name, tickets: tickets || 1, media: media || '' };
      await docRef.update({
        guests: FieldValue.arrayUnion(guest),
      });
      console.log(`[firestore] addGuestToShow (arrayUnion): ${showId} + ${name}`);
    } else {
      // Struktura: subkolekcja lub nowe pole
      await docRef.collection('guests').add({
        name,
        tickets: tickets || 1,
        media: media || '',
        addedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[firestore] addGuestToShow (subcollection): ${showId} + ${name}`);
    }
  } else {
    // Dokument nie istnieje — stwórz z arrayem
    await docRef.set({
      showId,
      guests: [{ name, tickets: tickets || 1, media: media || '' }],
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`[firestore] addGuestToShow (new doc): ${showId} + ${name}`);
  }

  return { showId, guestName: name };
}

/**
 * Zaktualizuj element checklisty produkcji.
 */
async function updateProductionChecklist(showId, itemKey, newStatus) {
  await db.collection('production_shows').doc(showId).update({
    [`checklist.${itemKey}`]: newStatus,
  });
  console.log(`[firestore] updateProductionChecklist: ${showId}.${itemKey} → ${newStatus}`);
  return { showId, itemKey, newStatus };
}

/**
 * Zaktualizuj checkpoint marketingowy.
 */
async function updateMarketingCheckpoint(showId, checkpointKey, newValue) {
  await db.collection('marketing_shows').doc(showId).update({
    [`checkpoints.${checkpointKey}`]: newValue,
  });
  console.log(`[firestore] updateMarketingCheckpoint: ${showId}.${checkpointKey} → ${newValue}`);
  return { showId, checkpointKey, newValue };
}

/**
 * Dodaj snapshot sprzedaży biletów.
 */
async function addTicketingSnapshot(eventId, { date, tm, eb, other }) {
  const total = (tm || 0) + (eb || 0) + (other || 0);
  const docRef = await db.collection('ticketing_snapshots').add({
    eventId,
    date,
    tm: tm || 0,
    eb: eb || 0,
    other: other || 0,
    total,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'beata',
  });
  console.log(`[firestore] addTicketingSnapshot: ${eventId} ${date} total=${total} (id: ${docRef.id})`);
  return { eventId, date, total };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Faza 1 — read
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  getGuestList,
  getProductionStatus,
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
};

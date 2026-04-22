// netlify/functions/lib/firestore.js
// Faza 2.1: bugfixy + nowe read/write functions.

const admin = require('firebase-admin');

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
          const converted = {};
          for (const [k, v] of Object.entries(item)) {
            converted[k] = (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
          }
          return converted;
        }
        return item;
      });
    } else if (value && typeof value === 'object') {
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
  return new Date().toISOString().slice(0, 10);
}

// Znajdź dokumenty w kolekcji po fragmencie nazwy w polu artistName lub name.
// Zwraca tablicę { doc, data } pasujących.
async function findByArtistName(collectionName, query) {
  const q = query.toLowerCase().trim();
  const snap = await db.collection(collectionName).get();
  const matches = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const nameField = data.artistName || data.name || '';
    if (nameField.toLowerCase().includes(q)) {
      matches.push({ doc, data });
    }
  }
  return matches;
}

// ── FAZA 1: READ FUNCTIONS ────────────────────────────────────────────────────

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
    if (assignee) q = q.where('assignees', 'array-contains', assignee);
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

async function getArtists({ hot, limit = 30 } = {}) {
  try {
    let q = db.collection('artists');
    if (hot === true) q = q.where('hot', '==', true);
    q = q.limit(limit);
    const snap = await q.get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.warn('getArtists fallback:', err.message);
    const snap = await db.collection('artists').limit(200).get();
    let docs = snap.docs.map(convertDoc).filter(Boolean);
    if (hot === true) docs = docs.filter(d => d.hot === true);
    return docs.slice(0, limit);
  }
}

async function getMarketingShows({ limit = 20 } = {}) {
  try {
    const snap = await db.collection('marketing_shows').limit(limit).get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getMarketingShows error:', err.message);
    return [];
  }
}

// Legacy — zachowane dla kompatybilności
async function getGuestList(showId) {
  try {
    const snap = await db.collection('guest_shows').where('showId', '==', showId).get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getGuestList error:', err.message);
    return [];
  }
}

async function getProductionStatus(showId) {
  try {
    const snap = await db.collection('production_shows')
      .where('showId', '==', showId).limit(1).get();
    if (snap.empty) {
      const d = await db.collection('production_shows').doc(showId).get();
      return d.exists ? convertDoc(d) : null;
    }
    return convertDoc(snap.docs[0]);
  } catch (err) {
    console.error('getProductionStatus error:', err.message);
    return null;
  }
}

// ── FAZA 2 / 2.1: READ FUNCTIONS ─────────────────────────────────────────────

/**
 * A1 FIX: getGuestShow — szuka po polu artistName (case-insensitive).
 * Zwraca:
 *   - null jeśli brak
 *   - jeden pełny dokument (z foto/media/rozdane arrays) jeśli dokładnie jeden match
 *   - listę summaries jeśli wiele matchów (name, date, ilość gości per lista)
 */
async function getGuestShow(artistNameQuery) {
  try {
    const matches = await findByArtistName('guest_shows', artistNameQuery);
    if (matches.length === 0) return null;

    if (matches.length === 1) {
      return convertDoc(matches[0].doc);
    }

    // Wiele matchów — zwróć summary z prośbą o doprecyzowanie
    return {
      _multipleMatches: true,
      matches: matches.map(({ doc, data }) => ({
        id: doc.id,
        artistName: data.artistName || data.name || doc.id,
        date: data.date || '?',
        fotoCount: Array.isArray(data.foto) ? data.foto.length : 0,
        mediaCount: Array.isArray(data.media) ? data.media.length : 0,
        rozdaneCount: Array.isArray(data.rozdane) ? data.rozdane.length : 0,
      })),
      message: 'Znaleziono kilka pasujących koncertów — doprecyzuj datę lub pełną nazwę.',
    };
  } catch (err) {
    console.error('getGuestShow error:', err.message);
    return null;
  }
}

async function getProductionShow(showNameQuery) {
  try {
    const matches = await findByArtistName('production_shows', showNameQuery);
    if (matches.length === 0) return null;
    if (matches.length === 1) return convertDoc(matches[0].doc);
    return {
      _multipleMatches: true,
      matches: matches.map(({ doc, data }) => ({
        id: doc.id,
        artistName: data.artistName || data.name || doc.id,
        date: data.date || '?',
      })),
      message: 'Kilka pasujących — podaj datę lub pełną nazwę.',
    };
  } catch (err) {
    console.error('getProductionShow error:', err.message);
    return null;
  }
}

async function getProductionExpenses(showId) {
  try {
    const snap = await db.collection('production_expenses').where('showId', '==', showId).get();
    if (!snap.empty) return snap.docs.map(convertDoc).filter(Boolean);
    const d = await db.collection('production_expenses').doc(showId).get();
    return d.exists ? [convertDoc(d)] : [];
  } catch (err) {
    console.error('getProductionExpenses error:', err.message);
    return [];
  }
}

/**
 * A3: Znajdź artystę z Watchlisty po fragmencie nazwy.
 */
async function getArtist(nameQuery) {
  try {
    const q = nameQuery.toLowerCase().trim();
    const snap = await db.collection('artists').get();
    const docs = snap.docs.map(convertDoc).filter(Boolean);
    const matches = docs.filter(d => (d.name || '').toLowerCase().includes(q));
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    // Wiele — zwróć listę
    return {
      _multipleMatches: true,
      matches: matches.map(d => ({ id: d.id, name: d.name, genre: d.genre })),
      message: 'Kilka pasujących artystów — doprecyzuj nazwę.',
    };
  } catch (err) {
    console.error('getArtist error:', err.message);
    return null;
  }
}

/**
 * A3: Koszty marketingowe dla konkretnego showId (+ suma total).
 */
async function getMarketingCostsForShow(showId) {
  try {
    const snap = await db.collection('marketing_costs').where('showId', '==', showId).get();
    const docs = snap.docs.map(convertDoc).filter(Boolean);
    const total = docs.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    return { showId, costs: docs, total };
  } catch (err) {
    console.error('getMarketingCostsForShow error:', err.message);
    return { showId, costs: [], total: 0 };
  }
}

/**
 * A3: Wszystkie koszty marketingowe (sortowane po createdAt malejąco).
 */
async function getAllMarketingCosts({ limit = 50 } = {}) {
  try {
    const snap = await db.collection('marketing_costs')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.warn('getAllMarketingCosts fallback:', err.message);
    const snap = await db.collection('marketing_costs').limit(200).get();
    const docs = snap.docs.map(convertDoc).filter(Boolean);
    docs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return docs.slice(0, limit);
  }
}

async function getProjects({ limit = 20 } = {}) {
  try {
    const snap = await db.collection('projekty').limit(limit).get();
    return snap.docs.map(convertDoc).filter(Boolean);
  } catch (err) {
    console.error('getProjects error:', err.message);
    return [];
  }
}

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

// ── FAZA 2 / 2.1: WRITE FUNCTIONS ────────────────────────────────────────────

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
  console.log(`[write] addTodo: "${text}" → ${assignee} (by ${addedBy}, id: ${docRef.id})`);
  return { id: docRef.id, text, assignee };
}

async function updateTodoStatus(todoId, newStatus) {
  const isDone = newStatus === 'done';
  await db.collection('todos').doc(todoId).update({ status: newStatus, done: isDone });
  console.log(`[write] updateTodoStatus: ${todoId} → ${newStatus}`);
  return { id: todoId, status: newStatus };
}

async function addTodoNote(todoId, note, authorName) {
  const newNote = { text: note, author: authorName || 'Beata', at: new Date().toISOString() };
  await db.collection('todos').doc(todoId).update({ execNotes: FieldValue.arrayUnion(newNote) });
  const doc = await db.collection('todos').doc(todoId).get();
  const notesCount = (doc.data()?.execNotes || []).length;
  console.log(`[write] addTodoNote: ${todoId} by ${authorName} (total: ${notesCount})`);
  return { id: todoId, notesCount };
}

async function updateTodo(todoId, updates) {
  const ALLOWED = ['text', 'dueDate', 'pilne', 'note', 'assignee', 'assignees'];
  const filtered = {};
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  if (Object.keys(filtered).length === 0) return { id: todoId, updated: [] };
  await db.collection('todos').doc(todoId).update(filtered);
  console.log(`[write] updateTodo: ${todoId}`, Object.keys(filtered));
  return { id: todoId, updated: Object.keys(filtered) };
}

/**
 * A2 FIX: addGuestToShow — nowy podpis.
 * Szuka dokumentu w guest_shows po artistName.
 * listType: 'foto' | 'media' | 'rozdane'
 * guestData: { name, email?, from?, tickets? }
 */
async function addGuestToShow(artistNameQuery, listType, guestData) {
  const matches = await findByArtistName('guest_shows', artistNameQuery);

  if (matches.length === 0) {
    throw new Error(`Nie znaleziono listy gości dla "${artistNameQuery}"`);
  }
  if (matches.length > 1) {
    const names = matches.map(m => `${m.data.artistName || m.doc.id} (${m.data.date || '?'})`).join(', ');
    throw new Error(`Kilka pasujących koncertów: ${names} — doprecyzuj datę lub nazwę.`);
  }

  const { doc } = matches[0];
  const guest = {
    name: guestData.name,
    email: guestData.email || '',
    from: guestData.from || '',
    tickets: guestData.tickets || 1,
  };

  await db.collection('guest_shows').doc(doc.id).update({
    [listType]: FieldValue.arrayUnion(guest),
  });

  const artistName = matches[0].data.artistName || doc.id;
  console.log(`[write] addGuestToShow: ${artistName} [${listType}] + ${guestData.name}`);
  return { artistName, listType, guestName: guestData.name };
}

async function updateProductionChecklist(showId, itemKey, newStatus) {
  await db.collection('production_shows').doc(showId).update({
    [`checklist.${itemKey}`]: newStatus,
  });
  console.log(`[write] updateProductionChecklist: ${showId}.${itemKey} → ${newStatus}`);
  return { showId, itemKey, newStatus };
}

async function updateMarketingCheckpoint(showId, checkpointKey, newValue) {
  await db.collection('marketing_shows').doc(showId).update({
    [`checkpoints.${checkpointKey}`]: newValue,
  });
  console.log(`[write] updateMarketingCheckpoint: ${showId}.${checkpointKey} → ${newValue}`);
  return { showId, checkpointKey, newValue };
}

async function addTicketingSnapshot(eventId, { date, tm, eb, other }) {
  const total = (tm || 0) + (eb || 0) + (other || 0);
  const docRef = await db.collection('ticketing_snapshots').add({
    eventId, date,
    tm: tm || 0, eb: eb || 0, other: other || 0, total,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'beata',
  });
  console.log(`[write] addTicketingSnapshot: ${eventId} ${date} total=${total} (id: ${docRef.id})`);
  return { eventId, date, total };
}

// ── FAZA 2.1: NOWE WRITE FUNCTIONS ──────────────────────────────────────────

/**
 * B1: Dodaj artystę do Watchlisty.
 */
async function addArtistToWatchlist({ name, genre, listeners, notes, addedBy, hot, inPromotor, plChecked }) {
  const docRef = await db.collection('artists').add({
    name,
    genre: genre || '',
    listeners: listeners || '',
    notes: notes || '',
    addedBy: addedBy || 'Beata',
    dateAdded: new Date().toISOString(),
    hot: hot ?? false,
    inPromotor: inPromotor ?? false,
    plChecked: plChecked ?? false,
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log(`[write] addArtistToWatchlist: "${name}" (by ${addedBy}, id: ${docRef.id})`);
  return { id: docRef.id, name };
}

/**
 * B2: Zaktualizuj flagi/pola artysty po nazwie.
 */
async function updateArtistFlags(artistNameQuery, updates) {
  const snap = await db.collection('artists').get();
  const q = artistNameQuery.toLowerCase().trim();
  const matches = snap.docs.filter(d => {
    const data = d.data();
    return (data.name || '').toLowerCase().includes(q);
  });

  if (matches.length === 0) {
    throw new Error(`Nie znaleziono artysty "${artistNameQuery}" na Watchliście`);
  }
  if (matches.length > 1) {
    const names = matches.map(d => d.data().name).join(', ');
    throw new Error(`Kilka pasujących artystów: ${names} — doprecyzuj nazwę.`);
  }

  const doc = matches[0];
  const ALLOWED = ['hot', 'inPromotor', 'plChecked', 'notes', 'genre', 'listeners'];
  const filtered = {};
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }
  if (Object.keys(filtered).length === 0) {
    return { id: doc.id, name: doc.data().name, updatedFields: [] };
  }
  await db.collection('artists').doc(doc.id).update(filtered);
  const updatedFields = Object.keys(filtered);
  console.log(`[write] updateArtistFlags: "${doc.data().name}"`, updatedFields);
  return { id: doc.id, name: doc.data().name, updatedFields };
}

/**
 * B3: Dodaj koszt marketingowy.
 */
async function addMarketingCost({ showId, artistName, amount, category, costDate, description, addedBy }) {
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount)) throw new Error(`amount musi być liczbą, otrzymano: "${amount}"`);

  const docRef = await db.collection('marketing_costs').add({
    showId,
    artistName,
    amount: parsedAmount,
    category: category || '',
    costDate: costDate || todayString(),
    description: description || '',
    addedBy: addedBy || 'Beata',
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log(`[write] addMarketingCost: ${artistName} ${parsedAmount} PLN [${category}] (id: ${docRef.id})`);
  return { id: docRef.id, artistName, amount: parsedAmount };
}

/**
 * B4: Zaktualizuj istniejący koszt marketingowy.
 */
async function updateMarketingCost(costId, updates) {
  const ALLOWED = ['amount', 'category', 'costDate', 'description'];
  const filtered = {};
  for (const key of ALLOWED) {
    if (updates[key] !== undefined) {
      filtered[key] = key === 'amount' ? parseFloat(updates[key]) : updates[key];
    }
  }
  if (Object.keys(filtered).length === 0) return { id: costId, updatedFields: [] };
  await db.collection('marketing_costs').doc(costId).update(filtered);
  const updatedFields = Object.keys(filtered);
  console.log(`[write] updateMarketingCost: ${costId}`, updatedFields);
  return { id: costId, updatedFields };
}

/**
 * B5: Zaktualizuj element checklisty produkcji po nazwie artysty.
 * TODO: Jeśli checklist jest flat-level (nie nested w 'checklist'), zmień na `{ [itemKey]: newValue }`.
 * Obecna implementacja: próbuje najpierw `checklist.${itemKey}`, fallback do flat.
 */
async function updateProductionChecklistItem(artistNameQuery, itemKey, newValue) {
  const matches = await findByArtistName('production_shows', artistNameQuery);

  if (matches.length === 0) throw new Error(`Nie znaleziono produkcji dla "${artistNameQuery}"`);
  if (matches.length > 1) {
    const names = matches.map(m => `${m.data.artistName || m.data.name || m.doc.id} (${m.data.date || '?'})`).join(', ');
    throw new Error(`Kilka pasujących: ${names} — doprecyzuj.`);
  }

  const { doc, data } = matches[0];
  const artistName = data.artistName || data.name || doc.id;

  // Sprawdź czy jest nested checklist, jeśli nie — użyj flat top-level
  const hasChecklist = data.checklist && typeof data.checklist === 'object';
  const updatePath = hasChecklist ? `checklist.${itemKey}` : itemKey;

  await db.collection('production_shows').doc(doc.id).update({ [updatePath]: newValue });
  console.log(`[write] updateProductionChecklistItem: "${artistName}" ${updatePath} → ${newValue}`);
  return { artistName, itemKey, newValue };
}

/**
 * B6: Zaktualizuj notatki produkcji (rider notes) po nazwie artysty.
 */
async function updateProductionNotes(artistNameQuery, newNotes) {
  const matches = await findByArtistName('production_shows', artistNameQuery);

  if (matches.length === 0) throw new Error(`Nie znaleziono produkcji dla "${artistNameQuery}"`);
  if (matches.length > 1) {
    const names = matches.map(m => m.data.artistName || m.data.name || m.doc.id).join(', ');
    throw new Error(`Kilka pasujących: ${names} — doprecyzuj.`);
  }

  const { doc, data } = matches[0];
  const artistName = data.artistName || data.name || doc.id;

  // Preferuj riderNotes jeśli pole istnieje, inaczej notes
  const field = ('riderNotes' in data) ? 'riderNotes' : 'notes';
  await db.collection('production_shows').doc(doc.id).update({ [field]: newNotes });
  console.log(`[write] updateProductionNotes: "${artistName}" (field: ${field})`);
  return { artistName };
}

/**
 * B7: Zaktualizuj notatki marketingowe po nazwie artysty/show.
 */
async function updateMarketingNotes(showNameQuery, newNotes) {
  const matches = await findByArtistName('marketing_shows', showNameQuery);

  if (matches.length === 0) {
    // Fallback: szukaj po showId match w ticketing_events, potem w marketing_shows
    throw new Error(`Nie znaleziono show marketingowego dla "${showNameQuery}"`);
  }
  if (matches.length > 1) {
    const names = matches.map(m => m.data.artistName || m.data.name || m.doc.id).join(', ');
    throw new Error(`Kilka pasujących: ${names} — doprecyzuj.`);
  }

  const { doc, data } = matches[0];
  const artistName = data.artistName || data.name || doc.id;
  await db.collection('marketing_shows').doc(doc.id).update({ notes: newNotes });
  console.log(`[write] updateMarketingNotes: "${artistName}"`);
  return { artistName };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Read — Faza 1
  getTodos,
  getTicketingEvents,
  getTicketingEvent,
  getArtists,
  getMarketingShows,
  getGuestList,
  getProductionStatus,
  // Read — Faza 2 / 2.1
  getGuestShow,
  getProductionShow,
  getProductionExpenses,
  getMarketingCosts: getMarketingCostsForShow, // alias backward compat
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
};

// fourceplex-auth.js — wspólna autoryzacja Google dla wszystkich modułów Fource.Plex
// Importuj w każdym HTML przed innymi skryptami (po Firebase SDK)

const FOURCE_DOMAIN = '@fource.com';
const PROMOTOR_EMAILS = ['igor@fource.com', 'radek@fource.com'];
const SESSION_KEY = 'fourceplex_current_user';

// Kolory per użytkownik (kompatybilność z istniejącym kodem)
const USER_COLORS = {
  'igor@fource.com':    '#34d399',
  'radek@fource.com':   '#60a5fa',
  'monika@fource.com':  '#a78bfa',
  'mariusz@fource.com': '#fbbf24',
};
const USER_NAMES = {
  'igor@fource.com':    'Igor',
  'radek@fource.com':   'Radek',
  'monika@fource.com':  'Monika',
  'mariusz@fource.com': 'Mariusz',
};

function getUserColor(emailOrName) {
  // Obsługuje zarówno email jak i imię (kompatybilność wsteczna)
  if (emailOrName && emailOrName.includes('@')) {
    return USER_COLORS[emailOrName] || '#888';
  }
  const email = Object.keys(USER_NAMES).find(e => USER_NAMES[e] === emailOrName);
  return email ? USER_COLORS[email] : '#888';
}

function getDisplayName(email) {
  return USER_NAMES[email] || email.split('@')[0];
}

function isPromotor(email) {
  return PROMOTOR_EMAILS.includes(email);
}

function updateBadge(email) {
  const name = getDisplayName(email);
  const color = getUserColor(email);
  const dot = document.getElementById('badge-dot');
  const nm = document.getElementById('badge-name');
  const ru = document.getElementById('rail-user-dot');
  if (dot) dot.style.background = color;
  if (nm) nm.textContent = name;
  if (ru) {
    ru.style.background = color + '22';
    ru.style.color = color;
    ru.style.border = `1.5px solid ${color}55`;
    ru.textContent = name.charAt(0).toUpperCase();
  }
}

function applyRoleUI(email) {
  const promotor = isPromotor(email);
  const pn = document.getElementById('promotor-nav');
  if (pn) pn.style.display = promotor ? 'flex' : 'none';
}

// Inicjalizacja autoryzacji — wywołaj na początku każdej strony
function initAuth(onReady) {
  firebase.auth().onAuthStateChanged(user => {
    if (!user || !user.email || !user.email.endsWith(FOURCE_DOMAIN)) {
      // Niezalogowany lub zły email — wyloguj i przekieruj
      firebase.auth().signOut().then(() => {
        window.location.href = 'login.html';
      });
      return;
    }

    const email = user.email;
    const name = getDisplayName(email);

    // Ustaw currentUser jako imię (kompatybilność z istniejącym kodem)
    window.currentUser = name;

    // Zapisz w localStorage (kompatybilność)
    localStorage.setItem(SESSION_KEY, name);

    // Zaktualizuj UI
    updateBadge(email);
    applyRoleUI(email);

    // Wywołaj callback gdy gotowy
    if (typeof onReady === 'function') onReady(name, email);
  });
}

// Wylogowanie
function signOut() {
  localStorage.removeItem(SESSION_KEY);
  firebase.auth().signOut().then(() => {
    window.location.href = 'login.html';
  });
}

// Eksport globalny
window.getUserColor = getUserColor;
window.getDisplayName = getDisplayName;
window.isPromotor = isPromotor;
window.initAuth = initAuth;
window.signOut = signOut;

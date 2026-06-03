// api/lib/google-chat.js
// Wysyłanie wiadomości do Google Chat przez service account (asynchronicznie).
// Używane przez scheduled briefy i inne proaktywne wiadomości Beaty.

import { SignJWT, importPKCS8 } from 'jose';

const CHAT_API = 'https://chat.googleapis.com/v1';
const SCOPES = 'https://www.googleapis.com/auth/chat.bot';

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const privateKey = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: SCOPES,
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .sign(privateKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Chat auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function sendToSpace(spaceId, text) {
  const token = await getAccessToken();
  const res = await fetch(`${CHAT_API}/spaces/${spaceId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Chat send failed: ${JSON.stringify(data)}`);
  return data;
}

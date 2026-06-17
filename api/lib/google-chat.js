// api/lib/google-chat.js
// Wysyłanie wiadomości do Google Chat przez service account (asynchronicznie).
// Używa natywnego modułu crypto Node.js — zero zewnętrznych zależności,
// żeby uniknąć problemów z instalacją pakietów (jose) na Vercelu.

import crypto from 'crypto';

const CHAT_API = 'https://chat.googleapis.com/v1';
const SCOPES = 'https://www.googleapis.com/auth/chat.bot';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: SCOPES,
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const signatureB64 = signature
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${unsigned}.${signatureB64}`;
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const jwt = signJwt(sa);

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

export async function sendConfirmCard(spaceId, actionId, title, description) {
  const token = await getAccessToken();
  const card = {
    cardsV2: [{
      cardId: actionId,
      card: {
        header: { title: '🦎 Beata — potwierdzenie' },
        sections: [{
          widgets: [
            { textParagraph: { text: `<b>${title}</b>` } },
            { textParagraph: { text: description } },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Tak, zapisz',
                    onClick: { action: { function: 'confirm_yes', parameters: [{ key: 'actionId', value: actionId }] } },
                  },
                  {
                    text: 'Nie, odrzuć',
                    onClick: { action: { function: 'confirm_no', parameters: [{ key: 'actionId', value: actionId }] } },
                  },
                ],
              },
            },
          ],
        }],
      },
    }],
  };

  const res = await fetch(`${CHAT_API}/spaces/${spaceId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(card),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Chat card send failed: ${JSON.stringify(data)}`);
  return data;
}

export async function updateCardMessage(messageName, text) {
  const token = await getAccessToken();
  const res = await fetch(`${CHAT_API}/${messageName}?updateMask=text,cardsV2`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ text, cardsV2: [] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Chat card update failed: ${JSON.stringify(data)}`);
  return data;
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

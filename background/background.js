// --- Config -------------------------------------------------------------------

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyA33Bb9yoGYd72L04eh2DBlwJ4Fiig_BhA",
  authDomain:        "highlighter-ex.firebaseapp.com",
  projectId:         "highlighter-ex",
  storageBucket:     "highlighter-ex.firebasestorage.app",
  messagingSenderId: "135241008749",
  appId:             "1:135241008749:web:3aaf8fd67c372b414b2164"
};

const GOOGLE_WEB_CLIENT_ID = "135241008749-p67v9gj5b88p61um1ap77are5olbd16c.apps.googleusercontent.com";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// --- Auth ---------------------------------------------------------------------

async function signInWithGoogle() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const nonce       = Math.random().toString(36).substring(2);

  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_WEB_CLIENT_ID)}` +
    `&response_type=id_token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    `&nonce=${nonce}`;

  // Open Google sign-in popup
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(url);
      }
    );
  });

  // Extract id_token from URL fragment
  const params  = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const idToken = params.get('id_token');
  if (!idToken) throw new Error('No id_token in response');

  // Exchange Google id_token for Firebase token
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody:            `id_token=${idToken}&providerId=google.com`,
        requestUri:          redirectUri,
        returnIdpCredential: true,
        returnSecureToken:   true
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const user = {
    uid:          data.localId,
    email:        data.email,
    displayName:  data.displayName,
    idToken:      data.idToken,
    refreshToken: data.refreshToken
  };

  await chrome.storage.local.set({ currentUser: user });
  return user;
}

async function signOut() {
  await chrome.storage.local.remove('currentUser');
  return { ok: true };
}

async function getCurrentUser() {
  const { currentUser } = await chrome.storage.local.get('currentUser');
  return currentUser || null;
}

// --- Firestore encode/decode --------------------------------------------------

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string')       out[k] = { stringValue: v };
    else if (typeof v === 'number')  out[k] = { doubleValue: v };
    else if (typeof v === 'boolean') out[k] = { booleanValue: v };
    else if (Array.isArray(v))       out[k] = { arrayValue: { values: v.map(encodeValue) } };
    else if (typeof v === 'object')  out[k] = { mapValue: { fields: encodeFields(v) } };
  }
  return out;
}

function encodeValue(v) {
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object' && v !== null) return { mapValue: { fields: encodeFields(v) } };
  return { nullValue: null };
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function decodeValue(v) {
  if ('stringValue'  in v) return v.stringValue;
  if ('doubleValue'  in v) return v.doubleValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue'     in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function fromFirestore(doc) {
  if (!doc || !doc.fields) return null;
  return decodeFields(doc.fields);
}

// --- Firestore CRUD -----------------------------------------------------------

function docPath(uid, urlHash) {
  return `${BASE_URL}/users/${uid}/highlights/${urlHash}`;
}

async function firestoreHeaders() {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not signed in');
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${user.idToken}`
  };
}

async function loadHighlights(urlHash) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not signed in');
  const res = await fetch(docPath(user.uid, urlHash), { headers: await firestoreHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore load failed: ${res.status}`);
  return fromFirestore(await res.json());
}

async function saveHighlights(urlHash, sessionId, highlights, meta) {
  const user = await getCurrentUser();
  if (!user) throw new Error('Not signed in');
  const body = { fields: encodeFields({ meta, sessions: { [sessionId]: highlights } }) };
  const res  = await fetch(
    docPath(user.uid, urlHash) +
      `?updateMask.fieldPaths=meta&updateMask.fieldPaths=sessions.${sessionId}`,
    { method: 'PATCH', headers: await firestoreHeaders(), body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Firestore save failed: ${res.status}`);
  return { ok: true };
}

async function deleteHighlight(urlHash, sessionId, highlightId) {
  const data = await loadHighlights(urlHash);
  if (!data) return { ok: true };
  const updated = (data.sessions?.[sessionId] || []).filter(h => h.id !== highlightId);
  await saveHighlights(urlHash, sessionId, updated, data.meta || {});
  return { ok: true };
}

function hashUrl(url) {
  const clean = url.replace(/#.*$/, '').replace(/\/$/, '');
  let h = 0;
  for (let i = 0; i < clean.length; i++) { h = ((h << 5) - h) + clean.charCodeAt(i); h |= 0; }
  return 'url_' + Math.abs(h).toString(36);
}

// --- Context menus ------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'highlight-selection', title: 'Highlight selection', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'highlight-eraser',    title: 'Remove highlight',    contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'highlight-selection') chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_SELECTION' });
  if (info.menuItemId === 'highlight-eraser')    chrome.tabs.sendMessage(tab.id, { type: 'ERASE_MODE_TOGGLE' });
});

// --- Message handler ----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    console.error('[background] error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_USER':         return getCurrentUser();
    case 'SIGN_IN':          return signInWithGoogle();
    case 'SIGN_OUT':         return signOut();
    case 'HASH_URL':         return { hash: hashUrl(msg.url) };
    case 'LOAD_HIGHLIGHTS':  return loadHighlights(msg.urlHash);
    case 'SAVE_HIGHLIGHTS':  return saveHighlights(msg.urlHash, msg.sessionId, msg.highlights, msg.meta);
    case 'DELETE_HIGHLIGHT': return deleteHighlight(msg.urlHash, msg.sessionId, msg.highlightId);
    case 'GET_TAB_URL': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { url: tab?.url || '' };
    }
    default: return { error: `Unknown message type: ${msg.type}` };
  }
}
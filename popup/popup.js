let currentUser      = null;
let activeSession    = 'default';
let sessionsData     = {};
let highlightsHidden = false;

// Send message to background service worker
function bg(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

// Send message to the active tab's content script
async function tab(type, data = {}) {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) return null;
  return chrome.tabs.sendMessage(t.id, { type, ...data }).catch(() => null);
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = type;
}

// --- Init ---------------------------------------------------------------------

(async () => {
  currentUser = await bg('GET_USER');

  if (!currentUser) {
    document.getElementById('signin-view').style.display = 'block';
    document.getElementById('main-view').style.display   = 'none';
  } else {
    showMainView();
  }
})();

function showMainView() {
  document.getElementById('signin-view').style.display = 'none';
  document.getElementById('main-view').style.display   = 'block';
  document.getElementById('user-name').textContent =
    currentUser.displayName || currentUser.email || '';
  loadSessionsForPage();
  syncStatusFromContent();
}

async function loadSessionsForPage() {
  const { url } = await bg('GET_TAB_URL');
  if (!url) return;
  const { hash }  = await bg('HASH_URL', { url });
  const data      = await bg('LOAD_HIGHLIGHTS', { urlHash: hash }).catch(() => null);
  sessionsData    = data?.sessions || { default: [] };
  renderSessions();
}

function renderSessions() {
  const list = document.getElementById('session-list');
  list.innerHTML = '';
  for (const [id, items] of Object.entries(sessionsData)) {
    const row  = document.createElement('div');
    row.className = 'session-item' + (id === activeSession ? ' active' : '');
    row.innerHTML = `
      <div class="session-dot"></div>
      <div class="session-name">${esc(id)}</div>
      <div class="session-count">${items.length} hl</div>`;
    row.addEventListener('click', async () => {
      activeSession = id;
      await tab('SET_SESSION', { sessionId: id });
      renderSessions();
      setStatus(`Switched to "${id}"`, 'ok');
    });
    list.appendChild(row);
  }
}

async function syncStatusFromContent() {
  const status = await tab('GET_STATUS');
  if (!status) return;
  activeSession = status.activeSession || 'default';
  document.getElementById('btn-eraser').textContent =
    status.eraserMode ? 'Eraser ON ✓' : 'Eraser off';
}

// --- Button events ------------------------------------------------------------

document.getElementById('btn-signin').addEventListener('click', async () => {
  setStatus('Signing in...');
  try {
    currentUser = await bg('SIGN_IN');
    if (currentUser) showMainView();
    else setStatus('Sign in failed', 'error');
  } catch (e) {
    setStatus(e.message, 'error');
  }
});

document.getElementById('btn-signout').addEventListener('click', async () => {
  await bg('SIGN_OUT');
  location.reload();
});

document.getElementById('btn-new-session').addEventListener('click', async () => {
  const input = document.getElementById('new-session-name');
  const name  = input.value.trim();
  if (!name) return;
  sessionsData[name] = [];
  activeSession = name;
  await tab('SET_SESSION', { sessionId: name });
  input.value = '';
  renderSessions();
  setStatus(`Created "${name}"`, 'ok');
});

document.getElementById('btn-eraser').addEventListener('click', async () => {
  const res = await tab('ERASE_MODE_TOGGLE');
  if (res) {
    document.getElementById('btn-eraser').textContent =
      res.eraserMode ? 'Eraser ON ✓' : 'Eraser off';
  }
});

document.getElementById('btn-hide').addEventListener('click', async () => {
  highlightsHidden = !highlightsHidden;
  await tab('TOGGLE_VISIBILITY', { hidden: highlightsHidden });
  document.getElementById('btn-hide').textContent =
    highlightsHidden ? 'Show all' : 'Hide all';
});

function esc(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
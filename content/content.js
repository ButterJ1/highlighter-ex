// --- State --------------------------------------------------------------------

let PAGE_URL_HASH  = null;
let currentUser    = null;
let activeSession  = 'default';
let pendingHighlights = [];
let eraserMode     = false;
let toolbar        = null;

const COLORS     = ['yellow', 'green', 'blue', 'pink', 'orange'];
let   activeColor = 'yellow';

// --- Helpers: talk to background ----------------------------------------------

function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// --- Init ---------------------------------------------------------------------

(async () => {
  const { hash } = await bg({ type: 'HASH_URL', url: window.location.href });
  PAGE_URL_HASH   = hash;

  currentUser = await bg({ type: 'GET_USER' });
  if (!currentUser) return; // not signed in — highlights won't load or save

  const data = await bg({ type: 'LOAD_HIGHLIGHTS', urlHash: PAGE_URL_HASH });
  if (!data) return;

  const sessionHighlights = data.sessions?.[activeSession] || [];
  if (sessionHighlights.length === 0) return;

  pendingHighlights = [...sessionHighlights];
  setupIntersectionObserver();
})();

// --- IntersectionObserver — lazy restore -------------------------------------

function setupIntersectionObserver() {
  const targets = [...new Set(pendingHighlights.map(h => h.observerTarget).filter(Boolean))];

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el      = entry.target;
      const toApply = pendingHighlights.filter(h => {
        try { return el.matches(h.observerTarget); } catch { return false; }
      });

      for (const h of toApply) {
        applyHighlight(h);
        pendingHighlights = pendingHighlights.filter(x => x.id !== h.id);
      }

      const stillPending = pendingHighlights.filter(h => {
        try { return h.observerTarget && el.matches(h.observerTarget); } catch { return false; }
      });
      if (stillPending.length === 0) observer.unobserve(el);
      if (pendingHighlights.length === 0) observer.disconnect();
    }
  }, { rootMargin: '200px' });

  for (const selector of targets) {
    try {
      document.querySelectorAll(selector).forEach(el => observer.observe(el));
    } catch { /* invalid selector stored — skip */ }
  }

  // Apply immediately anything with no observerTarget
  const immediate = pendingHighlights.filter(h => !h.observerTarget);
  for (const h of immediate) {
    applyHighlight(h);
    pendingHighlights = pendingHighlights.filter(x => x.id !== h.id);
  }
}

// --- Apply a saved highlight to the DOM --------------------------------------

function applyHighlight(h) {
  let targetEl = null;

  try {
    const matches = document.querySelectorAll(h.selector);
    const candidate = matches[h.selectorIndex] || null;
    if (candidate) {
      const needle = h.prefix + h.exact + h.suffix;
      if ((candidate.textContent || '').includes(needle)) {
        targetEl = candidate;
      }
    }
  } catch { /* invalid selector */ }

  if (!targetEl) {
    try {
      const needle = h.prefix + h.exact + h.suffix;
      for (const el of document.querySelectorAll(h.selector)) {
        if ((el.textContent || '').includes(needle)) { targetEl = el; break; }
      }
    } catch { /* skip */ }
  }

  if (!targetEl) {
    const needle = h.prefix + h.exact + h.suffix;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(needle)) { targetEl = node.parentElement; break; }
    }
  }

  if (!targetEl) {
    console.warn('[Highlighter] Could not restore highlight:', h.exact);
    return;
  }

  wrapTextInElement(targetEl, h);
}

function wrapTextInElement(el, h) {
  const needle = h.prefix + h.exact + h.suffix;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const idx = node.textContent.indexOf(needle);
    if (idx === -1) continue;

    const start = idx + h.prefix.length;
    const end   = start + h.exact.length;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);

    const span = document.createElement('span');
    span.className         = 'hl-mark';
    span.dataset.id        = h.id;
    span.dataset.sessionId = activeSession;
    span.dataset.color     = h.color || 'yellow';
    span.style.background  = colorToHex(h.color);
    span.title             = h.note || '';
    span.addEventListener('click', onHighlightClick);

    try {
      range.surroundContents(span);
    } catch {
      // surroundContents fails when range crosses element boundaries — skip
    }
    return;
  }
}

function colorToHex(name) {
  const map = { yellow: '#ffd700', green: '#90ee90', blue: '#add8e6', pink: '#ffb6c1', orange: '#ffa07a' };
  return map[name] || '#ffd700';
}

// --- Creating a new highlight -------------------------------------------------

function captureAnchor(range) {
  const container = range.commonAncestorContainer;
  const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;

  const selector      = buildSelector(el);
  const selectorIndex = getSelectorIndex(el, selector);
  const observerTarget = getObserverTarget(el);

  const fullText  = el.textContent || '';
  const exact     = range.toString();

  const preRange  = document.createRange();
  preRange.setStart(el, 0);
  preRange.setEnd(range.startContainer, range.startOffset);
  const offset = preRange.toString().length;

  const CTX    = 32;
  const prefix = fullText.slice(Math.max(0, offset - CTX), offset);
  const suffix = fullText.slice(offset + exact.length, offset + exact.length + CTX);

  return { selector, selectorIndex, observerTarget, prefix, exact, suffix };
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag     = el.tagName.toLowerCase();
  const classes = [...el.classList].slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
  return `${tag}${classes}`;
}

function getSelectorIndex(el, selector) {
  try {
    const all = [...document.querySelectorAll(selector)];
    return all.indexOf(el);
  } catch { return 0; }
}

function getObserverTarget(el) {
  const candidates = ['section', 'article', 'main', '[role="main"]', 'div[class]', 'div[id]'];
  let cur = el.parentElement;
  while (cur && cur !== document.body) {
    for (const sel of candidates) {
      try { if (cur.matches(sel)) return buildSelector(cur); } catch { /* skip */ }
    }
    cur = cur.parentElement;
  }
  return null;
}

async function createHighlight(color, note = '') {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const range  = selection.getRangeAt(0);
  const anchor = captureAnchor(range);
  if (!anchor.exact.trim()) return;

  const highlight = {
    id:        crypto.randomUUID(),
    color,
    note,
    createdAt: Date.now(),
    ...anchor
  };

  // Apply to DOM immediately (optimistic)
  const container = range.commonAncestorContainer;
  wrapTextInElement(
    container.nodeType === Node.TEXT_NODE ? container.parentElement : container,
    highlight
  );

  selection.removeAllRanges();
  hideToolbar();

  // Persist via background, Firestore
  if (currentUser && PAGE_URL_HASH) {
    const data = await bg({ type: 'LOAD_HIGHLIGHTS', urlHash: PAGE_URL_HASH }) || { meta: {}, sessions: {} };
    const session = data.sessions?.[activeSession] || [];
    session.push(highlight);
    await bg({
      type:       'SAVE_HIGHLIGHTS',
      urlHash:    PAGE_URL_HASH,
      sessionId:  activeSession,
      highlights: session,
      meta:       { url: window.location.href, title: document.title }
    });
  }
}

// --- Eraser -------------------------------------------------------------------

async function onHighlightClick(e) {
  if (!eraserMode) return;
  const span = e.currentTarget;
  const id   = span.dataset.id;

  const parent = span.parentNode;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);

  if (currentUser && PAGE_URL_HASH) {
    await bg({ type: 'DELETE_HIGHLIGHT', urlHash: PAGE_URL_HASH, sessionId: activeSession, highlightId: id });
  }
}

// --- Toolbar ------------------------------------------------------------------

document.addEventListener('mouseup', (e) => {
  if (toolbar && toolbar.contains(e.target)) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    hideToolbar();
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showToolbar(rect);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideToolbar();
    if (eraserMode) toggleEraserMode();
  }
});

function showToolbar(rect) {
  hideToolbar();

  toolbar = document.createElement('div');
  toolbar.className = 'hl-toolbar';

  // Color swatches
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.className = 'hl-swatch';
    btn.style.background = colorToHex(color);
    btn.title = color;
    if (color === activeColor) btn.classList.add('selected');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeColor = color;
      toolbar.querySelectorAll('.hl-swatch').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      createHighlight(color);
    });
    toolbar.appendChild(btn);
  }

  // Divider
  const div = document.createElement('div');
  div.className = 'hl-divider';
  toolbar.appendChild(div);

  const noteBtn = document.createElement('button');
  noteBtn.className = 'hl-note-btn';
  noteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>note`;
  noteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Save range NOW — prompt() will clear the selection
    const selection = window.getSelection();
    const savedRange = (selection && !selection.isCollapsed)
      ? selection.getRangeAt(0).cloneRange()
      : null;
    const note = prompt('Add a note:');
    if (note === null) return;
    if (savedRange) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    createHighlight(activeColor, note);
  });
  toolbar.appendChild(noteBtn);

  // Position above selection, centered
  const toolbarWidth = 170;
  const left = Math.max(8, rect.left + rect.width / 2 - toolbarWidth / 2);
  toolbar.style.left = `${left}px`;
  toolbar.style.top  = `${rect.top - 48}px`;

  document.body.appendChild(toolbar);
}

function hideToolbar() {
  if (toolbar) { toolbar.remove(); toolbar = null; }
}

function toggleEraserMode() {
  eraserMode = !eraserMode;
  document.body.classList.toggle('hl-eraser-mode', eraserMode);
}

// --- Messages from background / popup ----------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'HIGHLIGHT_SELECTION') {
      await createHighlight(activeColor);
      sendResponse({ ok: true });
    }
    else if (msg.type === 'ERASE_MODE_TOGGLE') {
      toggleEraserMode();
      sendResponse({ eraserMode });
    }
    else if (msg.type === 'SET_SESSION') {
      activeSession = msg.sessionId;
      // Clear current DOM highlights
      document.querySelectorAll('.hl-mark').forEach(el => {
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      });
      // Reload for new session
      if (currentUser && PAGE_URL_HASH) {
        const data = await bg({ type: 'LOAD_HIGHLIGHTS', urlHash: PAGE_URL_HASH });
        pendingHighlights = data?.sessions?.[activeSession] || [];
        if (pendingHighlights.length > 0) setupIntersectionObserver();
      }
      sendResponse({ ok: true });
    }
    else if (msg.type === 'TOGGLE_VISIBILITY') {
      document.querySelectorAll('.hl-mark').forEach(el => {
        el.classList.toggle('hl-hidden', msg.hidden);
      });
      sendResponse({ ok: true });
    }
    else if (msg.type === 'GET_STATUS') {
      sendResponse({ eraserMode, activeSession, activeColor });
    }
  })();
  return true;
});
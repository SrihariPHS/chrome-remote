/**
 * The human side of chrome.inkwork.studio: a plain browser window.
 *
 * Tabs, an address bar, a live view, and touch input for phones. Nothing else —
 * the ref trees, timers and latency panels live at /console.
 */

const $ = (sel) => document.querySelector(sel);
const qs = new URLSearchParams(location.search);

const state = {
  token: '',
  session: '',
  tabs: [],
  active: null,
  ws: null,
  ready: false,
  viewport: { width: 1280, height: 800 },
  bus: false, // remote page has a focused editable element
  coarse: navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches,
  retry: 0,
  stop: false,
};

const KEY = 'iw-token';
const SESSION_KEY = 'iw-session';

/* ------------------------------------------------------------------ sign in */

if (qs.get('token')) {
  localStorage.setItem(KEY, qs.get('token'));
  qs.delete('token');
  history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : ''));
}
state.token = localStorage.getItem(KEY) || '';

function showGate(message = '') {
  $('#gate').hidden = false;
  $('#gateMsg').textContent = message;
  setTimeout(() => $('#gateInput').focus(), 40);
}

$('#gateForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#gateInput');
  const value = input.value.trim();
  if (!value) return;
  $('#gateBtn').disabled = true;
  $('#gateMsg').textContent = '';

  // A short number is the console PIN; anything longer is a bearer token.
  if (/^\d{4,10}$/.test(value)) {
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: value }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        $('#gateMsg').textContent = d.error === 'too_many_attempts'
          ? 'Too many tries. Wait five minutes.'
          : 'That PIN is not right.';
        input.value = '';
        input.focus();
        return;
      }
      state.token = '';
      localStorage.removeItem(KEY);
      $('#gate').hidden = true;
      boot();
      return;
    } catch {
      $('#gateMsg').textContent = 'Could not reach the server.';
      return;
    } finally {
      $('#gateBtn').disabled = false;
    }
  }

  state.token = value;
  localStorage.setItem(KEY, value);
  const probe = await api('/api/sessions').catch(() => ({ ok: false }));
  if (!probe.ok) {
    state.token = '';
    localStorage.removeItem(KEY);
    $('#gateMsg').textContent = 'That token did not work.';
    return;
  }
  $('#gate').hidden = true;
  boot();
});

/* --------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem(KEY);
    showGate('Sign in to continue.');
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, status: res.status, ...data };
}

const s = (path) => `/api/s/${state.session}${path}`;

/* -------------------------------------------------------------------- boot */

function veil(text, retry) {
  const v = $('#veil');
  v.hidden = !text;
  $('#veilText').textContent = text || '';
  const old = v.querySelector('button');
  if (old) old.remove();
  if (retry) {
    const b = document.createElement('button');
    b.textContent = 'Try again';
    b.onclick = () => { v.querySelector('button')?.remove(); boot(); };
    v.appendChild(b);
  }
}

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

async function boot() {
  state.stop = false;
  veil('starting a browser…');

  const list = await api('/api/sessions');
  if (!list.ok) {
    if (list.error === 'unauthorized') return;
    veil('The server is not answering.', true);
    return;
  }

  // Prefer ?session=, then the session this browser tab already owns.
  const wanted = qs.get('session') || sessionStorage.getItem(SESSION_KEY) || '';
  const known = (list.sessions || []).some((x) => x.id === wanted && x.status !== 'closed');
  state.session = known ? wanted : '';
  qs.delete('session');

  if (!state.session) {
    const made = await api('/api/sessions', {
      method: 'POST',
      body: { name: 'human', viewport: desiredViewport() },
    });
    if (!made.ok) {
      const busy = made.error === 'max_sessions';
      veil(busy
        ? 'Every browser is in use right now. Try again in a minute.'
        : `Could not start a browser (${made.error || 'error'}).`, true);
      return;
    }
    state.session = made.session.id;
  }

  sessionStorage.setItem(SESSION_KEY, state.session);
  $('#brand').textContent = `chrome · ${state.session}`;
  history.replaceState(null, '', location.pathname);

  await refreshTabs();
  connect();
  clearInterval(boot.tabs);
  clearInterval(boot.beat);
  boot.tabs = setInterval(refreshTabs, 3000);
  boot.beat = setInterval(() => send({ type: 'ping' }), 20000);
}

function desiredViewport() {
  const box = $('#viewport').getBoundingClientRect();
  const width = Math.max(320, Math.min(1920, Math.round(box.width || innerWidth)));
  const height = Math.max(320, Math.min(1200, Math.round(box.height || innerHeight)));
  return { width, height };
}

/* -------------------------------------------------------------------- tabs */

async function refreshTabs() {
  if (!state.session) return;
  const r = await api(s('/tabs'));
  if (!r.ok) {
    // The session was reaped or closed elsewhere: start a fresh one.
    if (r.status === 404 && !state.stop) {
      sessionStorage.removeItem(SESSION_KEY);
      state.session = '';
      disconnect();
      setTimeout(boot, 1200);
    }
    return;
  }
  state.tabs = r.tabs || [];
  state.active = r.active;
  renderTabs();
  const current = state.tabs.find((t) => t.id === state.active);
  if (current && document.activeElement !== $('#url')) {
    const blank = !current.url || current.url === 'about:blank';
    const local = /\/newtab$/.test(current.url || '');
    $('#url').value = blank || local ? '' : current.url;
    $('#lock').dataset.state = blank || local ? 'local' : /^https:/i.test(current.url) ? 'secure' : 'insecure';
  }
  if (!state.ready && state.tabs.length) veil('');
}

function tabLabel(t) {
  if (t.title) return t.title;
  if (!t.url || t.url === 'about:blank') return 'New tab';
  try { return new URL(t.url).hostname.replace(/^www\./, ''); } catch { return t.url; }
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.textContent = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.active ? ' active' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.id === state.active));
    el.title = t.url || '';

    const fav = document.createElement('span');
    fav.className = 'fav';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tabLabel(t);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Close tab';
    x.setAttribute('aria-label', 'Close tab');

    x.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(t.id); });
    el.append(fav, name, x);
    el.addEventListener('click', () => activateTab(t.id));
    wrap.appendChild(el);
  }
}

async function activateTab(id) {
  if (id === state.active) return;
  disconnect();
  await api(s('/tabs'), { method: 'POST', body: { action: 'activate', id } });
  await refreshTabs();
  connect();
}

async function newTab(url) {
  veil('opening a tab…');
  await api(s('/tabs'), { method: 'POST', body: { action: 'new', url: url || '/newtab' } });
  await refreshTabs();
  connect();
}

async function closeTab(id) {
  if (state.tabs.length <= 1) { newTab(); return; }
  await api(s('/tabs'), { method: 'POST', body: { action: 'close', id } });
  await refreshTabs();
  connect();
}

/* -------------------------------------------------------------------- live */

function disconnect() {
  const old = state.ws;
  state.ws = null;
  state.ready = false;
  if (old) {
    old.__intentional = true;
    try { old.close(); } catch {}
  }
}

function connect() {
  disconnect();
  state.stop = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${s('/live')}${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`);
  state.ws = ws;

  const canvas = $('#screen');
  const ctx = canvas.getContext('2d', { alpha: false });

  ws.onopen = () => { state.retry = 0; };

  ws.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        state.viewport = msg.viewport || state.viewport;
        if (canvas.width !== state.viewport.width || canvas.height !== state.viewport.height) {
          canvas.width = state.viewport.width;
          canvas.height = state.viewport.height;
          fit();
        }
      } else if (msg.type === 'reset') {
        // The remote viewport changed; reconnect to restream at the new size.
        connect();
      } else if (msg.type === 'error') {
        toast(msg.error || 'Something went wrong');
      }
      return;
    }
    try {
      const bitmap = await createImageBitmap(ev.data);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        fit();
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      state.ready = true;
      veil('');
    } catch {
      // A corrupt frame is not worth reporting; the next one will land.
    }
  };

  ws.onclose = () => {
    state.ready = false;
    if (ws.__intentional || state.ws !== ws) return;
    veil('reconnecting…');
    state.retry = Math.min(state.retry + 1, 6);
    setTimeout(() => { if (state.ws === ws || !state.ws) connect(); }, Math.min(4000, 250 * 2 ** state.retry));
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/* --------------------------------------------------------------- viewport */

function fit() {
  const canvas = $('#screen');
  const box = $('#viewport').getBoundingClientRect();
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
  canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
}

addEventListener('resize', () => {
  fit();
  clearTimeout(fit.timer);
  fit.timer = setTimeout(syncViewport, 500);
});

/** Keep the remote page the same shape as this window, like a real browser. */
async function syncViewport() {
  if (!state.session) return;
  const want = desiredViewport();
  if (Math.abs(want.width - state.viewport.width) < 40 && Math.abs(want.height - state.viewport.height) < 40) return;
  const r = await api(s('/viewport'), { method: 'POST', body: want });
  if (r.ok) state.viewport = r.viewport || want;
}

/* ----------------------------------------------------------------- pointer */

function point(ev) {
  const canvas = $('#screen');
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * canvas.width;
  const y = ((ev.clientY - r.top) / r.height) * canvas.height;
  return { x: Math.round(x), y: Math.round(y), inside: x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height };
}

const screen = $('#screen');

screen.addEventListener('click', (ev) => {
  const { x, y } = point(ev);
  send({ type: 'mouse', action: 'click', x, y, clickCount: 1 });
  maybeOpenKeyboard();
});

screen.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const { x, y } = point(ev);
  send({ type: 'wheel', x, y, dy: Math.round(ev.deltaY), dx: Math.round(ev.deltaX) });
}, { passive: false });

/* ------------------------------------------------------------------- touch */

let touch = null;
let longPress = null;

screen.addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1) { touch = null; return; }
  const t = ev.touches[0];
  const p = point(t);
  touch = { x: p.x, y: p.y, cx: t.clientX, cy: t.clientY, t: Date.now(), moved: 0, scrolled: false };
  longPress = setTimeout(() => {
    if (touch && touch.moved < 12) {
      send({ type: 'mouse', action: 'click', x: touch.x, y: touch.y, button: 'right' });
      touch.consumed = true;
    }
  }, 550);
}, { passive: true });

screen.addEventListener('touchmove', (ev) => {
  if (!touch) return;
  ev.preventDefault();
  const t = ev.touches[0];
  const dyClient = t.clientY - touch.cy;
  const dxClient = t.clientX - touch.cx;
  touch.moved = Math.max(touch.moved, Math.abs(dyClient) + Math.abs(dxClient));

  if (touch.moved > 10 && !touch.scrolled) {
    clearTimeout(longPress);
    touch.scrolled = true;
  }
  if (touch.scrolled) {
    const canvas = $('#screen');
    const r = canvas.getBoundingClientRect();
    const scale = canvas.width / r.width;
    send({ type: 'wheel', x: touch.x, y: touch.y, dy: Math.round(dyClient * scale), dx: Math.round(dxClient * scale) });
    touch.cy = t.clientY;
    touch.cx = t.clientX;
  }
}, { passive: false });

screen.addEventListener('touchend', (ev) => {
  clearTimeout(longPress);
  if (!touch) return;
  const held = Date.now() - touch.t;
  if (touch.scrolled) {
    // A drag is a scroll, not a press.
  } else if (!touch.consumed && touch.moved < 12 && held < 550) {
    send({ type: 'mouse', action: 'click', x: touch.x, y: touch.y, clickCount: 1 });
    maybeOpenKeyboard();
  }
  touch = null;
}, { passive: true });

screen.addEventListener('touchcancel', () => { clearTimeout(longPress); touch = null; }, { passive: true });

/* ---------------------------------------------------------- keyboard bridge */

const kb = $('#kb');

/** Tapping a text field should raise this device's keyboard, like a remote desktop. */
async function maybeOpenKeyboard() {
  if (!state.coarse) return;
  const r = await api(s('/eval'), {
    method: 'POST',
    body: { code: "return (() => { const a = document.activeElement; if (!a) return ''; if (a.isContentEditable) return 'editable'; return String(a.tagName || '') + ':' + String(a.type || ''); })()" },
  }).catch(() => ({}));
  const kind = String(r.value || '');
  if (/^(INPUT|TEXTAREA|SELECT)/.test(kind) || kind === 'editable') focusKeyboard();
}

function focusKeyboard() {
  kb.value = '';
  kb.focus({ preventScroll: true });
}

$('#keyboardBtn').hidden = !state.coarse;
$('#keyboardBtn').addEventListener('click', focusKeyboard);

kb.addEventListener('input', () => {
  const value = kb.value;
  kb.value = '';
  if (value) send({ type: 'text', text: value });
});

kb.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); send({ type: 'key', key: 'Enter' }); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); send({ type: 'key', key: 'Backspace' }); }
  else if (ev.key === 'Escape') { ev.preventDefault(); kb.blur(); }
});

const SPECIAL = {
  Enter: 'Enter', Backspace: 'Backspace', Escape: 'Escape', Tab: 'Tab',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete',
};

document.addEventListener('keydown', (ev) => {
  const typing = ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA';
  const meta = ev.metaKey || ev.ctrlKey;

  if (meta && !ev.shiftKey && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === 'l') { ev.preventDefault(); $('#url').focus(); $('#url').select(); return; }
    if (k === 't') { ev.preventDefault(); newTab(); return; }
    if (k === 'w') { ev.preventDefault(); if (state.active) closeTab(state.active); return; }
    if (k === 'r') { ev.preventDefault(); reload(); return; }
  }
  if (typing) return;
  if (ev.key === 'F5') { ev.preventDefault(); reload(); return; }

  if (SPECIAL[ev.key]) {
    ev.preventDefault();
    send({ type: 'key', key: SPECIAL[ev.key] });
    return;
  }
  if (ev.key.length === 1 && !meta && !ev.altKey) {
    send({ type: 'text', text: ev.key });
  }
});

/* ----------------------------------------------------------------- toolbar */

function go(raw) {
  const value = String(raw || '').trim();
  if (!value) return;
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) url = value;
  else if (/^localhost(:\d+)?(\/|$)/i.test(value)) url = 'http://' + value;
  else if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(value)) url = 'https://' + value;
  else url = `https://www.bing.com/search?q=${encodeURIComponent(value)}`;

  $('#progress').hidden = false;
  if (!send({ type: 'nav', url })) {
    api(s('/goto'), { method: 'POST', body: { url } });
  }
  setTimeout(() => { $('#progress').hidden = true; refreshTabs(); }, 900);
  setTimeout(refreshTabs, 2200);
  $('#url').blur();
}

$('#omnibox').addEventListener('submit', (ev) => {
  ev.preventDefault();
  go($('#url').value);
});

function reload() { send({ type: 'key', key: 'F5' }); setTimeout(refreshTabs, 700); }

$('#reload').addEventListener('click', reload);
$('#back').addEventListener('click', () => { send({ type: 'key', key: 'Alt+Left' }); setTimeout(refreshTabs, 700); });
$('#fwd').addEventListener('click', () => { send({ type: 'key', key: 'Alt+Right' }); setTimeout(refreshTabs, 700); });
$('#newTab').addEventListener('click', () => newTab());

$('#fullscreenBtn').addEventListener('click', fullscreen);

function fullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else root.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
}

/* -------------------------------------------------------------------- menu */

const menu = $('#menu');
$('#menuBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', () => { menu.hidden = true; });
addEventListener('keydown', (ev) => { if (ev.key === 'Escape') menu.hidden = true; });

menu.addEventListener('click', async (ev) => {
  const act = ev.target.dataset?.act;
  if (!act) return;
  menu.hidden = true;
  if (act === 'newtab') newTab();
  if (act === 'reload') reload();
  if (act === 'fullscreen') fullscreen();
  if (act === 'copy') {
    const url = $('#url').value;
    try { await navigator.clipboard.writeText(url); toast('Address copied'); }
    catch { toast(url); }
  }
  if (act === 'console') {
    const q = new URLSearchParams({ session: state.session });
    if (state.token) q.set('token', state.token);
    window.open('/console?' + q.toString(), '_blank', 'noopener');
  }
  if (act === 'signout') {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(SESSION_KEY);
    location.href = '/';
  }
});

/* -------------------------------------------------------------------- boot */

boot();
fit();

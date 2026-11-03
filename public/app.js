/**
 * The human side: a plain browser window.
 * Tabs, an address bar, a live view. Everything else lives at /console.
 */

const $ = (sel) => document.querySelector(sel);
const qs = new URLSearchParams(location.search);

const state = {
  token: '',
  session: qs.get('session') || '',
  tabs: [],
  active: null,
  ws: null,
  scale: { x: 1, y: 1 },
  viewport: { width: 1280, height: 800 },
};

/* ------------------------------------------------------------------ token */

if (qs.get('token')) {
  localStorage.setItem('iw-token', qs.get('token'));
  qs.delete('token');
  history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : ''));
}
state.token = localStorage.getItem('iw-token') || '';

function gate() {
  const el = document.createElement('div');
  el.className = 'gate';
  el.innerHTML = `<form><h1>This browser is private</h1>
    <p>Paste the access token or the console PIN.</p>
    <input id="gateInput" autocomplete="off" spellcheck="false" />
    <button>Open</button></form>`;
  document.body.appendChild(el);
  const input = el.querySelector('#gateInput');
  input.focus();
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    state.token = t;
    localStorage.setItem('iw-token', t);
    const ok = await api('/api/sessions', { method: 'GET' }).then((r) => r.ok).catch(() => false);
    if (!ok) {
      state.token = '';
      localStorage.removeItem('iw-token');
      input.value = '';
      input.placeholder = 'That did not work — try again';
      return;
    }
    el.remove();
    boot();
  };
}

/* -------------------------------------------------------------------- api */

async function api(path, { method = 'POST', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.ok !== false, status: res.status, ...json };
}

const s = (path) => `/api/s/${state.session}${path}`;

/* ------------------------------------------------------------------- boot */

async function boot() {
  const list = await api('/api/sessions', { method: 'GET' });
  if (!list.ok) { gate(); return; }

  const sessions = list.sessions || [];
  if (!state.session) {
    const pick = sessions.find((x) => x.name === 'classroom') || sessions[0];
    state.session = pick ? pick.id : '';
  }
  if (!state.session) {
    const made = await api('/api/sessions', { method: 'POST', body: { name: 'human', url: 'about:blank' } });
    state.session = made.session?.id || '';
  }
  if (!state.session) { $('#veilText').textContent = 'could not open a session'; return; }

  $('#sessionName').textContent = state.session;
  await refreshTabs();
  connect();
  setInterval(refreshTabs, 4000);
}

/* ------------------------------------------------------------------- tabs */

async function refreshTabs() {
  const r = await api(s('/tabs'), { method: 'GET' });
  if (!r.ok) return;
  state.tabs = r.tabs || [];
  state.active = r.active;
  renderTabs();
  const cur = state.tabs.find((t) => t.id === state.active);
  if (cur && document.activeElement !== $('#url')) {
    $('#url').value = cur.url === 'about:blank' ? '' : cur.url;
    $('#lock').dataset.insecure = /^https:/i.test(cur.url) ? '0' : '1';
  }
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.active ? ' active' : '');
    const label = t.title || (t.url && t.url !== 'about:blank' ? new URL(t.url).hostname : 'New tab');
    el.innerHTML = `<span class="fav"></span><span class="name"></span><button class="x" title="Close">×</button>`;
    el.querySelector('.name').textContent = label;
    el.title = t.url || '';
    el.onclick = async (e) => {
      if (e.target.classList.contains('x')) { await closeTab(t.id); return; }
      await api(s('/tabs'), { body: { action: 'activate', id: t.id } });
      await refreshTabs();
      connect();
    };
    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    wrap.appendChild(el);
  }
}

async function newTab(url) {
  await api(s('/tabs'), { body: { action: 'new', url: url || 'about:blank' } });
  await refreshTabs();
  connect();
}

async function closeTab(id) {
  if (state.tabs.length === 1) { await newTab(); }
  await api(s('/tabs'), { body: { action: 'close', id } });
  await refreshTabs();
  connect();
}

/* ------------------------------------------------------------------- live */

function connect() {
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${s('/live')}${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`);
  state.ws = ws;
  const canvas = $('#screen');
  const ctx = canvas.getContext('2d');
  const img = new Image();

  ws.onmessage = async (ev) => {
    // Frames are binary JPEGs; control messages are JSON strings.
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello') {
          state.viewport = msg.viewport || state.viewport;
          canvas.width = state.viewport.width;
          canvas.height = state.viewport.height;
        }
        if (msg.type === 'error') $('#veilText').textContent = msg.error;
      } catch {}
      return;
    }
    try {
      const bmp = await createImageBitmap(ev.data);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      $('#veil').hidden = true;
    } catch {}
  };
  ws.onclose = () => { setTimeout(() => { if (state.ws === ws) connect(); }, 1500); };
}

/* ---------------------------------------------------------------- pointer */

function point(ev) {
  const canvas = $('#screen');
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * canvas.width;
  const y = ((ev.clientY - r.top) / r.height) * canvas.height;
  return { x: Math.round(x), y: Math.round(y) };
}

const send = (msg) => { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg)); };

$('#screen').addEventListener('click', (ev) => {
  const { x, y } = point(ev);
  send({ type: 'mouse', action: 'click', x, y, clickCount: 1 });
});

$('#screen').addEventListener('wheel', (ev) => {
  ev.preventDefault();
  send({ type: 'wheel', dy: Math.round(ev.deltaY), dx: Math.round(ev.deltaX) });
}, { passive: false });

document.addEventListener('keydown', async (ev) => {
  const typing = ev.target.tagName === 'INPUT';
  if (typing) return;
  const special = { Enter: 'Enter', Backspace: 'Backspace', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  if (special[ev.key]) {
    ev.preventDefault();
    send({ type: 'key', key: special[ev.key] });
    return;
  }
  if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
    send({ type: 'text', text: ev.key });
  }
});

/* --------------------------------------------------------------- toolbar */

$('#omnibox').onsubmit = async (ev) => {
  ev.preventDefault();
  const raw = $('#url').value.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : /^[\w-]+(\.[\w-]+)+/.test(raw) ? 'https://' + raw : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  if (state.ws?.readyState === 1) send({ type: 'nav', url });
  else await api(s('/goto'), { body: { url } });
  setTimeout(refreshTabs, 900);
};

$('#back').onclick = async () => { await api(s('/act'), { body: { steps: [{ back: true }], observe: false } }); refreshTabs(); };
$('#fwd').onclick = async () => { await api(s('/act'), { body: { steps: [{ forward: true }], observe: false } }); refreshTabs(); };
$('#reload').onclick = async () => { await api(s('/act'), { body: { steps: [{ reload: true }], observe: false } }); refreshTabs(); };
$('#newTab').onclick = () => newTab();

$('#menuBtn').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('click', () => { $('#menu').hidden = true; });

$('#menu').onclick = async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  $('#menu').hidden = true;
  if (act === 'newtab') newTab();
  if (act === 'reload') $('#reload').click();
  if (act === 'copy') navigator.clipboard?.writeText($('#url').value);
  if (act === 'dev') {
    const q = new URLSearchParams({ session: state.session });
    if (state.token) q.set('token', state.token);
    window.open('/console?' + q.toString(), '_blank');
  }
};


/* -------------------------------------------------------------------- go */

if (state.token || !state.token) boot();

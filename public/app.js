const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  token: '',
  sessions: [],
  current: null,
  pulse: null,
  samples: [],
  timerBase: null,
  treeText: '',
  ws: null,
  sse: null,
  control: false,
  fps: { n: 0, t: performance.now(), last: 0 },
  retry: 0,
  pending: false,
  posterShown: false,
};

const el = {
  status: $('#status'), statusText: $('#statusText'), lat: $('#lat'), obs: $('#obs'),
  sessions: $('#sessions'), sessionCount: $('#sessionCount'), railEmpty: $('#railEmpty'),
  urlbar: $('#urlbar'), urlInput: $('#urlInput'), openForm: $('#openForm'),
  screen: $('#screen'), canvas: $('#live'), poster: $('#poster'), empty: $('#empty'),
  liveChip: $('#liveChip'), fps: $('#fps'), toast: $('#toast'), sorry: $('#sorry'),
  timer: $('#timer'), timerMeta: $('#timerMeta'), timerSrc: $('#timerSrc'), spark: $('#spark'),
  kvFocus: $('#kvFocus'), kvChange: $('#kvChange'), kvView: $('#kvView'), kvSeq: $('#kvSeq'),
  numbers: $('#numbers'), alerts: $('#alerts'), tree: $('#tree'), treeTitle: $('#treeTitle'), treeBytes: $('#treeBytes'),
  log: $('#log'), logMeta: $('#logMeta'), intentMsg: $('#intentMsg'), code: $('#code'),
  gate: $('#gate'), gateForm: $('#gateForm'), tokenInput: $('#tokenInput'), gateMsg: $('#gateMsg'),
};

/* ------------------------------------------------------------------ token */

const qs = new URLSearchParams(location.search);
const simpleMode = ['/', '/google', '/go'].includes(location.pathname) || qs.get('simple') === '1';
if (simpleMode) document.body.classList.add('simple');
const bootSession = qs.get('session') || '';
const bootUrl = qs.get('url') || (location.pathname === '/google' ? 'https://www.google.com' : '');
if (qs.get('token')) {
  localStorage.setItem('iw-token', qs.get('token'));
  qs.delete('token');
  history.replaceState({}, '', location.pathname + (qs.toString() ? '?' + qs : ''));
}
state.token = localStorage.getItem('iw-token') || '';

function showGate() {
  el.gate.classList.remove('hidden');
  setTimeout(() => el.tokenInput.focus(), 30);
}

el.gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = el.tokenInput.value.trim();
  if (!t) return;
  // A short numeric code is the console PIN; a long string is a bearer token.
  if (/^\d{4,10}$/.test(t)) {
    el.gateMsg.textContent = 'Signing in…';
    el.tokenInput.disabled = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: t }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        el.gateMsg.textContent = d.error === 'too_many_attempts' ? 'Too many tries — wait 5 minutes.' : 'Wrong PIN. Try again.';
        el.tokenInput.value = '';
        el.tokenInput.focus();
        return;
      }
      state.token = '';
      localStorage.removeItem('iw-token');
      el.gate.classList.add('hidden');
      boot();
      return;
    } catch {
      el.gateMsg.textContent = 'Login failed — check the connection and try again.';
      return;
    } finally {
      el.tokenInput.disabled = false;
    }
  }
  state.token = t;
  localStorage.setItem('iw-token', t);
  el.gate.classList.add('hidden');
  boot();
});

/* -------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch {}
  if (r.status === 401) {
    if (state.token) { state.token = ''; localStorage.removeItem('iw-token'); }
    showGate();
    throw new Error('unauthorized');
  }
  if (!r.ok && data && data.ok === false) return { ...data, _status: r.status };
  if (!r.ok) return { ok: false, error: data?.error || `http_${r.status}`, detail: data?.detail, _status: r.status };
  return data;
}

function setStatus(kind, text) {
  el.status.className = 'status ' + kind;
  el.statusText.textContent = text;
}
let toastTimer;
function toast(msg, err = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('err', err);
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

/* ---------------------------------------------------------------- sessions */

async function refreshSessions() {
  const r = await api('/api/sessions');
  if (!r || r.ok === false) return;
  state.sessions = r.sessions || [];
  renderSessions();
  if (state.current) {
    const still = state.sessions.find((s) => s.id === state.current.id);
    if (still) { state.current = still; updateChrome(); }
    else if (state.sessions.length) { await selectSession(state.sessions[0].id); }
    else { state.current = null; teardown(); showEmpty(true); }
  } else if (state.sessions.length && !state.ws) {
    await selectSession(state.sessions[0].id);
  }
  renderMetrics(r.metrics);
}

function renderSessions() {
  el.sessionCount.textContent = state.sessions.length;
  el.railEmpty.classList.toggle('hidden', state.sessions.length > 0);
  el.sessions.innerHTML = '';
  for (const s of state.sessions) {
    const b = document.createElement('button');
    b.className = 'session' + (state.current && s.id === state.current.id ? ' on' : '');
    b.type = 'button';
    const title = s.title || s.name || 'session';
    const u = (() => { try { const x = new URL(s.url); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return s.url || 'about:blank'; } })();
    b.innerHTML = `<div class="sline"><span class="sdot"></span><span class="sname"></span></div><div class="surl"></div><button class="x" title="Close">×</button>`;
    b.querySelector('.sname').textContent = title;
    b.querySelector('.surl').textContent = u;
    b.addEventListener('click', (e) => {
      if (e.target.closest('.x')) return;
      selectSession(s.id);
    });
    b.querySelector('.x').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/s/${s.id}/close`, { method: 'POST', body: {} });
      if (state.current && state.current.id === s.id) { state.current = null; teardown(); }
      await refreshSessions();
    });
    el.sessions.appendChild(b);
  }
}

async function createSession(url = 'https://www.google.com') {
  const n = state.sessions.length + 1;
  const body = { name: `session ${n}`, url: url || 'https://www.google.com' };
  if (simpleMode) {
    body.viewport = {
      width: Math.max(800, Math.min(1920, innerWidth)),
      height: Math.max(600, Math.min(1200, innerHeight - 42)),
    };
  }
  const r = await api('/api/sessions', { method: 'POST', body });
  if (!r || r.ok === false) { toast(r.error || 'could not create session', true); return null; }
  await refreshSessions();
  await selectSession(r.session.id);
  return r.session.id;
}

async function selectSession(id) {
  if (state.current && state.current.id === id && state.ws) return;
  teardown();
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  state.current = s;
  state.samples = [];
  state.posterShown = false;
  renderSessions();
  updateChrome();
  showEmpty(false);
  el.poster.classList.add('hidden');
  startStream(s.id);
  startLive(s.id);
  loadPoster(s.id);
  loadTimeline();
  const p = await api(`/api/s/${s.id}/pulse`, { method: 'POST', body: {} });
  if (p && p.ok !== false) updatePulse(p);
}

function teardown() {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  el.liveChip.classList.add('hidden');
}

function updateChrome() {
  const s = state.current;
  el.urlbar.textContent = s?.url || 'about:blank';
  el.urlbar.title = s?.url || '';
}

function showEmpty(on) {
  el.empty.classList.toggle('hidden', !on);
  if (on) {
    el.poster.classList.add('hidden');
    el.liveChip.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ pulse */

function startStream(id) {
  if (state.sse) state.sse.close();
  const url = `/api/s/${id}/stream${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`;
  const es = new EventSource(url);
  state.sse = es;
  es.addEventListener('hello', () => setStatus('ok', 'warm'));
  es.addEventListener('pulse', (e) => {
    try { updatePulse(JSON.parse(e.data)); } catch {}
  });
  es.onerror = () => {
    setStatus('warn', 'reconnecting');
  };
}

function updatePulse(p) {
  if (!p || !state.current) return;
  state.pulse = p;
  const c = p.countdown;
  if (c) {
    const v = Number.isFinite(c.est) ? c.est : c.v;
    const ticking = c.dir === 'down' && c.rate > 0 && (c.age || 0) < 150;
    state.timerBase = { v, rate: c.rate || 0, at: performance.now(), ticking };
    setTimerValue(v);
    const rate = c.dir === 'down' ? `rate ${(Math.abs(c.rate || 0) * 1000).toFixed(2)}/s` : c.dir;
    el.timerMeta.textContent = `${c.dir || 'idle'} · ${rate} · sample age ${Math.round(c.age || 0)}ms`;
    el.timerSrc.textContent = c.ref || c.frame || '';
    if (v != null) {
      const last = state.samples[state.samples.length - 1];
      if (last && v > last.v + 2) state.samples = [];
      state.samples.push({ t: performance.now(), v });
      if (state.samples.length > 160) state.samples.shift();
      drawSpark();
    }
  } else {
    state.timerBase = null;
    el.timer.textContent = '—';
    el.timer.className = 'timer';
    el.timerMeta.textContent = 'no timer on this page';
    el.timerSrc.textContent = '';
  }
  el.kvFocus.textContent = p.focus ? `${p.focus.role} "${(p.focus.name || p.focus.tag || '').slice(0, 26)}"` : '—';
  el.kvChange.textContent = Number.isFinite(p.last_change_age_ms) ? `${p.last_change_age_ms} ms ago` : '—';
  el.kvChange.classList.toggle('hot', Number.isFinite(p.last_change_age_ms) && p.last_change_age_ms < 120);
  el.kvView.textContent = p.viewport ? `${p.viewport.w}×${p.viewport.h}` : '—';
  el.kvSeq.textContent = p.seq != null ? String(p.seq) : '—';
  el.numbers.innerHTML = '';
  for (const n of (p.numbers || []).slice(0, 6)) {
    const d = document.createElement('span');
    d.className = 'num';
    d.innerHTML = `<b></b> <span class="${n.delta > 0 ? 'up' : n.delta < 0 ? 'down' : ''}">${n.delta > 0 ? '+' : ''}${n.delta ?? 0}</span>`;
    d.querySelector('b').textContent = `${(n.name || 'num').slice(0, 18)} ${n.value}`;
    el.numbers.appendChild(d);
  }
  el.alerts.innerHTML = '';
  for (const a of [...(p.dialogs || []), ...(p.alerts || [])].slice(0, 3)) {
    const d = document.createElement('div');
    d.className = 'alert';
    d.textContent = a;
    el.alerts.appendChild(d);
  }
  if (p.url) {
    el.urlbar.textContent = p.url;
    el.urlbar.title = p.url;
    // Never leave Google's CAPTCHA in front of the owner.
    const blocked = /google\.[^/]+\/sorry\//i.test(p.url);
    if (el.sorry) el.sorry.classList.toggle('hidden', !blocked);
  }
  if (p.title) setStatus('ok', p.title.slice(0, 34));
}

function setTimerValue(v) {
  if (!Number.isFinite(v)) return;
  el.timer.textContent = formatSeconds(Math.max(0, v));
  el.timer.className = 'timer' + (v < 2 ? ' crit' : v < 5 ? ' low' : '');
}

function tickTimer() {
  const b = state.timerBase;
  if (b && b.ticking) {
    const v = b.v - b.rate * (performance.now() - b.at);
    setTimerValue(v);
  }
  requestAnimationFrame(tickTimer);
}
requestAnimationFrame(tickTimer);

function formatSeconds(v) {
  if (v >= 10) return v.toFixed(2);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function drawSpark() {
  const cv = el.spark;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = cv.clientWidth || 300, h = cv.clientHeight || 52;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const xs = state.samples;
  if (xs.length < 2) return;
  const vs = xs.map((x) => x.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = Math.max(0.001, max - min);
  const pad = 4;
  ctx.beginPath();
  xs.forEach((p, i) => {
    const x = pad + (i / (xs.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (p.v - min) / span) * (h - pad * 2);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#d6ff4f';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineTo(w - pad, h);
  ctx.lineTo(pad, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(214,255,79,.16)');
  g.addColorStop(1, 'rgba(214,255,79,0)');
  ctx.fillStyle = g;
  ctx.fill();
}

/* ------------------------------------------------------------------- live */

function startLive(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/s/${id}/live${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  let drawing = false;
  let queued = null;

  const draw = async (buf) => {
    if (drawing) { queued = buf; return; }
    drawing = true;
    try {
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
      const cv = el.canvas;
      if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
      const ctx = cv.getContext('2d', { alpha: false });
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      el.empty.classList.add('hidden');
      el.poster.classList.add('hidden');
      el.liveChip.classList.remove('hidden');
      state.posterShown = true;
      state.fps.n++;
      const t = performance.now();
      if (t - state.fps.t > 1000) {
        el.fps.textContent = `${Math.round(state.fps.n * 1000 / (t - state.fps.t))} fps`;
        state.fps.n = 0;
        state.fps.t = t;
      }
      state.retry = 0;
      setStatus('ok', 'live');
    } catch {}
    drawing = false;
    if (queued) { const q = queued; queued = null; draw(q); }
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'hello') { setStatus('ok', 'live'); }
        if (m.type === 'error') toast(m.error, true);
      } catch {}
      return;
    }
    draw(ev.data);
  };
  ws.onopen = () => { state.retry = 0; setStatus('ok', 'live'); };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    el.liveChip.classList.add('hidden');
    if (!state.current || state.current.id !== id) return;
    setStatus('warn', 'reconnecting');
    const delay = Math.min(5000, 600 + state.retry++ * 900);
    setTimeout(() => { if (state.current && state.current.id === id && !state.ws) startLive(id); }, delay);
  };
  ws.onerror = () => setStatus('warn', 'socket error');
}

async function loadPoster(id) {
  const r = await api(`/api/s/${id}/screenshot`, { method: 'POST', body: { quality: 62 } });
  if (!r || r.ok === false || !r.data_url || !state.current || state.current.id !== id) return;
  if (state.posterShown) return;
  el.poster.src = r.data_url;
  el.poster.classList.remove('hidden');
  el.empty.classList.add('hidden');
}

/* ------------------------------------------------------------------ input */

function mapPoint(ev) {
  const r = el.canvas.getBoundingClientRect();
  const vp = state.current?.viewport || { width: 1280, height: 800 };
  const x = Math.round((ev.clientX - r.left) / r.width * vp.width);
  const y = Math.round((ev.clientY - r.top) / r.height * vp.height);
  return { x: Math.max(0, Math.min(vp.width - 1, x)), y: Math.max(0, Math.min(vp.height - 1, y)) };
}

function send(msg) {
  if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(msg)); return true; }
  return false;
}

let lastMove = 0;
el.canvas.addEventListener('mousemove', (ev) => {
  if (!state.control) return;
  const now = performance.now();
  if (now - lastMove < 24) return;
  lastMove = now;
  const p = mapPoint(ev);
  send({ type: 'mouse', action: 'move', x: p.x, y: p.y });
});
el.canvas.addEventListener('mousedown', (ev) => {
  if (!state.control) return;
  ev.preventDefault();
  const p = mapPoint(ev);
  el.canvas.focus();
  send({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: ev.button === 2 ? 'right' : 'left' });
});
el.canvas.addEventListener('mouseup', (ev) => {
  if (!state.control) return;
  ev.preventDefault();
  const p = mapPoint(ev);
  send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: ev.button === 2 ? 'right' : 'left' });
});
el.canvas.addEventListener('contextmenu', (ev) => { if (state.control) ev.preventDefault(); });
el.canvas.addEventListener('wheel', (ev) => {
  if (!state.control) return;
  ev.preventDefault();
  const p = mapPoint(ev);
  send({ type: 'wheel', x: p.x, y: p.y, dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY) });
}, { passive: false });

const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);
window.addEventListener('keydown', (ev) => {
  if (!state.control || !state.current) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') return;
  const mods = [];
  if (ev.ctrlKey || ev.metaKey) mods.push('Control');
  if (ev.altKey) mods.push('Alt');
  if (ev.shiftKey) mods.push('Shift');
  let key = ev.key;
  if (key === ' ') key = 'Space';
  const isSpecial = SPECIAL.has(key) || mods.length > 0;
  if (isSpecial) {
    ev.preventDefault();
    send({ type: 'key', key: [...mods, key === ' ' ? 'Space' : key].join('+') });
  } else if (key.length === 1) {
    ev.preventDefault();
    send({ type: 'text', text: key });
  }
}, { capture: true });

/* ------------------------------------------------------------------- tree */

function showTree(text, meta = '') {
  state.treeText = text || '';
  el.tree.textContent = text || '';
  el.treeBytes.textContent = meta || (text ? `${text.length} B` : '');
  if (text) el.treeTitle.textContent = 'Observation';
}

function setTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'log') loadTimeline();
}

/* --------------------------------------------------------------- timeline */

async function loadTimeline() {
  if (!state.current) return;
  const r = await api(`/api/s/${state.current.id}/timeline`);
  if (!r || r.ok === false) return;
  const rows = (r.timeline || []).slice(-70).reverse();
  el.log.innerHTML = '';
  el.logMeta.textContent = `${r.timeline?.length || 0} ev`;
  for (const t of rows) {
    const d = document.createElement('div');
    d.className = 'lrow ' + (t.ok ? 'ok' : 'bad');
    const w = Math.min(100, 8 + 92 * Math.log10(1 + (t.ms || 0)) / Math.log10(2001));
    d.innerHTML = `<span class="op"></span><span class="bar"><i style="width:${w}%"></i></span><span class="ms"></span>`;
    d.querySelector('.op').textContent = `${t.op}${t.detail ? ' · ' + t.detail : ''}`;
    d.querySelector('.ms').textContent = `${(t.ms || 0).toFixed(1)}ms`;
    el.log.appendChild(d);
  }
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'dim';
    d.style.padding = '8px 4px';
    d.textContent = 'no events yet';
    el.log.appendChild(d);
  }
}

async function loadMetrics() {
  const r = await api('/api/metrics');
  if (!r || r.ok === false) return;
  renderMetrics(r);
}

function renderMetrics(m) {
  if (!m || !m.ops) return;
  const pick = m.ops.act?.p50 ?? m.ops.eval?.p50 ?? m.ops.snap?.p50 ?? m.ops.pulse?.p50 ?? m.ops.goto?.p50;
  el.lat.textContent = pick != null ? pick.toFixed(1) : '—';
}

/* -------------------------------------------------------------------- run */

function setBusy(on, msg) {
  state.pending = on;
  $('#run').disabled = on;
  $('#run').style.opacity = on ? .6 : 1;
  if (msg) el.intentMsg.textContent = msg;
}

async function run() {
  if (!state.current || state.pending) return;
  const code = el.code.value.trim();
  if (!code) return;
  const id = state.current.id;
  setBusy(true, 'running…');
  const t0 = performance.now();
  try {
    let r;
    let kind = 'eval';
    if (code.startsWith('!snap')) {
      kind = 'snap';
      const max = Number(code.split(/\s+/)[1]) || 100;
      r = await api(`/api/s/${id}/snap`, { method: 'POST', body: { max } });
      if (r && r.ok !== false) { showTree(r.text, `${r.bytes} B · ${r.elements?.length || 0} els`); el.obs.textContent = `${r.bytes || 0}B`; }
    } else if (code.startsWith('!pulse')) {
      kind = 'pulse';
      r = await api(`/api/s/${id}/pulse`, { method: 'POST', body: {} });
      if (r && r.ok !== false) showTree(JSON.stringify(r.countdown || r, null, 2));
    } else if (code.startsWith('!recipe ')) {
      kind = 'recipe';
      const name = code.split(/\s+/)[1];
      r = await api(`/api/s/${id}/recipe/${encodeURIComponent(name)}`, { method: 'POST', body: {} });
      if (r && r.ok !== false) showTree(JSON.stringify(r, null, 2).slice(0, 16000));
    } else {
      r = await api(`/api/s/${id}/eval`, { method: 'POST', body: { code } });
      if (r && r.ok !== false) {
        const v = r.value;
        if (v && typeof v === 'object' && typeof v.text === 'string') {
          showTree(v.text, `${v.bytes || v.text.length} B · ${v.elements?.length || 0} els`);
        } else if (v && typeof v === 'object' && v.snap && typeof v.snap.text === 'string') {
          showTree(v.snap.text);
        } else {
          showTree(JSON.stringify(v, null, 2).slice(0, 16000));
          if (v && Array.isArray(v.elements)) el.obs.textContent = `${v.text?.length || 0}B`;
        }
      }
    }
    const ms = performance.now() - t0;
    if (r && r.ok === false) {
      const msg = r.error || 'failed';
      el.intentMsg.textContent = `${kind} · ${msg}`;
      toast(`${msg}${r.detail ? ' · ' + String(r.detail).slice(0, 80) : ''}`, true);
      showTree(JSON.stringify(r, null, 2));
      setStatus('err', msg);
    } else {
      el.intentMsg.textContent = `${kind} · ${ms.toFixed(1)} ms round trip${r?.ms != null ? ` · ${r.ms} ms engine` : ''}`;
      setStatus('ok', 'ready');
      loadTimeline();
      if (kind === 'snap' && r) el.obs.textContent = `${r.bytes || 0}B`;
    }
  } catch (e) {
    el.intentMsg.textContent = String(e.message || e);
    toast(String(e.message || e), true);
  } finally {
    setBusy(false);
    if (!el.intentMsg.textContent.startsWith('eval ·') && !el.intentMsg.textContent.startsWith('snap ·')) {
      // keep the timing line
    }
  }
}

/* ----------------------------------------------------------------- actions */

$('#run').addEventListener('click', run);
el.code.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});

$('#reload').addEventListener('click', async () => {
  if (!state.current) return;
  await api(`/api/s/${state.current.id}/act`, { method: 'POST', body: { steps: [{ reload: true }], observe: false, verify: 'none' } });
  toast('reloaded');
  refreshSessions();
});

$('#shot').addEventListener('click', async () => {
  if (!state.current) return;
  const r = await api(`/api/s/${state.current.id}/screenshot`, { method: 'POST', body: { quality: 82 } });
  if (r?.data_url) { el.poster.src = r.data_url; el.poster.classList.remove('hidden'); toast(`screenshot · ${r.bytes} B · ${r.ms} ms`); }
});

$('#control').addEventListener('click', () => {
  state.control = !state.control;
  $('#control').setAttribute('aria-pressed', String(state.control));
  el.screen.classList.toggle('controlling', state.control);
  if (state.control) el.canvas.focus();
  toast(state.control ? 'control on — clicks and keys go to the page' : 'control off — agents only');
});

$('#fullScreen').addEventListener('click', () => {
  const id = state.current && state.current.id;
  location.href = id ? `/google?session=${encodeURIComponent(id)}` : '/';
});
$('#sorryBack').addEventListener('click', async () => {
  if (!state.current) return;
  await api(`/api/s/${state.current.id}/navigate`, { method: 'POST', body: { url: 'https://www.google.com' } });
  el.sorry.classList.add('hidden');
  toast('Back to Google');
});
$('#newSession').addEventListener('click', () => createSession());
$('#emptyNew').addEventListener('click', () => createSession());
$('#emptyDemo').addEventListener('click', () => createSession('https://www.google.com'));

el.openForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let url = el.urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  el.urlInput.value = '';
  if (state.current) {
    const r = await api(`/api/s/${state.current.id}/navigate`, { method: 'POST', body: { url } });
    if (r && r.ok === false) toast(r.error || 'navigation failed', true);
    refreshSessions();
  } else {
    await createSession(url);
  }
});

$$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

const EXAMPLES = {
  snap: '!snap 100',
  pulse: '!pulse',
  timer: `// fires in-page at 8 ms when the countdown crosses 2 s — no model round trip\nreturn iw.reflex({\n  until: "snap.countdown && snap.countdown.est < 2",\n  do: "iw.log('reflex fired at ' + snap.countdown.est.toFixed(3))",\n  every_ms: 8,\n  timeout_ms: 12000\n})`,
  docs: `return iw.read(undefined, 1200)`,
  quiz: '!recipe quiz.state',
};
$$('#examples button').forEach((b) => b.addEventListener('click', () => {
  el.code.value = EXAMPLES[b.dataset.ex] || '';
  el.code.focus();
}));

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && document.activeElement !== el.tokenInput) {
    e.preventDefault();
    run();
  }
});

/* -------------------------------------------------------------------- boot */

let metricsTimer;
async function boot() {
  setStatus('warn', 'connecting');
  try {
    await refreshSessions();
    const wanted = bootSession && state.sessions.find((s) => s.id === bootSession);
    if (wanted) {
      await selectSession(bootSession);
      qs.delete('session');
      history.replaceState({}, '', location.pathname + (qs.toString() ? '?' + qs : ''));
    } else if (bootUrl) {
      const target = /^https?:\/\//i.test(bootUrl) ? bootUrl : 'https://' + bootUrl;
      await createSession(target);
      qs.delete('url');
      qs.delete('q');
      history.replaceState({}, '', location.pathname + (qs.toString() ? '?' + qs : ''));
      if (!simpleMode) {
        el.code.value = 'return iw.snap({ max: 100 })';
        setTimeout(run, 250);
      }
    } else if (!state.sessions.length) {
      // A new browser should land on the web, not a white about:blank.
      await createSession('https://www.google.com');
    }
    clearInterval(metricsTimer);
    metricsTimer = setInterval(loadMetrics, 4000);
    loadMetrics();
    setInterval(async () => {
      if (document.visibilityState === 'visible') {
        const r = await api('/api/sessions');
        if (r && r.sessions) { state.sessions = r.sessions; renderSessions(); updateChrome(); }
      }
    }, 8000);
  } catch (e) {
    if (String(e.message) !== 'unauthorized') setStatus('err', 'offline');
  }
}

// Cookie auth (PIN) is preferred; boot() will show the gate on a 401.
boot();

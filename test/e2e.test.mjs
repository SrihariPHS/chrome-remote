import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18000 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
let server, dataDir;

const api = async (p, body, method) => {
  const r = await fetch(BASE + p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json();
};

const close = (id) => api(`/api/s/${id}/close`, {});

const waitHealth = async () => {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'iw-test-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, IW_PORT: String(PORT), IW_DATA: dataDir, IW_TOKEN: TOKEN, IW_MAX_SESSIONS: '12', IW_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  server.on('exit', (c) => { if (c) console.error('server exited', c, log.slice(-2000)); });
  await waitHealth();
});

after(async () => {
  if (server) { server.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1300)); }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test('health reports a warm browser', async () => {
  // A cold CI runner can take 10-20 s to bring Chromium up, so wait for the
  // browser to actually be warm instead of assuming it landed inside 6 s.
  let h;
  for (let i = 0; i < 300; i++) {
    h = await api('/health');
    if (h.browser) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(h.ok, true);
  assert.equal(h.browser, true, 'browser did not warm up within 30 s');
  assert.ok(h.launch_ms > 0);
});

test('snapshot is compact, ref-tagged, and deduped', async () => {
  const c = await api('/api/sessions', { name: 'kahoot', url: BASE + '/fixtures/kahoot.html?limit=20' });
  const id = c.session.id;
  const s = await api(`/api/s/${id}/snap`, { max: 60 });
  assert.equal(s.ok, true);
  assert.ok(s.bytes < 6000, `bytes ${s.bytes}`);
  assert.match(s.text, /@e\d+ button "Mars"/);
  assert.match(s.text, /# chrome "Kahoot!/);
  // inner text of a button must not be a second element
  const marsRows = s.elements.filter((e) => e.name === 'Mars');
  assert.equal(marsRows.length, 1, JSON.stringify(marsRows));
  await close(id);
});

test('timer is read to within a frame of the page truth', async () => {
  const c = await api('/api/sessions', { name: 'timer', url: BASE + '/fixtures/kahoot.html?limit=20' });
  const id = c.session.id;
  await new Promise((r) => setTimeout(r, 1300));
  const r = await api(`/api/s/${id}/eval`, { code: 'const p = iw.pulse(), t = window.__truth(); return { delta: p.countdown.est * 1000 - t.remaining_ms, dir: p.countdown.dir, rate: p.countdown.rate * 1000, age: p.countdown.age, text: p.countdown.text }' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.value.delta) < 40, `delta ${r.value.delta}`);
  assert.equal(r.value.dir, 'down');
  assert.ok(r.value.rate > 0.9 && r.value.rate < 1.1, `rate ${r.value.rate}`);
  await close(id);
});

test('an in-page reflex fires on a countdown in single-digit ms', async () => {
  const c = await api('/api/sessions', { name: 'reflex', url: BASE + '/fixtures/kahoot.html?limit=5' });
  const id = c.session.id;
  const r = await api(`/api/s/${id}/reflex`, { until: 'snap.countdown && snap.countdown.est < 2.2', do: "iw.click({text:'Mars'})", every_ms: 8, timeout_ms: 7000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.fired, 1);
  assert.ok(r.reaction_ms < 40, `reaction ${r.reaction_ms}`);
  const t = await api(`/api/s/${id}/eval`, { code: 'return window.__truth()' });
  assert.equal(t.value.answered, true);
  assert.ok(t.value.score > 0, JSON.stringify(t.value));
  await close(id);
});

test('one act batch fills and submits an eight-field form', async () => {
  const c = await api('/api/sessions', { name: 'form', url: BASE + '/fixtures/form.html' });
  const id = c.session.id;
  const r = await api(`/api/s/${id}/act`, {
    steps: [
      { fill: { selector: 'input[name=name]', text: 'Ada Lovelace' } },
      { fill: { selector: 'input[name=email]', text: 'ada@example.com' } },
      { select: { selector: 'select[name=role]', value: 'engineer' } },
      { click: { text: 'Pro' } },
      { click: { text: 'I agree' } },
      { fill: { selector: 'textarea[name=notes]', text: 'one batch, six steps' } },
      { click: { text: 'Create account' } },
    ],
    verify: 'change',
  });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.ok(r.steps.every((s) => s.ok), JSON.stringify(r.steps));
  assert.ok(r.ms < 5000, `batch took ${r.ms}`);
  const v = await api(`/api/s/${id}/eval`, { code: 'return { title: document.title, out: document.querySelector("#result").innerText, values: Object.fromEntries(new FormData(document.querySelector("form"))) }' });
  assert.equal(v.value.title, 'Account created');
  assert.match(v.value.out, /ada@example\.com/);
  assert.equal(v.value.values.name, 'Ada Lovelace');
  assert.equal(v.value.values.role, 'engineer');
  assert.equal(v.value.values.plan, 'pro');
  assert.equal(v.value.values.terms, 'on');
  await close(id);
});

test('doc.append lands text in a Docs-style editor', async () => {
  const c = await api('/api/sessions', { name: 'docs', url: BASE + '/fixtures/docs.html' });
  const id = c.session.id;
  const before = await api(`/api/s/${id}/eval`, { code: 'return document.querySelector("#wordcount").innerText' });
  const r = await api(`/api/s/${id}/recipe/doc.append`, { text: 'Photosynthesis converts light energy into chemical energy.' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = await api(`/api/s/${id}/eval`, { code: 'return { text: document.querySelector("#editor").innerText, words: document.querySelector("#wordcount").innerText }' });
  assert.match(after.value.text, /Photosynthesis converts light energy/);
  assert.notEqual(after.value.words, before.value);
  await close(id);
});

test('quiz.state finds the question, answers, timer and score', async () => {
  const c = await api('/api/sessions', { name: 'quiz', url: BASE + '/fixtures/kahoot.html?limit=20' });
  const id = c.session.id;
  const r = await api(`/api/s/${id}/recipe/quiz.state`, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.question, /Red Planet/);
  assert.equal(r.value.answers.length, 4);
  assert.equal(r.value.answers[1].text, 'Mars');
  assert.ok(r.value.countdown && r.value.countdown.dir === 'down');
  await close(id);
});

test('screenshot is a real JPEG', async () => {
  const c = await api('/api/sessions', { name: 'shot', url: BASE + '/fixtures/form.html' });
  const r = await api(`/api/s/${c.session.id}/screenshot`, { quality: 70 });
  assert.equal(r.ok, true);
  assert.ok(r.bytes > 2000, `bytes ${r.bytes}`);
  assert.match(r.data_url, /^data:image\/jpeg;base64,/);
  await close(c.session.id);
});

test('live screencast delivers frames over websocket', async () => {
  const c = await api('/api/sessions', { name: 'live', url: BASE + '/fixtures/kahoot.html' });
  const id = c.session.id;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/s/${id}/live?token=${encodeURIComponent(TOKEN)}`);
  const frame = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no frame')), 8000);
    ws.on('message', (data, isBinary) => { if (isBinary) { clearTimeout(to); resolve(data.length); } });
    ws.on('error', reject);
  });
  assert.ok(frame > 1000, `frame ${frame}`);
  ws.close();
  await close(id);
});

test('MCP initialize, list and call work', async () => {
  const opened = await api('/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'chrome_open', arguments: { name: 'mcp', url: BASE + '/fixtures/form.html' } } });
  assert.equal(opened.result.isError, false);
  const init = await api('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'chrome.inkwork.studio');
  const list = await api('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.length >= 8);
  const sessions = await api('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chrome_sessions', arguments: {} } });
  assert.equal(sessions.result.isError, false);
  const pulse = await api('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chrome_pulse', arguments: {} } });
  assert.equal(pulse.result.isError, false);
  assert.match(pulse.result.content[0].text, /url/);
  const sid = JSON.parse(opened.result.content[0].text).session;
  await close(sid);
});

test('cross-origin iframe is observed and clicked with the right offset', async () => {
  const c = await api('/api/sessions', { name: 'frames', url: BASE + '/fixtures/frames.html' });
  const id = c.session.id;
  await new Promise((r) => setTimeout(r, 250));
  const s = await api(`/api/s/${id}/snap`, { max: 140 });
  assert.equal(s.ok, true);
  assert.ok(s.frames.length >= 2, JSON.stringify(s.frames));
  assert.match(s.text, /@f\d+:e\d+ textbox "Full name"/);
  const email = s.elements.find((e) => e.name === 'Email');
  assert.ok(email, JSON.stringify(s.elements.map((e) => e.name)));
  const r = await api(`/api/s/${id}/act`, {
    steps: [
      { fill: { ref: email.ref, text: 'frame@example.com' } },
      { click: { text: 'Create account' } },
    ],
    verify: 'change',
  });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.equal(r.changed, true);
  const s2 = await api(`/api/s/${id}/snap`, { max: 140 });
  assert.match(s2.text, /frame@example\.com/);
  await close(id);
});

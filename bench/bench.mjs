/**
 * Benchmarks that matter for agent computer use:
 *  - warm observation (snap / pulse) vs the screenshot path
 *  - one intent = one batch, end to end
 *  - reflex reaction measured inside the page
 *  - bytes returned to the model
 *
 * Run: node bench/bench.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 19000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'bench-' + Math.random().toString(36).slice(2);
const dataDir = await mkdtemp(path.join(tmpdir(), 'iw-bench-'));
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, IW_PORT: String(PORT), IW_DATA: dataDir, IW_TOKEN: TOKEN, IW_MAX_SESSIONS: '3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json();
};

async function waitHealth() {
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) { const h = await r.json(); if (h.browser) return h; } } catch {}
    await sleep(100);
  }
  throw new Error('no warm server: ' + log.slice(-800));
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const stat = async (label, n, fn, warm = 2, before = null) => {
  for (let i = 0; i < warm; i++) { if (before) await before(i).catch(() => {}); await fn(i).catch(() => {}); }
  const xs = [];
  const server = [];
  let last;
  for (let i = 0; i < n; i++) {
    if (before) await before(i);
    const t = performance.now();
    last = await fn(i);
    xs.push(performance.now() - t);
    if (last && Number.isFinite(last.ms)) server.push(last.ms);
  }
  xs.sort((a, b) => a - b); server.sort((a, b) => a - b);
  return {
    label, n,
    p50: +pct(xs, 0.5).toFixed(2),
    p95: +pct(xs, 0.95).toFixed(2),
    max: +xs[xs.length - 1].toFixed(2),
    engine_p50: server.length ? +pct(server, 0.5).toFixed(2) : null,
  };
};

try {
  const health = await waitHealth();
  const results = { when: new Date().toISOString(), loadavg: loadavg().map((x) => +x.toFixed(2)), launch_ms: health.launch_ms, node: process.version };

  const form = await api('/api/sessions', { name: 'bench-form', url: BASE + '/fixtures/form.html' });
  const fid = form.session.id;
  const kahoot = await api('/api/sessions', { name: 'bench-kahoot', url: BASE + '/fixtures/kahoot.html?limit=8' });
  const kid = kahoot.session.id;

  results.create_ms = form.session.create_ms;
  results.rows = [];

  results.rows.push(await stat('snap (full, ≤100 els)', 25, () => api(`/api/s/${fid}/snap`, { max: 100 })));
  results.rows.push(await stat('pulse (timers + focus)', 50, () => api(`/api/s/${fid}/pulse`, {})));
  results.rows.push(await stat('eval (round trip)', 50, () => api(`/api/s/${fid}/eval`, { code: 'return document.title' })));
  results.rows.push(await stat('screenshot jpeg q72', 12, () => api(`/api/s/${fid}/screenshot`, { quality: 72 })));

  const steps = [
    { fill: { selector: 'input[name=name]', text: 'Ada Lovelace' } },
    { fill: { selector: 'input[name=email]', text: 'ada@example.com' } },
    { select: { selector: 'select[name=role]', value: 'engineer' } },
    { click: { text: 'Team' } },
    { click: { text: 'I agree' } },
    { fill: { selector: 'textarea[name=notes]', text: 'one batch' } },
    { click: { text: 'Create account' } },
    { click: { text: 'Create account' } },
  ];
  let obsBytes = 0;
  results.rows.push(await stat('act: 8-step form batch + obs', 15, async () => {
    const r = await api(`/api/s/${fid}/act`, { steps, verify: 'change' });
    if (r.obs) obsBytes = r.obs.bytes;
    return r;
  }, 1, () => api(`/api/s/${fid}/navigate`, { url: BASE + '/fixtures/form.html' })));

  results.rows.push(await stat('act: same batch, dom input', 15, () => api(`/api/s/${fid}/act`, { steps, verify: 'change', input: 'dom' }), 1, () => api(`/api/s/${fid}/navigate`, { url: BASE + '/fixtures/form.html' })));

  const snap = await api(`/api/s/${fid}/snap`, { max: 100 });
  const pulse = await api(`/api/s/${kid}/pulse`, {});
  results.snapshot_bytes = snap.bytes;
  results.snapshot_elements = snap.elements.length;
  results.pulse_bytes = JSON.stringify(pulse).length;
  results.act_obs_bytes = obsBytes;

  // Reflex: arm before the countdown crosses the threshold, measure in-page reaction.
  const reactions = [];
  for (let i = 0; i < 3; i++) {
    await api(`/api/s/${kid}/navigate`, { url: BASE + `/fixtures/kahoot.html?limit=6&run=${i}` });
    await sleep(300);
    const r = await api(`/api/s/${kid}/reflex`, {
      until: 'snap.countdown && snap.countdown.est < 4.6',
      do: "iw.click({text:'Mars'})",
      every_ms: 8,
      timeout_ms: 5000,
    });
    if (r.ok) reactions.push(r.reaction_ms);
    await sleep(80);
  }
  reactions.sort((a, b) => a - b);
  results.reflex = { n: reactions.length, p50_ms: +pct(reactions, 0.5).toFixed(2), max_ms: +reactions[reactions.length - 1].toFixed(2) };

  // Timer truth accuracy, in one eval so both readings share a clock.
  await api(`/api/s/${kid}/navigate`, { url: BASE + '/fixtures/kahoot.html?limit=20' });
  await sleep(1300);
  const acc = await api(`/api/s/${kid}/eval`, { code: 'const p=iw.pulse(), t=window.__truth(); return { delta_ms: +(p.countdown.est*1000 - t.remaining_ms).toFixed(2), rate: +(p.countdown.rate*1000).toFixed(3), age_ms: +p.countdown.age.toFixed(1) }' });
  results.timer_accuracy = acc.value;

  results.rows.push({ label: 'reflex reaction (in-page)', n: reactions.length, p50: results.reflex.p50_ms, p95: results.reflex.max_ms, max: results.reflex.max_ms, engine_p50: results.reflex.p50_ms });
  results.after_loadavg = loadavg().map((x) => +x.toFixed(2));

  await mkdir(path.join(ROOT, 'bench', 'results'), { recursive: true });
  const file = path.join(ROOT, 'bench', 'results', `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(results, null, 2));

  console.log('\nchrome.inkwork.studio — bench\n');
  console.log(`load ${results.loadavg.join(' / ')} → ${results.after_loadavg.join(' / ')}  ·  browser warm ${results.launch_ms} ms  ·  session create ${results.create_ms} ms`);
  console.log('| operation | n | p50 | p95 | max | engine p50 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const r of results.rows) console.log(`| ${r.label} | ${r.n} | ${r.p50} ms | ${r.p95} ms | ${r.max} ms | ${r.engine_p50 ?? '—'} ms |`);
  console.log(`\nobservation: ${results.snapshot_elements} refs, ${results.snapshot_bytes} B; post-act obs ${results.act_obs_bytes} B`);
  console.log(`timer accuracy: ${results.timer_accuracy.delta_ms} ms, rate ${results.timer_accuracy.rate}/s, sample age ${results.timer_accuracy.age_ms} ms`);
  console.log(`\n→ ${file}\n`);
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

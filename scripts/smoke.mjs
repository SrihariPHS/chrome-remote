/**
 * Smoke test against an already-running service.
 *   node scripts/smoke.mjs [base-url]
 * Uses data/token unless IW_TOKEN is set.
 */
import { readFile } from 'node:fs/promises';

const base = process.argv[2] || process.env.IW_URL || 'http://127.0.0.1:8787';
const token = process.env.IW_TOKEN || (await readFile(new URL('../data/token', import.meta.url), 'utf8')).trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const call = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(d).slice(0, 300)}`);
  return d;
};

const health = await fetch(base + '/health').then((r) => r.json());
if (!health.ok) throw new Error('health not ok');
console.log(`health   ok · browser ${health.browser ? 'warm' : 'cold'} · ${health.sessions} sessions`);

const created = await call('/api/sessions', { name: 'smoke', url: 'https://example.com' });
const id = created.session.id;
console.log(`session  ${id} · ${created.session.create_ms} ms`);

const snap = await call(`/api/s/${id}/snap`, { max: 40 });
console.log(`snap     ${snap.ms} ms · ${snap.bytes} B · ${snap.elements.length} refs · ${snap.title}`);

const pulse = await call(`/api/s/${id}/pulse`, {});
console.log(`pulse    ${pulse.ms} ms · focus ${pulse.focus ? pulse.focus.role : '—'} · seq ${pulse.seq}`);

const shot = await call(`/api/s/${id}/screenshot`, { quality: 60 });
console.log(`shot     ${shot.ms} ms · ${shot.bytes} B`);

await call(`/api/s/${id}/close`, {});
console.log('closed   ok');

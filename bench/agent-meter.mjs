/**
 * Agent-path meter: talks MCP over HTTP to the deployed service, the same way
 * T3 Code does. Prints one machine-readable line per metric.
 *
 *   node bench/agent-meter.mjs --n 9                 # open + first observation
 *   node bench/agent-meter.mjs --n 9 --task          # open + one act batch
 *   node bench/agent-meter.mjs --public --n 9
 *
 * The fixed page is the service's own form fixture, so the number measures the
 * service and the agent path, not internet weather.
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
const n = Number(arg('n', 9));
const task = !!arg('task', false);
const publicMode = !!arg('public', false);
const url = String(arg('url', 'http://127.0.0.1:8787/fixtures/form.html'));
const mcp = String(arg('mcp', publicMode ? 'https://chrome.inkwork.studio/mcp' : (process.env.IW_MCP || 'http://chrome-inkwork:8787/mcp')));

let token = process.env.IW_TOKEN;
if (!token) {
  for (const f of ['/root/.t3/opencode-secrets/chrome.env', new URL('../deploy/secrets.env', import.meta.url).pathname]) {
    try {
      const line = (await readFile(f, 'utf8')).split('\n').find((l) => l.startsWith('IW_TOKEN='));
      if (line) { token = line.slice('IW_TOKEN='.length).trim(); break; }
    } catch {}
  }
}
if (!token) throw new Error('no IW_TOKEN');

let rpcId = 0;
async function call(name, params = {}) {
  const r = await fetch(mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: params } }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`${name}: ${d.error.message}`);
  const text = d.result?.content?.[0]?.text || '{}';
  if (d.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(xs.length * p)))];
const summarize = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, p50: +pct(s, 0.5).toFixed(1), p95: +pct(s, 0.95).toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

const open = [];
const full = [];
let refs = 0, bytes = 0, ok = 0, calls = 0;

for (let i = 0; i < n; i++) {
  const t0 = performance.now();
  const o = await call('chrome_open', { name: `meter-${i}`, url, observe: true, max: 100 });
  const openMs = performance.now() - t0;
  calls = 1;
  const sid = o.session;
  const obs = o.obs || {};
  const valid = !!sid && Array.isArray(obs.elements) && obs.elements.length > 0 && /@e\d+/.test(o.text || '');
  if (!valid) throw new Error('open returned no usable observation: ' + JSON.stringify(o).slice(0, 300));
  refs = obs.elements.length; bytes = obs.bytes || 0;
  open.push(openMs);
  if (task) {
    const t1 = performance.now();
    const a = await call('chrome_act', {
      session: sid,
      input: 'dom',
      verify: 'change',
      steps: [
        { fill: { selector: 'input[name=name]', text: 'Ada Lovelace' } },
        { fill: { selector: 'input[name=email]', text: 'ada@example.com' } },
        { select: { selector: 'select[name=role]', value: 'engineer' } },
        { click: { text: 'Team' } },
        { click: { text: 'I agree' } },
        { fill: { selector: 'textarea[name=notes]', text: 'one intent' } },
        { click: { text: 'Create account' } },
      ],
      max: 40,
    });
    const v = await call('chrome_eval', { session: sid, code: 'return {title:document.title, values:Object.fromEntries(new FormData(document.querySelector("form")))}' });
    const vv = v.value || v;
    if (!a.ok || vv.values?.name !== 'Ada Lovelace' || vv.values?.email !== 'ada@example.com' || vv.values?.plan !== 'team') {
      throw new Error('task result incorrect: ' + JSON.stringify({ a: a.ok, v }).slice(0, 400));
    }
    full.push(performance.now() - t1);
    calls = 2;
  }
  await call('chrome_close', { session: sid });
  ok++;
  await sleep(900);
}

const out = { mode: task ? 'task' : 'open', mcp, url, loadavg: (await import('node:os')).loadavg().map((x) => +x.toFixed(2)), refs, bytes, ok };
if (task) {
  out.open = summarize(open);
  out.act = summarize(full);
  out.task_total = summarize(open.map((v, i) => v + full[i]));
  out.calls = calls;
  console.log(JSON.stringify(out));
  console.log(`AGENT_TASK p50_ms=${out.task_total.p50} p95_ms=${out.task_total.p95} calls=${calls} ok=${ok}/${n} refs=${refs}`);
} else {
  out.open = summarize(open);
  out.calls = calls;
  console.log(JSON.stringify(out));
  console.log(`AGENT_OPEN p50_ms=${out.open.p50} p95_ms=${out.open.p95} calls=${calls} ok=${ok}/${n} refs=${refs}`);
}

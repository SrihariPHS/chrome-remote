#!/usr/bin/env node
/**
 * chrome.inkwork.studio — remote Chromium for agents.
 *
 * One warm browser, one small HTTP API, one live console.
 * Everything is additive: no build step, no framework, no database.
 */
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Fleet } from './src/browser.mjs';
import { service } from './src/service.mjs';
import { handleMcp, tools } from './src/mcp.mjs';
import { listRecipes, runRecipe } from './src/recipes.mjs';
import { compactPulse } from './src/util.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'fixtures');
const DATA = process.env.IW_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.IW_PORT || process.env.PORT || 8787);
const HOST = process.env.IW_HOST || '0.0.0.0';
const VERSION = '0.1.0';

await mkdir(path.join(DATA, 'shots'), { recursive: true });
await mkdir(path.join(DATA, 'uploads'), { recursive: true });

const explicitToken = process.env.IW_TOKEN;
let TOKEN = explicitToken;
if (!TOKEN) {
  const f = path.join(DATA, 'token');
  if (existsSync(f)) TOKEN = (await readFile(f, 'utf8')).trim();
  if (!TOKEN) {
    TOKEN = randomBytes(24).toString('base64url');
    await writeFile(f, TOKEN + '\n', { mode: 0o600 });
  }
}
const OPEN = process.env.IW_OPEN === '1';
const PIN = String(process.env.IW_PIN || '');
const pinSessions = new Map(); // random id -> expiry epoch ms
const PIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setPinCookie(res, req, sid) {
  const bits = [`iw_session=${sid}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(PIN_TTL_MS / 1000)}`];
  if (isHttps(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

const SESSION_TTL_MIN = Number(process.env.IW_SESSION_TTL_MIN || 0);
const fleet = new Fleet({
  executablePath: process.env.IW_CHROME,
  headless: process.env.IW_HEADFUL !== '1',
  maxSessions: process.env.IW_MAX_SESSIONS,
  dataDir: DATA,
});
const svc = service(fleet);

/* ------------------------------------------------------------------- utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
// Fixtures must stay frameable (the cross-origin test embeds one).
const FRAMEABLE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function send(res, status, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error('body too large'); e.code = 'too_large'; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { const e = new Error('invalid JSON body'); e.code = 'bad_json'; throw e; }
}

function safeEq(a, b) {
  if (!a || !b) return false;
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

const failures = new Map();
const loginAttempts = new Map();
function auth(req, url) {
  if (OPEN) return true;
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const given = bearer || req.headers['x-iw-token'] || url.searchParams.get('token') || '';
  if (safeEq(given, TOKEN)) return true;
  const sid = cookies(req).iw_session;
  const exp = sid ? pinSessions.get(sid) : 0;
  if (exp && exp > Date.now()) return true;
  const ip = req.socket.remoteAddress || '?';
  const rec = failures.get(ip) || { n: 0, until: 0 };
  const now = Date.now();
  if (now > rec.until) { rec.n = 0; rec.until = now + 60_000; }
  rec.n++;
  failures.set(ip, rec);
  return false;
}

function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return false;
  const extra = (process.env.IW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(o)) return true;
  try {
    const u = new URL(o);
    const host = (req.headers.host || '').split(':')[0];
    return u.hostname === host || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch { return false; }
}

function cors(req, res) {
  if (originAllowed(req)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-iw-token, mcp-session-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

async function serveFile(res, base, rel, { cache = 'no-cache' } = {}) {
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(base, safe);
  if (!full.startsWith(base + path.sep) && full !== base) return send(res, 403, 'forbidden');
  try {
    const st = await stat(full);
    if (!st.isFile()) return send(res, 404, 'not found');
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cache,
      ...(base === WEB ? SECURITY_HEADERS : FRAMEABLE_HEADERS),
      ...(base === WEB ? { 'Content-Security-Policy': UI_CSP } : {}),
    });
    res.end(buf);
    return true;
  } catch { return send(res, 404, 'not found'); }
}

/* ------------------------------------------------------------------ routes */

const ROUTES = {
  'GET /': async (req, res) => serveFile(res, WEB, 'index.html', { cache: 'no-store' }),
  'GET /go': async (req, res) => serveFile(res, WEB, 'index.html', { cache: 'no-store' }),
  'GET /google': async (req, res) => serveFile(res, WEB, 'index.html', { cache: 'no-store' }),
  'GET /console': async (req, res) => serveFile(res, WEB, 'index.html', { cache: 'no-store' }),
  'GET /app.js': async (req, res) => serveFile(res, WEB, 'app.js', { cache: 'no-store' }),
  'GET /style.css': async (req, res) => serveFile(res, WEB, 'style.css', { cache: 'no-store' }),
  'GET /favicon.svg': async (req, res) => serveFile(res, WEB, 'favicon.svg'),
  'GET /robots.txt': async (req, res) => serveFile(res, WEB, 'robots.txt'),
  'GET /health': async (req, res) => {
    const m = fleet.metrics.summary();
    send(res, 200, {
      ok: true,
      service: 'chrome.inkwork.studio',
      version: VERSION,
      uptime_s: Math.round((Date.now() - fleet.startedAt) / 1000),
      browser: !!fleet.browser && fleet.browser.isConnected(),
      launch_ms: fleet.launchMs || null,
      sessions: fleet.sessions.size,
      pool: fleet.pool.length,
      pin: !!PIN,
      max_sessions: fleet.maxSessions,
      ops: m.ops,
    });
  },
  'GET /api/sessions': async (req, res) => send(res, 200, { ok: true, sessions: svc.list(), metrics: fleet.metrics.summary() }),
  'POST /api/task': async (req, res) => {
    const b = await readBody(req);
    const r = await svc.task({ id: b.session, url: b.url, name: b.name, steps: b.steps || [], input: b.input === 'cdp' ? 'cdp' : 'dom', verify: b.verify || 'change', observe: b.observe !== false, max: Number(b.max) || 80 });
    send(res, 200, r);
  },
  'POST /api/sessions': async (req, res) => {
    const b = await readBody(req);
    if (b.viewport && (Number(b.viewport.width) > 1920 || Number(b.viewport.height) > 1200)) return send(res, 400, { ok: false, error: 'viewport_too_large' });
    if (b.url && !/^https?:\/\//i.test(b.url) && b.url !== 'about:blank') return send(res, 400, { ok: false, error: 'url_scheme' });
    const r = await svc.open({ name: b.name, url: b.url, viewport: b.viewport, observe: b.observe === true || b.observe === 'true', max: Number(b.max) || 80 });
    send(res, 201, { ...r, session: r.summary });
  },
  'GET /api/metrics': async (req, res) => send(res, 200, { ok: true, ...fleet.metrics.summary() }),
  'GET /api/recipes': async (req, res) => send(res, 200, { ok: true, recipes: listRecipes() }),
  'GET /api/tools': async (req, res) => send(res, 200, { ok: true, tools }),
  'GET /api/openapi.json': async (req, res) => send(res, 200, openapi()),
  'GET /llms.txt': async (req, res) => {
    try {
      const t = await readFile(path.join(ROOT, 'llms.txt'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(t);
    } catch { send(res, 404, 'not found'); }
  },
  'POST /api/login': async (req, res) => {
    if (!PIN) return send(res, 400, { ok: false, error: 'pin_disabled' });
    const ip = req.socket.remoteAddress || '?';
    const now = Date.now();
    const rec = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (now < rec.until) return send(res, 429, { ok: false, error: 'too_many_attempts', retry_s: Math.ceil((rec.until - now) / 1000) });
    const b = await readBody(req);
    if (!safeEq(String(b.pin || ''), PIN)) {
      rec.n++;
      if (rec.n >= 5) { rec.until = now + 5 * 60_000; rec.n = 0; }
      loginAttempts.set(ip, rec);
      return send(res, 401, { ok: false, error: 'bad_pin', left: rec.until ? 0 : Math.max(0, 5 - rec.n) });
    }
    loginAttempts.set(ip, { n: 0, until: 0 });
    const sid = randomBytes(24).toString('base64url');
    pinSessions.set(sid, now + PIN_TTL_MS);
    setPinCookie(res, req, sid);
    send(res, 200, { ok: true, ttl_s: Math.floor(PIN_TTL_MS / 1000) });
  },
  'POST /mcp': async (req, res) => {
    const body = await readBody(req, 4_000_000);
    const out = await handleMcp(svc, body);
    if (!out) { res.writeHead(202, { 'Cache-Control': 'no-store' }); res.end(); return; }
    send(res, 200, out, { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Session-Id': 'chrome-inkwork' });
  },
};

async function apiSession(req, res, id, op, sub) {
  const s = fleet.get(id);
  if (!s) return send(res, 404, { ok: false, error: 'no_session', detail: id });
  const b = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readBody(req);
  switch (op) {
    case 'navigate':
    case 'goto': {
      const url = b.url || b.href;
      if (!url) return send(res, 400, { ok: false, error: 'no_url' });
      if (!/^https?:\/\//i.test(url) && url !== 'about:blank' && process.env.IW_ALLOW_FILE !== '1') return send(res, 400, { ok: false, error: 'url_scheme' });
      return send(res, 200, { ok: true, ...(await s.goto(url)) });
    }
    case 'snap': {
      const r = await s.snap({ max: Number(b.max) || 120, scope: b.scope || 'full', allFrames: b.all_frames !== false && b.all_frames !== 'false', textBytes: Number(b.text_bytes) || 6000 });
      return send(res, 200, r);
    }
    case 'act': return send(res, 200, await s.act({ steps: b.steps, verify: b.verify || 'change', verifyMs: Number(b.verify_ms) || 300, observe: b.observe !== false && b.observe !== 'false', max: Number(b.max) || 90, scope: b.scope || 'viewport', input: b.input === 'dom' ? 'dom' : 'cdp' }));
    case 'eval': {
      const r = await s.evalCode(b.code, { timeout: Number(b.timeout_ms) || 20000 });
      return send(res, r.ok ? 200 : 400, r);
    }
    case 'pulse': return send(res, 200, b.compact === true || b.compact === 'true' ? compactPulse(await s.pulse({ allFrames: !!b.all_frames })) : await s.pulse({ allFrames: !!b.all_frames }));
    case 'read': {
      const r = await s.evalCode(`return iw.read(${b.target ? JSON.stringify(b.target) : 'undefined'}, ${Number(b.max) || 4000})`);
      return send(res, 200, r);
    }
    case 'find': {
      const r = await s.evalCode(`return iw.find(${JSON.stringify(String(b.text || ''))}, ${Number(b.limit) || 12})`);
      return send(res, 200, r);
    }
    case 'wait':
      return send(res, 200, await svc.wait(id, { text: b.text, selector: b.selector, predicate: b.predicate, timeout_ms: Number(b.timeout_ms) || 5000, since: Number(b.since) || undefined }));
    case 'reflex':
      return send(res, 200, await svc.reflex(id, { until: b.until, do: b.do ?? b.action, every_ms: Number(b.every_ms) || 8, timeout_ms: Number(b.timeout_ms) || 8000, max_fires: Number(b.max_fires) || 1 }));
    case 'screenshot': {
      const r = await svc.screenshot(id, { full_page: b.full_page === true || b.full_page === 'true', quality: Number(b.quality) || 72 });
      return send(res, 200, r);
    }
    case 'timeline': return send(res, 200, await svc.timeline(id));
    case 'recipe': {
      if (!sub) return send(res, 400, { ok: false, error: 'no_recipe' });
      const r = await runRecipe(s, sub, b);
      return send(res, r.ok === false ? 400 : 200, r);
    }
    case 'close': return send(res, 200, await svc.close(id));
    default: return send(res, 404, { ok: false, error: 'unknown_op', op });
  }
}

/* -------------------------------------------------------------------- HTTP */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const key = `${req.method} ${url.pathname}`;
  try {
    if ((url.pathname.startsWith('/api/') || url.pathname === '/mcp') && url.pathname !== '/api/login' && !auth(req, url)) {
      return send(res, 401, { ok: false, error: 'unauthorized', hint: 'Authorization: Bearer <token>' });
    }
    if (ROUTES[key]) return await ROUTES[key](req, res);

    if (url.pathname.startsWith('/fixtures/')) {
      return await serveFile(res, FIXTURES, url.pathname.slice('/fixtures/'.length), { cache: 'no-cache' });
    }

    const m = url.pathname.match(/^\/api\/s\/([a-zA-Z0-9_]+)\/([a-z]+)(?:\/([a-zA-Z0-9_.-]+))?$/);
    if (m) {
      if (m[2] === 'stream') return streamPulses(req, res, m[1]);
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') return send(res, 405, { ok: false, error: 'method' });
      return await apiSession(req, res, m[1], m[2], m[3]);
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
      return send(res, 404, { ok: false, error: 'not_found', path: url.pathname });
    }

    if (req.method === 'GET' && url.pathname === '/') return await serveFile(res, WEB, 'index.html');
    return send(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    const code = e.code === 'too_large' ? 413 : e.code === 'bad_json' ? 400 : e.code === 'max_sessions' ? 429 : 500;
    if (process.env.IW_DEBUG === '1') console.error(e);
    send(res, code, { ok: false, error: e.code || 'server_error', detail: String(e.message || e).slice(0, 400) });
  }
});

/* --------------------------------------------------------------------- SSE */

function streamPulses(req, res, id) {
  const s = fleet.get(id);
  if (!s) return send(res, 404, { ok: false, error: 'no_session' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ session: s.id, viewport: s.viewport, t: Date.now() })}\n\n`);
  let n = 0;
  const tick = async () => {
    if (res.writableEnded) return;
    try {
      const p = compactPulse(await s.pulse({ light: true }));
      res.write(`event: pulse\ndata: ${JSON.stringify(p)}\n\n`);
      n++;
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
    }
  };
  const iv = setInterval(tick, 250);
  tick();
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  req.on('close', () => { clearInterval(iv); clearInterval(ping); res.end(); });
}

/* -------------------------------------------------------------- screencast */

const wss = new WebSocketServer({ noServer: true });
const casters = new Map();

async function startCaster(session) {
  const page = session.page;
  if (!page || page.isClosed()) throw new Error('no page');
  const cdp = session.cdps.get(page) || await session.context.newCDPSession(page);
  session.cdps.set(page, cdp);
  const caster = { session, page, cdp, viewers: new Set(), started: false, frames: 0 };
  cdp.removeAllListeners('Page.screencastFrame');
  cdp.on('Page.screencastFrame', (f) => {
    caster.frames++;
    const buf = Buffer.from(f.data, 'base64');
    for (const ws of caster.viewers) {
      if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) {
        try { ws.send(buf, { binary: true }); } catch {}
      }
    }
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  caster.started = true;
  casters.set(session.id, caster);
  return caster;
}

async function stopCaster(id) {
  const c = casters.get(id);
  if (!c) return;
  casters.delete(id);
  c.cdp.removeAllListeners('Page.screencastFrame');
  try { await c.cdp.send('Page.stopScreencast'); } catch {}
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const m = url.pathname.match(/^\/api\/s\/([a-zA-Z0-9_]+)\/live$/);
  if (!m) { socket.destroy(); return; }
  if (!auth(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const session = fleet.get(m[1]);
  if (!session) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, async (ws) => {
    try {
      let caster = casters.get(session.id);
      if (!caster || caster.page !== session.page) {
        if (caster) await stopCaster(session.id);
        caster = await startCaster(session);
      }
      caster.viewers.add(ws);
      ws.send(JSON.stringify({ type: 'hello', session: session.id, viewport: session.viewport, quality: 55 }));
      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        try {
          const page = session.page;
          if (!page || page.isClosed()) return;
          if (msg.type === 'mouse') {
            if (msg.action === 'move') await page.mouse.move(msg.x, msg.y);
            else if (msg.action === 'down') await page.mouse.down({ button: msg.button || 'left' });
            else if (msg.action === 'up') await page.mouse.up({ button: msg.button || 'left' });
            else if (msg.action === 'click') await page.mouse.click(msg.x, msg.y, { button: msg.button || 'left', clickCount: msg.clickCount || 1 });
          } else if (msg.type === 'wheel') {
            await page.mouse.move(msg.x ?? session.viewport.width / 2, msg.y ?? session.viewport.height / 2);
            await page.mouse.wheel(msg.dx || 0, msg.dy || 0);
          } else if (msg.type === 'key') {
            await page.keyboard.press(String(msg.key));
          } else if (msg.type === 'text') {
            await page.keyboard.insertText(String(msg.text));
          } else if (msg.type === 'nav') {
            await session.goto(String(msg.url));
          }
        } catch (e) { ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) })); }
      });
      ws.on('close', async () => {
        caster.viewers.delete(ws);
        if (!caster.viewers.size) await stopCaster(session.id);
      });
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) })); ws.close(); } catch {}
    }
  });
});

/* --------------------------------------------------------------- openapi */

function openapi() {
  return {
    openapi: '3.1.0',
    info: { title: 'chrome.inkwork.studio', version: VERSION, description: 'A warm remote Chromium you drive with one intent per call.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Step: { type: 'object', description: 'e.g. {"click":"@e3"} or {"fill":{"ref":"@e2","text":"hi"}}' },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      '/health': { get: { summary: 'Liveness and latency summary', security: [] } },
      '/api/sessions': {
        get: { summary: 'List sessions' },
        post: { summary: 'Create a session', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, viewport: { type: 'object' } } } } } } },
      },
      '/api/s/{id}/snap': { post: { summary: 'Compact ref tree observation', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/api/s/{id}/act': { post: { summary: 'Batch UI steps + post-observation', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/api/s/{id}/eval': { post: { summary: 'Run JS in the page with the iw SDK' } },
      '/api/s/{id}/pulse': { post: { summary: 'Timers, focus, scores, dialogs — no screenshot' } },
      '/api/s/{id}/reflex': { post: { summary: 'In-page fast reflex: until → do at 4–16 ms' } },
      '/api/s/{id}/wait': { post: { summary: 'Wait inside the page for text/selector/predicate' } },
      '/api/s/{id}/screenshot': { post: { summary: 'JPEG screenshot (slow path; prefer snap/pulse)' } },
      '/api/s/{id}/stream': { get: { summary: 'SSE pulse stream' } },
      '/api/s/{id}/live': { get: { summary: 'WebSocket JPEG screencast' } },
      '/mcp': { post: { summary: 'MCP streamable HTTP endpoint' } },
    },
  };
}

/* ------------------------------------------------------------------- boot */

server.listen(PORT, HOST, async () => {
  console.log(`\n  chrome.inkwork.studio ${VERSION}`);
  console.log(`  console   http://127.0.0.1:${PORT}/  (PIN gate${PIN ? '' : ' disabled'})`);
  console.log(`  api       http://127.0.0.1:${PORT}/api/sessions`);
  console.log(`  mcp       http://127.0.0.1:${PORT}/mcp`);
  console.log(`  token     ${explicitToken ? 'from IW_TOKEN' : path.join(DATA, 'token')} (API/MCP)`);
  console.log(`  chrome    ${fleet.executablePath}\n`);
  fleet.ensure()
    .then(async () => {
      console.log(`  browser warm in ${fleet.launchMs} ms`);
      await fleet.warm().catch(() => {});
      if (fleet.pool.length) console.log(`  session pool warm (${fleet.pool.length})\n`);
    })
    .catch((e) => console.error('  browser launch failed:', e.message));
});

const shutdown = async () => {
  console.log('\n  shutting down…');
  server.close();
  for (const id of [...casters.keys()]) await stopCaster(id);
  await fleet.closeAll();
  process.exit(0);
};
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of pinSessions) if (exp <= now) pinSessions.delete(k);
}, 60 * 60_000).unref();

if (SESSION_TTL_MIN > 0) {
  setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MIN * 60_000;
    for (const s of [...fleet.sessions.values()]) {
      if (s.lastActive < cutoff) fleet.close(s.id).catch(() => {});
    }
  }, 60_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

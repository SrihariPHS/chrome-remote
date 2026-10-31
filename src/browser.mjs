/*
 * Fleet + Session: a warm Chromium shared by many isolated contexts.
 *
 * The important choices:
 *  - one browser process, no cold launch per action (3 s cold -> 0 ms warm)
 *  - one CDP session held open per page (no handshake per action)
 *  - frame-aware snapshots merged by the server, so cross-origin iframes
 *    are first-class without a custom Chromium build
 *  - page-side SDK does the looping, so waits and reflexes never cross the net
 */
import { chromium } from 'playwright-core';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SDK_PATH = new URL('./page-sdk.js', import.meta.url);
const SDK = await readFile(SDK_PATH, 'utf8');

const MUTATING = new Set(['click', 'fill', 'type', 'press', 'key', 'scroll', 'hover', 'select', 'check', 'uncheck', 'goto', 'back', 'forward', 'reload', 'eval', 'dialog', 'upload', 'drag', 'draw', 'reflex']);

export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,TranslateUI',
  '--disable-extensions',
  '--disable-blink-features=AutomationControlled',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
];

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

let idCounter = 0;
const nextId = () => 's_' + (++idCounter).toString(36) + randomBytes(2).toString('hex');

function nowMs() { return performance.now(); }
function round(n, d = 1) { const p = 10 ** d; return Math.round(n * p) / p; }

export class Metrics {
  constructor() { this.ops = new Map(); this.started = Date.now(); }
  record(op, ms, ok = true, bytes = 0) {
    let a = this.ops.get(op);
    if (!a) { a = { n: 0, ok: 0, err: 0, ms: [], bytes: 0 }; this.ops.set(op, a); }
    a.n++; if (ok) a.ok++; else a.err++;
    a.ms.push(ms); if (a.ms.length > 600) a.ms.shift();
    a.bytes += bytes;
  }
  summary() {
    const out = {};
    for (const [op, a] of this.ops) {
      const xs = a.ms.slice().sort((x, y) => x - y);
      const p = (q) => xs.length ? round(xs[Math.min(xs.length - 1, Math.floor(xs.length * q))], 2) : 0;
      out[op] = { n: a.n, ok: a.ok, err: a.err, p50: p(0.5), p95: p(0.95), max: p(1), bytes: a.bytes };
    }
    return { uptime_s: Math.round((Date.now() - this.started) / 1000), ops: out };
  }
}

export class Fleet {
  constructor(opts = {}) {
    this.executablePath = opts.executablePath || process.env.IW_CHROME || '/workspace/chromium-1243/chrome-linux64/chrome';
    this.headless = opts.headless !== false;
    this.maxSessions = Number(opts.maxSessions || process.env.IW_MAX_SESSIONS || 4);
    this.poolSize = Math.max(0, Math.min(2, Number(opts.poolSize ?? process.env.IW_POOL ?? 1)));
    this.pool = [];
    this.warming = null;
    this.dataDir = opts.dataDir || process.env.IW_DATA || path.join(process.cwd(), 'data');
    this.profile = opts.profile || process.env.IW_PROFILE || 'default';
    this.profileFile = this.profile && this.profile !== 'none'
      ? path.join(this.dataDir, 'profiles', `${this.profile}.json`)
      : null;
    this.profileTimer = setInterval(() => this.saveProfiles(), 30_000);
    this.profileTimer.unref?.();
    this.browser = null;
    this.launching = null;
    this.sessions = new Map();
    this.metrics = new Metrics();
    this.startedAt = Date.now();
    mkdirSync(path.join(this.dataDir, 'downloads'), { recursive: true });
    mkdirSync(path.join(this.dataDir, 'profiles'), { recursive: true });
  }

  async ensure() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const t0 = nowMs();
      const browser = await chromium.launch({
        executablePath: this.executablePath,
        headless: this.headless,
        args: CHROME_ARGS,
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 30000,
      });
      this.browser = browser;
      this.launchMs = round(nowMs() - t0, 0);
      browser.on('disconnected', () => { this.browser = null; });
      return browser;
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }

  async _newSession({ name = 'warm', viewport, locale = 'en-AU', timezone = 'Australia/Sydney' } = {}) {
    const browser = await this.ensure();
    const vp = { ...DEFAULT_VIEWPORT, ...(viewport || {}) };
    let storageState = null;
    let profileStamp = 0;
    if (this.profileFile) {
      try {
        storageState = JSON.parse(await readFile(this.profileFile, 'utf8'));
        const st = await stat(this.profileFile).catch(() => null);
        profileStamp = st ? st.mtimeMs : 0;
      } catch {}
    }
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      screen: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      locale,
      timezoneId: timezone,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      ...(storageState ? { storageState } : {}),
    });
    await context.addInitScript({ content: SDK });
    const session = new Session({
      id: nextId(),
      fleet: this,
      context,
      viewport: vp,
      name,
      dataDir: this.dataDir,
      metrics: this.metrics,
    });
    await session.attachInitial();
    session.profileStamp = profileStamp;
    session.profileFile = null;
    return session;
  }

  async saveProfiles() {
    const sessions = [...this.sessions.values()];
    for (const s of sessions) await s.saveProfile().catch(() => {});
  }

  /**
   * Keep one blank context/page ready. Opening a task then costs a navigation,
   * not a browser-context cold start (~1-1.5 s on this box).
   */
  async warm() {
    if (this.poolSize <= 0) return null;
    if (this.warming) return this.warming;
    if (this.pool.length + this.sessions.size >= this.maxSessions) return null;
    this.warming = (async () => {
      try {
        let last = null;
        while (this.pool.length < this.poolSize && this.pool.length + this.sessions.size < this.maxSessions) {
          const s = await this._newSession({ name: 'warm' });
          s.pooled = true;
          this.pool.push(s);
          last = s;
        }
        return last;
      } finally { this.warming = null; }
    })();
    return this.warming;
  }

  async create({ name, url, viewport, locale = 'en-AU', timezone = 'Australia/Sydney' } = {}) {
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error(`max sessions (${this.maxSessions}) reached`);
      err.code = 'max_sessions';
      throw err;
    }
    await this.ensure();
    const t0 = nowMs();
    let session = this.pool.pop() || null;
    if (session && (!session.page || session.page.isClosed())) {
      await session.close().catch(() => {});
      session = null;
    }
    if (session && this.profileFile) {
      const st = await stat(this.profileFile).catch(() => null);
      if (st && st.mtimeMs > (session.profileStamp || 0) + 2) {
        await session.close().catch(() => {});
        session = null;
      }
    }
    if (!session) session = await this._newSession({ name: name || 'untitled', viewport, locale, timezone });
    session.profileFile = this.profileFile;
    const handoffMs = round(nowMs() - t0, 1);
    session.pooled = false;
    session.name = name || session.name || 'untitled';
    session.createdAt = Date.now();
    if (viewport) {
      const vp = { ...DEFAULT_VIEWPORT, ...viewport };
      if (vp.width !== session.viewport.width || vp.height !== session.viewport.height) {
        try { await session.page.setViewportSize({ width: vp.width, height: vp.height }); session.viewport = vp; } catch {}
      }
    }
    this.sessions.set(session.id, session);
    session.handoffMs = handoffMs;
    if (url) {
      const go = await session.goto(url).catch((e) => ({ ok: false, error: 'goto_failed', detail: String(e.message || e) }));
      if (!go.ok) session.log('goto', go.ms || 0, false, go.detail || 'failed');
    }
    session.createMs = round(nowMs() - t0, 0);
    this.warm().catch(() => {});
    return session;
  }

  get(id) { return this.sessions.get(id); }
  list() { return [...this.sessions.values()].map((s) => s.summary()); }
  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.close();
    this.sessions.delete(id);
    this.warm().catch(() => {});
    return true;
  }
  async closeAll() {
    for (const s of this.sessions.values()) await s.close().catch(() => {});
    for (const s of this.pool) await s.close().catch(() => {});
    this.sessions.clear();
    this.pool = [];
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}

export class Session {
  constructor({ id, fleet, context, viewport, name, dataDir, metrics }) {
    this.id = id;
    this.fleet = fleet;
    this.context = context;
    this.viewport = viewport;
    this.name = name;
    this.dataDir = dataDir;
    this.metrics = metrics;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.page = null;
    this.pages = new Set();
    this.cdp = null;
    this.cdps = new WeakMap();
    this.frameTags = new Map(); // Frame -> 'f1'
    this.frameTagSeq = 0;
    this.lastSnap = null;
    this.timeline = [];
    this.console = [];
    this.errors = [];
    this.dialogs = [];
    this.downloads = [];
    this.viewers = new Set();
    this.screencasting = false;
    this.status = 'idle';
    this.title = '';
    this.sorryAt = 0;
    this.initializing = true;
    this.context.on('page', (p) => { if (!this.initializing) this.adopt(p).catch(() => {}); });
    this.context.on('close', () => { this.status = 'closed'; });
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      url: this.page?.url() || '',
      title: this.title || '',
      status: this.status,
      created_at: this.createdAt,
      last_active: this.lastActive,
      viewport: this.viewport,
      viewers: this.viewers.size,
      pages: this.pages.size,
      timeline: this.timeline.length,
      create_ms: this.createMs || 0,
    };
  }

  log(op, ms, ok = true, detail = '') {
    this.lastActive = Date.now();
    this.timeline.push({ t: Date.now(), op, ms: round(ms, 1), ok, detail: String(detail || '').slice(0, 200) });
    if (this.timeline.length > 300) this.timeline.splice(0, this.timeline.length - 300);
    if (this.metrics) this.metrics.record(op, ms, ok);
  }

  async attachInitial() {
    const page = await this.context.newPage();
    await this.adopt(page, true);
    this.initializing = false;
    this.status = 'ready';
    return page;
  }

  async adopt(page, primary = false) {
    if (this.pages.has(page)) { if (primary) this.page = page; return; }
    this.pages.add(page);
    if (primary || !this.page || this.page.isClosed()) this.page = page;
    page.setDefaultTimeout(20000);
    page.on('close', () => {
      this.pages.delete(page);
      if (this.page === page) this.page = [...this.pages].find((p) => !p.isClosed()) || null;
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      this.console.push({ t: Date.now(), type: msg.type(), text: msg.text().slice(0, 300) });
      if (this.console.length > 80) this.console.shift();
    });
    page.on('pageerror', (err) => {
      this.errors.push({ t: Date.now(), text: String(err && err.message || err).slice(0, 300) });
      if (this.errors.length > 40) this.errors.shift();
    });
    page.on('dialog', async (d) => {
      const rec = { t: Date.now(), type: d.type(), message: d.message().slice(0, 300) };
      this.dialogs.push(rec);
      this.pendingDialog = d;
      if (this.dialogs.length > 10) this.dialogs.shift();
      // Do not leave the page wedged: dismiss only if nobody claims it quickly.
      setTimeout(() => { if (this.pendingDialog === d) { this.pendingDialog = null; try { d.dismiss(); } catch {} } }, 4000);
    });
    page.on('download', async (d) => {
      try {
        const safe = d.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'download';
        const file = path.join(this.dataDir, 'downloads', `${Date.now()}-${safe}`);
        await d.saveAs(file);
        this.downloads.push({ t: Date.now(), name: safe, path: file, url: d.url() });
        if (this.downloads.length > 20) this.downloads.shift();
        this.log('download', 0, true, safe);
      } catch {}
    });
    page.on('framenavigated', (frame) => {
      if (frame !== this.page?.mainFrame()) return;
      this.lastSnap = null;
      this.title = '';
      const u = frame.url();
      // Do not leave the CAPTCHA page in front of the owner. Google's challenge
      // is not solvable from this IP; bounce back to the home page and let the
      // agent use the search index instead.
      if (/^https?:\/\/[^/]*google\.[^/]+\/sorry\//i.test(u) && Date.now() - this.sorryAt > 5000) {
        this.sorryAt = Date.now();
        setTimeout(() => {
          page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }, 80);
      }
    });
    try { this.cdps.set(page, await this.context.newCDPSession(page)); } catch {}
    if (primary) this.page = page;
    return page;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const page = await this.context.newPage();
    await this.adopt(page, true);
    return page;
  }

  async goto(url) {
    const t0 = nowMs();
    const page = await this.ensurePage();
    this.status = 'navigating';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.title = await page.title().catch(() => '');
      this.lastSnap = null;
      const ms = round(nowMs() - t0, 1);
      this.log('goto', ms, true, url);
      this.status = 'ready';
      return { ok: true, ms, url: page.url(), title: this.title };
    } catch (e) {
      this.status = 'ready';
      const ms = round(nowMs() - t0, 1);
      this.log('goto', ms, false, e.message);
      return { ok: false, ms, error: 'goto_failed', detail: String(e.message || e).slice(0, 300), url: page.url() };
    }
  }

  frames() {
    const page = this.page;
    if (!page) return [];
    const all = page.frames();
    const main = page.mainFrame();
    const ordered = [main, ...all.filter((f) => f !== main)];
    return ordered.slice(0, 8);
  }

  tagFor(frame) {
    if (frame === this.page.mainFrame()) return 'main';
    let tag = this.frameTags.get(frame);
    if (!tag) { tag = 'f' + (++this.frameTagSeq); this.frameTags.set(frame, tag); }
    return tag;
  }

  async frameOffset(frame) {
    if (!frame || frame === this.page.mainFrame()) return { x: 0, y: 0 };
    try {
      const el = await frame.frameElement();
      const bb = await el.boundingBox();
      return bb ? { x: bb.x, y: bb.y } : { x: 0, y: 0 };
    } catch { return { x: 0, y: 0 }; }
  }

  frameForRef(ref) {
    const tag = ref.includes(':') ? ref.split(':')[0] : 'main';
    if (tag === 'main') return this.page?.mainFrame();
    for (const [f, t] of this.frameTags) if (t === tag) return f;
    return null;
  }

  localRef(ref) { return ref.includes(':') ? ref.split(':').slice(1).join(':') : ref; }

  async evalIn(frame, fn, arg) {
    if (!frame) throw new Error('no_frame');
    return await frame.evaluate(fn, arg);
  }

  async cdpFor(page = this.page) {
    let c = this.cdps.get(page);
    if (!c) { c = await this.context.newCDPSession(page); this.cdps.set(page, c); }
    return c;
  }

  /**
   * Direct CDP evaluation: ~2 ms vs ~4-7 ms through Playwright's evaluate on a
   * busy page. The hot paths (snap/pulse/point/eval) use this for the main
   * frame; child frames fall back to Playwright because they may be OOPIFs.
   */
  async evalExpr(frame, expression, opts = {}) {
    const main = this.page?.mainFrame();
    return frame && frame !== main
      ? await frame.evaluate(expression)
      : await this.cdpEval(expression, opts);
  }

  async cdpEval(expression, { frame = null, timeout = 20000, awaitPromise = true } = {}) {
    const main = this.page?.mainFrame();
    if (!frame || frame === main) {
      const cdp = await this.cdpFor(this.page);
      let timer;
      try {
        const res = await Promise.race([
          cdp.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
            includeCommandLineAPI: false,
            timeout,
          }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('cdp evaluate timed out')), timeout + 1500); }),
        ]);
        if (res.exceptionDetails) {
          const d = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed';
          throw new Error(String(d).split('\n')[0]);
        }
        return res.result?.value;
      } finally { clearTimeout(timer); }
    }
    return await frame.evaluate(expression);
  }

  async snap({ max = 120, scope = 'full', allFrames = true, textBytes = 6000 } = {}) {
    const t0 = nowMs();
    if (!this.page) throw new Error('no_page');
    const frames = allFrames ? this.frames() : [this.page.mainFrame()];
    const mainFrame = this.page.mainFrame();
    const results = await Promise.all(frames.map(async (frame) => {
      const tag = this.tagFor(frame);
      const opts = { max: frame === mainFrame ? max : Math.max(24, Math.floor(max / 2)), scope };
      try {
        const r = frame === mainFrame
          ? await this.cdpEval(`window.__iw && window.__iw.snap(${JSON.stringify(opts)})`)
          : await frame.evaluate((o) => window.__iw ? window.__iw.snap(o) : null, opts);
        if (!r || !r.ok) return null;
        return { frame, tag, r };
      } catch { return null; }
    }));
    const rows = [];
    const parts = [];
    let first = true;
    let title = '';
    let url = '';
    for (const item of results) {
      if (!item) continue;
      const { frame, tag, r } = item;
      if (first) { title = r.title; url = r.url; first = false; }
      const off = await this.frameOffset(frame);
      const prefix = tag === 'main' ? '' : tag + ':';
      for (const el of r.elements) {
        rows.push({
          ...el,
          ref: prefix + el.ref,
          frame: tag,
          frame_url: r.url,
          bounds: [Math.round(el.bounds[0] + off.x), Math.round(el.bounds[1] + off.y), el.bounds[2], el.bounds[3]],
        });
      }
      let t = r.text;
      if (tag !== 'main') {
        t = t.split('\n').filter((line, i) => i > 0 || !line.startsWith('# ')).join('\n')
          .replace(/^@e(\d+)/gm, `@${tag}:e$1`);
        parts.push(`# frame ${tag} ${r.url.slice(0, 180)}\n${t}`);
      } else {
        parts.unshift(t);
      }
    }
    let text = parts.join('\n');
    if (text.length > textBytes) {
      const cut = text.slice(0, textBytes);
      text = cut.slice(0, cut.lastIndexOf('\n')) + '\n# truncated';
    }
    this.lastSnap = { at: Date.now(), elements: rows, byRef: new Map(rows.map((r) => [r.ref, r])) };
    const ms = round(nowMs() - t0, 2);
    this.log('snap', ms, true, `${rows.length} els ${text.length}B`);
    return {
      ok: true, ms, session: this.id, seq: this.snapSeq = (this.snapSeq || 0) + 1,
      url, title,
      viewport: this.viewport,
      text, elements: rows, bytes: text.length,
      frames: results.filter(Boolean).map((x) => ({ tag: x.tag, url: x.r.url, title: x.r.title, elements: x.r.elements.length })),
      truncated: text.endsWith('# truncated'),
    };
  }

  async pulse({ allFrames = false, light = true } = {}) {
    const t0 = nowMs();
    const frames = allFrames ? this.frames() : [this.page.mainFrame()];
    const ps = [];
    const mainFrame = this.page.mainFrame();
    for (const f of frames) {
      try {
        const p = f === mainFrame
          ? await this.cdpEval(`window.__iw && window.__iw.pulse({light:${light ? 'true' : 'false'}})`)
          : await f.evaluate((o) => window.__iw ? window.__iw.pulse(o) : null, { light });
        if (p) ps.push({ tag: this.tagFor(f), p });
      } catch {}
    }
    if (!ps.length) return { ok: false, error: 'no_page', ms: round(nowMs() - t0, 2) };
    const main = ps[0];
    const timers = [];
    for (const { tag, p } of ps) for (const t of p.timers || []) timers.push({ ...t, frame: tag });
    timers.sort((a, b) => (b.salience || 0) - (a.salience || 0));
    const countdown = timers.find((t) => t.dir === 'down') || timers[0] || null;
    const out = {
      ...main.p,
      frame: ps.length > 1 ? ps.map(({ tag, p }) => ({ tag, url: p.url, title: p.title, seq: p.seq, countdown: p.countdown })) : undefined,
      timers: timers.slice(0, 8),
      countdown,
      dialogs: [...new Set(ps.flatMap(({ p }) => p.dialogs || []))].slice(0, 3),
      alerts: [...new Set(ps.flatMap(({ p }) => p.alerts || []))].slice(0, 4),
      session: this.id,
      ms: round(nowMs() - t0, 2),
      server_t: { epoch: Date.now(), perf: nowMs() },
      pending_dialogs: this.dialogs.slice(-2),
      downloads: this.downloads.slice(-3),
      console: this.console.slice(-3),
      status: this.status,
    };
    this.lastActive = Date.now();
    this.metrics?.record('pulse', out.ms, true);
    return out;
  }

  async point(target) {
    const t0 = nowMs();
    const tryFrames = [];
    if (target && typeof target === 'object' && target.ref) {
      const f = this.frameForRef(String(target.ref).replace(/^@/, ''));
      if (f) tryFrames.push(f);
    } else if (typeof target === 'string' && (target.startsWith('@') || /^e\d+$/.test(target) || target.includes(':e'))) {
      const f = this.frameForRef(target.replace(/^@/, ''));
      if (f) tryFrames.push(f);
    }
    if (!tryFrames.length) tryFrames.push(...this.frames());
    for (const f of tryFrames) {
      try {
        let local = target;
        if (typeof target === 'string') local = this.localRef(target.replace(/^@/, ''));
        else if (target && typeof target === 'object' && target.ref) local = { ...target, ref: this.localRef(String(target.ref).replace(/^@/, '')) };
        const r = f === this.page.mainFrame()
          ? await this.cdpEval(`window.__iw && window.__iw.point(${JSON.stringify(local)})`)
          : await f.evaluate((t) => window.__iw ? window.__iw.point(t) : { ok: false, error: 'no_sdk' }, local);
        if (r && r.ok) {
          const tag = this.tagFor(f);
          if (tag !== 'main' && r.ref && !String(r.ref).includes(':')) r.ref = tag + ':' + r.ref;
          const off = await this.frameOffset(f);
          r.x = round(r.x + off.x, 2);
          r.y = round(r.y + off.y, 2);
          if (r.rect) r.rect = [Math.round(r.rect[0] + off.x), Math.round(r.rect[1] + off.y), r.rect[2], r.rect[3]];
          r.frame = this.tagFor(f);
          r.resolved_ms = round(nowMs() - t0, 2);
          return r;
        }
        if (r && r.error && r.error !== 'no_element' && r.error !== 'no_target') {
          r.frame = this.tagFor(f);
          return r;
        }
      } catch {}
    }
    return { ok: false, error: 'no_element', ms: round(nowMs() - t0, 2) };
  }

  async mouseClick(point, { button = 'left', clickCount = 1, delay = 0 } = {}) {
    const page = await this.ensurePage();
    const t0 = nowMs();
    // Direct CDP saves the Playwright mouse-state round trips; this is the
    // hottest path in a batch, so 3 sends beat a wrapper call.
    try {
      const cdp = await this.cdpFor(page);
      const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount });
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount });
    } catch {
      await page.mouse.click(point.x, point.y, { button, clickCount, delay });
    }
    return round(nowMs() - t0, 2);
  }

  async evalCode(code, { timeout = 20000, frame = null } = {}) {
    const f = frame || this.page?.mainFrame();
    if (!f) return { ok: false, error: 'no_page' };
    const t0 = nowMs();
    const mark = Date.now();
    let expr = String(code || '').trim();
    if (!expr) return { ok: false, error: 'empty_code' };
    const hasReturn = /(^|[;{}\n])\s*return\b/.test(expr);
    if (hasReturn && !/^\s*(async\s*)?\(/.test(expr) && !/^\s*await\b/.test(expr)) {
      expr = `(async () => { ${expr}\n })()`;
    }
    let timer;
    try {
      const value = await Promise.race([
        this.cdpEval(expr, { frame: f, timeout }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('evaluation timed out')), timeout + 1200); }),
      ]);
      clearTimeout(timer);
      const logs = await this.cdpEval(`window.__iw ? window.__iw.logs(40).filter(l => l.t >= ${mark}) : []`, { frame: f }).catch(() => []);
      const ms = round(nowMs() - t0, 2);
      this.log('eval', ms, true, `${String(code).slice(0, 60)}`);
      return { ok: true, ms, value, logs: logs.slice(-10) };
    } catch (e) {
      clearTimeout(timer);
      const ms = round(nowMs() - t0, 2);
      this.log('eval', ms, false, e.message);
      return { ok: false, ms, error: 'eval_failed', detail: String(e.message || e).slice(0, 500) };
    }
  }

  async domClick(target) {
    const t0 = nowMs();
    const frames = [];
    const ref = typeof target === 'string' ? target.replace(/^@/, '') : target && target.ref ? String(target.ref).replace(/^@/, '') : '';
    if (ref) { const f = this.frameForRef(ref); if (f) frames.push(f); }
    if (!frames.length) frames.push(...this.frames());
    for (const f of frames) {
      let local = target;
      if (typeof target === 'string') local = this.localRef(target.replace(/^@/, ''));
      else if (target && typeof target === 'object' && target.ref) local = { ...target, ref: this.localRef(String(target.ref).replace(/^@/, '')) };
      try {
        const r = await this.evalExpr(f, `window.__iw && window.__iw.click(${JSON.stringify(local)})`);
        if (r && r.ok) return { ...r, frame: this.tagFor(f), ms: round(nowMs() - t0, 2) };
        if (r && r.error && r.error !== 'no_element' && r.error !== 'no_target') return { ...r, frame: this.tagFor(f), ms: round(nowMs() - t0, 2) };
      } catch {}
    }
    return { ok: false, error: 'no_element', ms: round(nowMs() - t0, 2) };
  }

  async runStep(step, { input = 'cdp' } = {}) {
    const t0 = nowMs();
    const op = Object.keys(step).find((k) => !['optional', 'timeout_ms', 'label', 'force'].includes(k));
    if (!op) return { ok: false, error: 'empty_step' };
    const arg = step[op];
    const optional = !!step.optional;
    const page = await this.ensurePage();
    try {
      let result = { ok: true };
      switch (op) {
        case 'goto': {
          result = await this.goto(String(arg));
          break;
        }
        case 'back': { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }); result = { ok: true, url: page.url() }; break; }
        case 'forward': { await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }); result = { ok: true, url: page.url() }; break; }
        case 'reload': { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); result = { ok: true, url: page.url() }; break; }
        case 'click': {
          const target = typeof arg === 'object' && arg !== null ? { ...arg } : arg;
          if (input === 'dom' && !(arg && typeof arg === 'object' && arg.x != null)) {
            result = await this.domClick(target);
            break;
          }
          const pt = await this.point(target);
          if (!pt.ok) { result = pt; break; }
          if (pt.occluded && !step.force) {
            result = { ok: false, error: 'occluded', hit: pt.hit, target: { name: pt.name, role: pt.role, ref: pt.ref } };
            break;
          }
          const count = arg?.clickCount || arg?.count || 1;
          const button = arg?.button || 'left';
          const ms = await this.mouseClick(pt, { button, clickCount: count });
          result = { ok: true, ref: pt.ref, name: pt.name, x: pt.x, y: pt.y, mouse_ms: ms, resolved_ms: pt.resolved_ms };
          break;
        }
        case 'hover': {
          const pt = await this.point(arg);
          if (!pt.ok) { result = pt; break; }
          await page.mouse.move(pt.x, pt.y);
          result = { ok: true, ref: pt.ref, name: pt.name };
          break;
        }
        case 'fill':
        case 'type': {
          const isObj = arg && typeof arg === 'object';
          const text = isObj ? String(arg.text ?? arg.value ?? '') : String(arg);
          const target = isObj ? (arg.ref ? { ref: arg.ref } : arg.selector ? { selector: arg.selector } : arg.text && (arg.x != null || arg.y != null) ? { x: arg.x, y: arg.y } : null) : null;
          if (target) {
            const pt = await this.point(target);
            if (!pt.ok) { result = pt; break; }
            if (pt.occluded && !step.force) { result = { ok: false, error: 'occluded', hit: pt.hit }; break; }
            const f = this.frameForRef(pt.ref || '') || this.page.mainFrame();
            const local = pt.ref ? { ref: this.localRef(pt.ref) } : target;
            let fr = null;
            try { fr = await this.evalExpr(f, `window.__iw && window.__iw.fill(${JSON.stringify(local)}, ${JSON.stringify(text)})`); } catch {}
            if (fr && fr.ok) { result = { ok: true, ...fr, text_len: text.length }; break; }
            await this.mouseClick(pt);
          }
          await page.keyboard.insertText(text);
          result = { ok: true, method: 'insertText', text_len: text.length };
          break;
        }
        case 'press':
        case 'key': {
          const key = String(arg).replace(/\bMeta\b/g, 'Control');
          await page.keyboard.press(key);
          result = { ok: true, key };
          break;
        }
        case 'scroll': {
          const dy = typeof arg === 'number' ? arg : Number(arg?.dy ?? 0);
          const dx = typeof arg === 'object' && arg ? Number(arg.dx ?? 0) : 0;
          if (arg && typeof arg === 'object' && (arg.ref || arg.selector || arg.text)) {
            const pt = await this.point({ ref: arg.ref, selector: arg.selector, text: arg.text });
            if (pt.ok) await page.mouse.move(pt.x, pt.y);
          } else {
            await page.mouse.move(this.viewport.width / 2, this.viewport.height / 2);
          }
          await page.mouse.wheel(dx, dy);
          result = { ok: true, dx, dy };
          break;
        }
        case 'select': {
          const pt = await this.point(arg);
          if (!pt.ok) { result = pt; break; }
          const f = this.frameForRef(pt.ref || '') || this.page.mainFrame();
          const local = pt.ref ? { ref: this.localRef(pt.ref) } : arg;
          const r = await this.evalExpr(f, `window.__iw && window.__iw.select(${JSON.stringify(local)}, ${JSON.stringify(arg.value ?? arg.text ?? '')})`);
          result = r.ok === false ? { ok: false, ...r } : { ok: true, ...r };
          break;
        }
        case 'check':
        case 'uncheck': {
          const pt = await this.point(arg);
          if (!pt.ok) { result = pt; break; }
          const f = this.frameForRef(pt.ref || '') || this.page.mainFrame();
          const local = pt.ref ? { ref: this.localRef(pt.ref) } : arg;
          const r = await this.evalExpr(f, `window.__iw && window.__iw.check(${JSON.stringify(local)}, ${op === 'check' ? 'true' : 'false'})`);
          result = r.ok === false ? { ok: false, ...r } : { ok: true, ...r };
          break;
        }
        case 'wait': {
          const ms = Number(arg) || 0;
          await new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, 30000))));
          result = { ok: true, waited_ms: ms };
          break;
        }
        case 'waitFor': {
          const args = typeof arg === 'object' ? arg : { text: String(arg) };
          const f = args.ref ? this.frameForRef(args.ref) || this.page.mainFrame() : this.page.mainFrame();
          const r = await this.evalExpr(f, `window.__iw && window.__iw.waitFor(${JSON.stringify(args)})`, { timeout: Number(args.timeout_ms) + 3000 });
          result = { ...r };
          break;
        }
        case 'eval': {
          const f = this.page.mainFrame();
          const r = await this.evalCode(String(arg), { timeout: step.timeout_ms || 20000, frame: f });
          result = { ok: r.ok, value: r.value, error: r.error, detail: r.detail, ms: r.ms };
          break;
        }
        case 'draw': {
          const paths = Array.isArray(arg?.paths) ? arg.paths : [arg?.path || arg];
          const delay = Math.max(0, Math.min(Number(arg?.duration_ms ?? 0), 5000));
          const cdp = await this.cdpFor(page);
          const send = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: type === 'mouseMoved' ? 'none' : 'left',
            buttons: type === 'mouseReleased' ? 0 : 1,
            clickCount: type === 'mouseMoved' ? 0 : 1,
          });
          let points = 0;
          let used = 0;
          for (const p of paths) {
            if (!Array.isArray(p) || p.length < 2) continue;
            const pts = p.map(([x, y]) => [Number(x), Number(y)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
            if (pts.length < 2) continue;
            const CH = 6;
            const chunks = Math.ceil((pts.length - 1) / CH);
            const gap = delay ? Math.max(1, Math.floor(delay / chunks)) : 3;
            await send('mouseMoved', pts[0][0], pts[0][1]);
            await send('mousePressed', pts[0][0], pts[0][1]);
            if (pts.length <= 8) {
              // Short strokes (box sides) need each corner to be delivered;
              // a burst can make the brush skip the middle point.
              for (let i = 1; i < pts.length; i++) {
                await send('mouseMoved', pts[i][0], pts[i][1]);
                points++;
                await new Promise((r) => setTimeout(r, 22));
              }
            } else {
              for (let i = 1; i < pts.length; i += CH) {
                const batch = [];
                for (let j = i; j < Math.min(i + CH, pts.length); j++) batch.push(send('mouseMoved', pts[j][0], pts[j][1]));
                await Promise.all(batch);
                points += batch.length;
                await new Promise((r) => setTimeout(r, gap));
              }
            }
            await send('mouseReleased', pts[pts.length - 1][0], pts[pts.length - 1][1]);
            await new Promise((r) => setTimeout(r, 55));
            used++;
          }
          result = { ok: true, paths: used, points };
          break;
        }
        case 'dialog': {
          const d = this.pendingDialog;
          if (!d) { result = { ok: false, error: 'no_dialog' }; break; }
          this.pendingDialog = null;
          if (String(arg) === 'accept') await d.accept(); else await d.dismiss();
          result = { ok: true, action: String(arg) };
          break;
        }
        case 'upload': {
          const target = (typeof arg === 'string' ? arg : arg?.selector) || 'input[type=file]';
          const base = path.resolve(this.dataDir, 'uploads');
          const requested = path.resolve(String(arg.path || ''));
          if (!requested.startsWith(base + path.sep) && !requested.startsWith(path.resolve(this.dataDir) + path.sep)) {
            result = { ok: false, error: 'upload_outside_data', detail: 'files must live under data/uploads' };
            break;
          }
          await page.setInputFiles(target, requested);
          result = { ok: true, path: requested };
          break;
        }
        case 'reflex': {
          const f = this.page.mainFrame();
          const r = await this.evalExpr(f, `window.__iw && window.__iw.reflex(${JSON.stringify(arg)})`, { timeout: Number(arg.timeout_ms || 8000) + 3000 });
          result = { ...r };
          break;
        }
        default:
          result = { ok: false, error: 'unknown_op', op };
      }
      const ms = round(nowMs() - t0, 2);
      this.log(op, ms, !!result.ok, result.error || result.ref || result.name || '');
      return { ...result, op, ms, ok: result.ok !== false, optional };
    } catch (e) {
      const ms = round(nowMs() - t0, 2);
      this.log(op, ms, false, e.message);
      return { ok: false, op, ms, error: 'step_failed', detail: String(e.message || e).slice(0, 300), optional };
    }
  }

  async sigAll() {
    let h = 0;
    for (const f of this.frames()) {
      try {
        const v = await this.evalExpr(f, 'window.__iw ? window.__iw.sig() : 0');
        h = (Math.imul(h, 31) + (Number(v) || 0)) >>> 0;
      } catch {}
    }
    return h;
  }

  async seqAll() {
    let total = 0;
    const main = this.page?.mainFrame();
    for (const f of this.frames()) {
      try { total += f === main ? await this.cdpEval('window.__iw ? window.__iw.seq() : 0') : await f.evaluate(() => window.__iw ? window.__iw.seq() : 0); } catch {}
    }
    return total;
  }

  canFastDom(steps) {
    const FAST = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck', 'scroll', 'wait', 'waitFor']);
    for (const st of steps) {
      const op = Object.keys(st).find((k) => !['optional', 'timeout_ms', 'label', 'force'].includes(k));
      if (!FAST.has(op)) return false;
      const a = st[op];
      let ref = '';
      if (typeof a === 'string') ref = a;
      else if (a && typeof a === 'object' && a.ref) ref = String(a.ref);
      if (ref && String(ref).includes(':')) return false;
    }
    return true;
  }

  async act({ steps = [], verify = 'change', verifyMs = 300, observe = true, max = 90, scope = 'viewport', input = 'cdp' } = {}) {
    const t0 = nowMs();
    if (!Array.isArray(steps) || !steps.length) return { ok: false, error: 'no_steps' };
    const fast = input === 'dom' && verify !== 'mutation' && !(verify && typeof verify === 'object') && this.canFastDom(steps);
    let results = [];
    let failed = null;
    let changed = null;
    let verified = null;
    if (fast) {
      // One page-side evaluate for the whole batch: 7 form steps become one
      // round trip instead of seven (plus fills/selects/clicks at DOM speed).
      try {
        const r = await this.cdpEval(`window.__iw && window.__iw.batch(${JSON.stringify(steps)}, {wait_ms:${verify === 'change' ? 150 : 0}})`);
        if (!r || r.ok === undefined) throw new Error('no batch result');
        results = (r.steps || []).map((x) => ({ ...x, ok: x.ok !== false }));
        failed = r.ok ? null : (results.find((x) => !x.ok) || { ok: false, error: r.error || 'batch_failed', detail: r.detail });
        changed = verify === 'none' ? null : !!r.changed;
        if (verify === 'change') verified = { ok: changed, mode: 'fast-batch', ms: r.ms };
      } catch (e) {
        failed = { ok: false, error: 'fast_batch_failed', detail: String((e && e.message) || e).slice(0, 300) };
      }
    } else {
      const seqBefore = await this.seqAll().catch(() => 0);
      const sigBefore = verify === 'change' ? await this.sigAll().catch(() => null) : null;
      for (const step of steps) {
        const r = await this.runStep(step, { input });
        results.push(r);
        if (!r.ok && !step.optional) { failed = r; break; }
      }
      const didMutate = results.some((r) => r.ok && MUTATING.has(r.op));
      if (!failed && verify !== 'none' && didMutate) {
        try {
          const f = this.page.mainFrame();
          if (verify && typeof verify === 'object' && (verify.expect || verify.expect_text)) {
            const q = verify.expect || verify.expect_text;
            verified = await f.evaluate(([q, ms]) => window.__iw.waitFor({ text: q, timeout_ms: ms }), [String(q), verifyMs]);
            changed = verified.ok;
          } else if (verify === 'change') {
            changed = false;
            const t = nowMs();
            let sigNow = sigBefore;
            while (!changed && nowMs() - t < verifyMs) {
              sigNow = await this.sigAll().catch(() => sigNow);
              if (sigBefore == null || sigNow !== sigBefore) changed = true;
              else await new Promise((r) => setTimeout(r, 12));
            }
            verified = { ok: changed, ms: round(nowMs() - t, 2), sig: sigNow };
          } else if (verify === 'mutation') {
            const t = nowMs();
            while (!changed && nowMs() - t < verifyMs) {
              const cur = await this.seqAll();
              if (cur > seqBefore) changed = true;
              else await new Promise((r) => setTimeout(r, 12));
            }
            verified = { ok: changed, ms: round(nowMs() - t, 2) };
          }
        } catch {}
      }
    }
    const ms = round(nowMs() - t0, 2);
    const out = {
      ok: !failed,
      ms,
      session: this.id,
      steps: results,
      input,
      changed,
      verified,
      error: failed ? failed.error : undefined,
      detail: failed ? failed.detail : undefined,
    };
    if (!failed && observe) {
      const s = await this.snap({ max, scope });
      out.obs = { text: s.text, elements: s.elements, url: s.url, title: s.title, bytes: s.bytes, frames: s.frames };
      out.seq = s.seq;
    }
    out.ok = !failed;
    this.log('act', ms, out.ok, `${steps.length} steps${changed === false ? ' (no change)' : ''}`);
    return out;
  }

  async saveProfile() {
    if (!this.profileFile) return false;
    try {
      const state = await this.context.storageState();
      const json = JSON.stringify(state);
      if (json === this.lastProfileJson) return false;
      const tmp = this.profileFile + '.tmp';
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.profileFile);
      this.lastProfileJson = json;
      return true;
    } catch { return false; }
  }

  async close() {
    await this.saveProfile().catch(() => {});
    for (const v of this.viewers) { try { v.close(); } catch {} }
    this.viewers.clear();
    try { await this.context.close(); } catch {}
    this.status = 'closed';
  }
}

export { SDK };

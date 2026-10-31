/*
 * chrome.inkwork.studio — page-side SDK (injected into every frame)
 *
 * Design rules, borrowed from the fastest agent browsers:
 *   1. one intent = one snapshot + many actions, not one round trip per action
 *   2. refs are stable and server-verifiable, never raw coordinates unless asked
 *   3. time is first class: timers are sampled and extrapolated at read time
 *   4. reflexes run in-page at 4-16 ms, not across the network at model speed
 *
 * This file is injected as text by the server. It must stay dependency-free.
 */
(() => {
  'use strict';
  const version = '0.1.0';
  if (window.__iw && window.__iw.version === version) return;

  const now = () => performance.now();
  const clamp = (n, a, b) => (n < a ? a : n > b ? b : n);
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const directText = (el) => {
    let out = '';
    for (const n of el.childNodes) if (n.nodeType === 3) out += n.nodeValue;
    return norm(out);
  };
  const num = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);

  const s = {
    seq: 0,
    mutations: 0,
    lastChange: now(),
    nextRef: 1,
    refs: new Map(), // ref -> WeakRef(el)
    byEl: new WeakMap(), // el -> ref
    meta: new Map(), // ref -> {role, name, tag}
    lastSnap: null,
    lastSnapAt: 0,
    timerHist: new Map(), // el -> {v, t, dir, rate, n}
    timerCache: [],
    lastScan: 0,
    numberHist: new Map(),
    logs: [],
    started: Date.now(),
    dialog: null,
    errors: [],
    watching: 0,
  };

  /* ---------------------------------------------------------------- console */

  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const text = args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        s.logs.push({ t: Date.now(), level, text: text.slice(0, 500) });
        if (s.logs.length > 120) s.logs.splice(0, s.logs.length - 120);
      } catch {}
      orig(...args);
    };
  }

  /* --------------------------------------------------------------- mutation */

  try {
    const mo = new MutationObserver((records) => {
      s.mutations += records.length;
      s.seq++;
      s.lastChange = now();
    });
    const start = () => {
      const root = document.documentElement;
      if (!root) return;
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: undefined });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch {}

  /* ------------------------------------------------------------------- DOM */

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE', 'BR', 'HR']);
  const TEXT_TAGS = new Set(['P', 'SPAN', 'DIV', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'PRE', 'CODE', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'LABEL', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV']);
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'gridcell', 'listbox', 'listitem']);

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'file') return 'button';
      return 'textbox';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return 'image';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'TD' || tag === 'TH') return 'cell';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'FORM') return 'form';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (el.isContentEditable) return 'textbox';
    return 'text';
  }

  function isInteractive(el, role) {
    return INTERACTIVE.has(role) || el.isContentEditable || (el.hasAttribute && el.hasAttribute('onclick')) ||
      (el.hasAttribute && el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0) ||
      role === 'button';
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const tag = el.tagName;
    if (!tag) return false;
    if (SKIP.has(tag)) return false;
    const cs = getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    if (cs.display === 'contents') return true;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return norm(aria).slice(0, 140);
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const t = norm(lb.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' '));
      if (t) return t.slice(0, 140);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = norm([...el.labels].map((l) => l.textContent).join(' '));
        if (t) return t.slice(0, 140);
      }
      if (el.getAttribute('placeholder')) return norm(el.getAttribute('placeholder')).slice(0, 140);
      if ((el.type === 'submit' || el.type === 'button' || el.type === 'reset') && el.value) return norm(el.value).slice(0, 140);
    }
    if (tag === 'IMG') {
      const t = norm(el.getAttribute('alt') || el.getAttribute('title') || '');
      if (t) return t.slice(0, 140);
    }
    const title = el.getAttribute && el.getAttribute('title');
    if (title) return norm(title).slice(0, 140);
    const txt = norm(el.textContent).slice(0, 140);
    if (txt) return txt;
    if (tag === 'INPUT') return norm(el.getAttribute('name') || el.type || 'input').slice(0, 80);
    if (tag === 'A' && el.getAttribute('href')) {
      try { return norm(new URL(el.getAttribute('href'), location.href).pathname).slice(0, 80); } catch {}
    }
    return '';
  }

  function stateOf(el, role) {
    const out = {};
    if (el.disabled) out.disabled = true;
    if (el.readOnly) out.readonly = true;
    if (el.required) out.required = true;
    if (role === 'checkbox' || role === 'radio' || role === 'switch') out.checked = !!el.checked;
    if (el.getAttribute && el.getAttribute('aria-checked') != null) out.checked = el.getAttribute('aria-checked') === 'true';
    if (el.getAttribute && el.getAttribute('aria-expanded') != null) out.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.getAttribute && el.getAttribute('aria-selected') != null) out.selected = el.getAttribute('aria-selected') === 'true';
    if (el.getAttribute && el.getAttribute('aria-pressed') != null) out.pressed = el.getAttribute('aria-pressed') === 'true';
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') out.disabled = true;
    if (el.tagName === 'A' && el.getAttribute('href')) out.href = el.getAttribute('href').slice(0, 200);
    return out;
  }

  function valueOf(el) {
    if (!el) return undefined;
    if (el.tagName === 'SELECT') return el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
    if (el.isContentEditable) return norm(el.innerText).slice(0, 400);
    return undefined;
  }

  function refFor(el) {
    const existing = s.byEl.get(el);
    if (existing) {
      const cur = s.refs.get(existing) && s.refs.get(existing).deref();
      if (cur === el) return existing;
    }
    const ref = 'e' + (s.nextRef++);
    s.byEl.set(el, ref);
    try { s.refs.set(ref, new WeakRef(el)); } catch { s.refs.set(ref, { deref: () => el }); }
    s.meta.set(ref, { role: roleOf(el), name: nameOf(el, roleOf(el)).slice(0, 90), tag: el.tagName });
    if (s.refs.size > 800) {
      for (const [r, w] of s.refs) if (!w.deref()) { s.refs.delete(r); s.meta.delete(r); }
    }
    return ref;
  }

  function elForRef(ref) {
    const w = s.refs.get(ref);
    if (!w) return null;
    const el = w.deref ? w.deref() : null;
    return el && el.isConnected ? el : null;
  }

  /* -------------------------------------------------------------- snapshot */

  function collect(opts = {}) {
    const max = clamp(opts.max || 120, 1, 400);
    const scope = opts.scope || 'full';
    const vw = innerWidth, vh = innerHeight;
    const visitedLimit = opts.visited_limit || 7000;
    let visited = 0;
    const candidates = [];
    const includedInteractive = new WeakSet();
    const insideInteractive = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        if (includedInteractive.has(p)) return true;
        const root = p.getRootNode && p.getRootNode();
        p = p.parentElement || (root && root.host) || null;
      }
      return false;
    };
    const roots = [];
    if (document.documentElement) roots.push(document.documentElement);
    // shadow roots opened from the top document, plus nested ones
    const stack = roots.slice();
    const seen = new Set();
    const order = { n: 0 };
    while (stack.length && visited < visitedLimit) {
      const root = stack.pop();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let el = root.nodeType === 1 ? root : walker.nextNode();
      while (el && visited < visitedLimit) {
        visited++;
        const tag = el.tagName;
        const role = roleOf(el);
        const interactive = isInteractive(el, role);
        const rect = el.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        const vis = rect.width >= 1 && rect.height >= 1 ? visible(el) : false;
        if (vis && (scope === 'full' || inView)) {
          const name = nameOf(el, role);
          const text = directText(el);
          const isHeading = role === 'heading';
          const isAlert = role === 'alert' || role === 'status' || role === 'timer';
          const isImage = role === 'image' && name;
          const isText = !interactive && text.length >= 2 && text.length <= 180 && TEXT_TAGS.has(tag) && !isHeading;
          const nestedInControl = !interactive && (isHeading || isText) && insideInteractive(el);
          if (!nestedInControl && (interactive || isHeading || isAlert || isImage || isText)) {
            let score = interactive ? 100 : isHeading ? 80 : isAlert ? 75 : isImage ? 60 : 30;
            if (interactive && (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) score += 8;
            if (inView) score += 4;
            if (isText) score += clamp(text.length / 12, 0, 8);
            candidates.push({ el, tag, role, name, interactive, text, rect, inView, score, order: order.n++ });
            if (interactive) includedInteractive.add(el);
          }
        }
        // pierce open shadow roots
        if (el.shadowRoot) stack.push(el.shadowRoot);
        const next = walker.nextNode();
        el = next;
      }
    }
    // de-dupe identical text rows that are nested inside an interactive parent that is already included
    const top = candidates.slice().sort((a, b) => b.score - a.score || a.order - b.order).slice(0, max);
    top.sort((a, b) => a.order - b.order);
    return { top, visited, max };
  }

  function boundsOf(r) {
    return [num(r.left), num(r.top), num(r.width), num(r.height)];
  }

  function render(rows, meta) {
    const lines = [];
    lines.push(`# chrome "${meta.title}" ${meta.w}x${meta.h} seq=${meta.seq} n=${rows.length} url=${meta.url}`);
    for (const r of rows) {
      const b = r.bounds || boundsOf(r.rect);
      let line = `@${r.ref} ${r.role} "${r.name.replace(/"/g, "'")}"`;
      if (r.value !== undefined && r.value !== '' && r.value !== r.name) {
        const v = String(r.value).replace(/"/g, "'").slice(0, 80);
        line += ` = "${v}"`;
      }
      const flags = [];
      if (r.state?.checked) flags.push('checked');
      if (r.state?.disabled) flags.push('disabled');
      if (r.state?.expanded) flags.push('expanded');
      if (r.state?.selected) flags.push('selected');
      if (!r.inView) flags.push('offscreen');
      line += ` @${b[0]},${b[1]} ${b[2]}x${b[3]}`;
      if (flags.length) line += ' [' + flags.join(',') + ']';
      lines.push(line);
    }
    if (meta.truncated) lines.push('# truncated');
    return lines.join('\n');
  }

  function snap(opts = {}) {
    const t0 = now();
    const { top, visited } = collect(opts);
    const rows = top.map((c) => {
      const ref = refFor(c.el);
      const role = c.role;
      const state = stateOf(c.el, role);
      const value = valueOf(c.el);
      const m = s.meta.get(ref);
      if (m) m.name = c.name.slice(0, 90);
      return {
        ref, role, name: c.name, value,
        bounds: boundsOf(c.rect), inView: c.inView,
        state: Object.keys(state).length ? state : undefined,
        el: c.el, order: c.order,
      };
    });
    const viewport = { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), dpr: devicePixelRatio };
    const meta = { title: norm(document.title), w: innerWidth, h: innerHeight, seq: s.seq, url: location.href.slice(0, 300) };
    const text = render(rows, { ...meta, truncated: top.length >= (opts.max || 120) });
    s.lastSnap = { at: now(), byRef: new Map(rows.map((r) => [r.ref, { role: r.role, name: r.name, el: r.el }])) };
    s.lastSnapAt = now();
    const outRows = rows.map(({ el, ...r }) => r);
    return {
      ok: true,
      ms: num(now() - t0, 2),
      version,
      seq: s.seq,
      url: location.href,
      title: norm(document.title),
      viewport,
      text,
      elements: outRows,
      visited,
      truncated: top.length >= (opts.max || 120),
      frame_url: location.href,
    };
  }

  /* ----------------------------------------------------------------- pulse */

  function parseTimeText(raw) {
    const str = norm(raw).replace(/^[^\d]+/, '').slice(0, 24);
    if (!str) return null;
    let m = str.match(/^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/);
    if (m) return +(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)).toFixed(3);
    m = str.match(/^(\d{1,6}(?:[.,]\d{1,3})?)\s*(ms|milliseconds?|s|secs?|seconds?)\s*$/i);
    if (m) {
      const v = Number(m[1].replace(',', '.'));
      return /^m/i.test(m[2]) && !/^milli/i.test(m[2]) ? v / 1000 : v;
    }
    m = str.match(/^(\d{1,4}(?:[.,]\d{1,3})?)\s*$/);
    if (m) return Number(m[1].replace(',', '.'));
    return null;
  }

  function candidateTimers() {
    const t = now();
    if (s.timerCache.length && t - s.lastScan < 800) return s.timerCache;
    s.lastScan = t;
    const out = [];
    const all = document.querySelectorAll('*');
    const cap = Math.min(all.length, 9000);
    for (let i = 0; i < cap && out.length < 24; i++) {
      const el = all[i];
      if (!el || SKIP.has(el.tagName)) continue;
      const tag = el.tagName;
      const idc = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
      const keyed = /timer|count|clock|remain|time|quiz/i.test(idc) || el.getAttribute('role') === 'timer';
      if (!keyed && tag !== 'TIME') continue;
      const txt = norm(el.textContent);
      if (!txt || txt.length > 28) continue;
      if (parseTimeText(txt) == null) continue;
      if (!visible(el)) continue;
      out.push(el);
    }
    // large numeric text, even without a telling class (Kahoot's countdown is just a big number)
    if (out.length < 6) {
      for (let i = 0; i < cap && out.length < 12; i++) {
        const el = all[i];
        if (!el || SKIP.has(el.tagName) || !TEXT_TAGS.has(el.tagName)) continue;
        const txt = directText(el);
        if (!txt || txt.length > 8 || parseTimeText(txt) == null) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
        if (fs < 26) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.top > innerHeight) continue;
        out.push(el);
        if (out.length >= 12) break;
      }
    }
    s.timerCache = out;
    return out;
  }

  function timerSignal(el) {
    const txt = norm(el.textContent);
    const v = parseTimeText(txt);
    if (v == null) return null;
    const t = now();
    let h = s.timerHist.get(el);
    if (!h) {
      h = { v, t, dir: 'idle', rate: 0, n: 0, lastChange: t, born: t, samples: [{ t, v }] };
      s.timerHist.set(el, h);
      return { el, text: txt, v, dir: 'idle', rate: 0, age: 0, changed: false };
    }
    const dt = t - h.t;
    let changed = false;
    if (dt > 0 && Math.abs(v - h.v) > 1e-6) {
      // A jump up by more than ~20% is a reset (next question), not a tick.
      const reset = v > h.v + Math.max(0.25, Math.abs(h.v) * 0.2) && (t - h.lastChange) > 180;
      if (reset) { h.samples = [{ t, v }]; h.rate = 0; h.dir = 'up'; h.born = t; }
      else {
        h.samples.push({ t, v });
        if (h.samples.length > 90) h.samples.shift();
        const newest = h.samples[h.samples.length - 1];
        // Skip the warm-up window: before the page's own timer has ticked, the
        // initial HTML value (e.g. "20.00") makes the first slope look too steep.
        let oldest = null;
        for (const smp of h.samples) {
          if (newest.t - smp.t <= 1600 && smp.t >= h.born + 300) { oldest = smp; break; }
        }
        const span = oldest ? newest.t - oldest.t : 0;
        if (oldest && span >= 400) {
          const r = (oldest.v - newest.v) / span; // units per ms, positive = counting down
          if (Number.isFinite(r) && Math.abs(r) < 20) h.rate = r;
        }
        h.dir = v < h.v ? 'down' : 'up';
      }
      h.lastChange = t;
      changed = true;
    } else if (dt > 250) {
      if (t - h.lastChange > 900) h.dir = 'idle';
    }
    if (changed) { h.v = v; h.t = t; h.n++; }
    const age = t - h.t;
    // A timer that stopped changing is not still ticking. Extrapolate only
    // across a normal frame gap, never across a stall (the Kahoot "answered" case).
    if (age > 150) { h.dir = 'idle'; h.rate = 0; }
    let est = h.v;
    if (h.dir === 'down' && h.rate > 0 && age < 100) est = Math.max(0, h.v - h.rate * age);
    else if (h.dir === 'up' && h.rate < 0 && age < 100) est = h.v - h.rate * age;
    return { el, text: txt, v, est, dir: h.dir, rate: h.rate, age, changed, last_change: t - h.lastChange };
  }

  function timerRows() {
    const out = [];
    for (const el of candidateTimers()) {
      const sig = timerSignal(el);
      if (!sig) continue;
      const r = el.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      const idc = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
      const keyed = /timer|count|clock|remain/i.test(idc) || el.getAttribute('role') === 'timer';
      const salience = fs * Math.max(1, r.width * r.height / 2000) + (keyed ? 120 : 0) + (sig.dir === 'down' ? 40 : 0);
      if (sig.dir === 'idle' && sig.age < 200 && /count|timer|remain/i.test(idc)) sig.dir = 'down';
      out.push({ ...sig, ref: s.byEl.get(el) || null, fs, keyed, salience: num(salience, 1), bounds: boundsOf(r) });
    }
    out.sort((a, b) => b.salience - a.salience);
    return out;
  }

  function activeInfo() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return {
      ref: s.byEl.get(el) || null,
      tag: el.tagName, role: roleOf(el), name: nameOf(el, roleOf(el)).slice(0, 80),
      value: valueOf(el), editable: !!el.isContentEditable || /INPUT|TEXTAREA/.test(el.tagName),
    };
  }

  function dialogs() {
    const out = [];
    for (const el of document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog]')) {
      if (!visible(el)) continue;
      const txt = norm(el.innerText || el.textContent).slice(0, 220);
      if (txt) out.push(txt);
      if (out.length >= 3) break;
    }
    return out;
  }

  function alerts() {
    const out = [];
    for (const el of document.querySelectorAll('[role=alert], [role=status], [aria-live=assertive]')) {
      if (!visible(el)) continue;
      const txt = norm(el.innerText || el.textContent).slice(0, 180);
      if (txt) out.push(txt);
      if (out.length >= 4) break;
    }
    return out;
  }

  function media() {
    const out = [];
    for (const el of document.querySelectorAll('video, audio')) {
      if (el.paused || el.ended) continue;
      out.push({ tag: el.tagName.toLowerCase(), t: num(el.currentTime, 2), dur: num(el.duration, 2), muted: !!el.muted });
    }
    return out;
  }

  function pulse(opts = {}) {
    const t0 = now();
    const timers = opts.light ? timerRows().slice(0, 4) : timerRows();
    const countdown = timers.find((x) => x.dir === 'down') || timers[0] || null;
    const numbers = [];
    for (const [el, h] of s.numberHist) {
      if (!el.isConnected) { s.numberHist.delete(el); continue; }
      numbers.push({ name: norm(el.textContent).slice(0, 60), value: h.v, delta: h.delta, at: h.t, ref: s.byEl.get(el) || null });
      if (numbers.length >= 8) break;
    }
    const pulse = {
      ok: true,
      ms: num(now() - t0, 2),
      t: { perf: now(), epoch: Date.now() },
      seq: s.seq,
      mutations: s.mutations,
      last_change_age_ms: Math.round(now() - s.lastChange),
      url: location.href,
      title: norm(document.title),
      ready_state: document.readyState,
      viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight },
      focus: activeInfo(),
      timers: timers.map(({ el, ...x }) => x),
      countdown: countdown ? (({ el, ...x }) => x)(countdown) : null,
      numbers,
      dialogs: dialogs(),
      alerts: alerts(),
      media: media(),
      dialog_open: !!s.dialog,
      logs: s.logs.slice(-8),
    };
    return pulse;
  }

  function trackNumbers(rows) {
    for (const r of rows) {
      if (!/^\d{1,8}$/.test(String(r.name || '').trim())) continue;
      const el = r.el;
      const v = Number(r.name);
      const prev = s.numberHist.get(el);
      if (!prev) s.numberHist.set(el, { v, delta: 0, t: now() });
      else if (prev.v !== v) { prev.delta = v - prev.v; prev.v = v; prev.t = now(); }
    }
  }

  /* --------------------------------------------------------------- targets */

  function deepQuery(selector, root = document) {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch { return null; }
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        const found = deepQuery(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function textMatches(el, needle) {
    const n = needle.toLowerCase();
    const nm = nameOf(el, roleOf(el)).toLowerCase();
    if (nm === n || nm.startsWith(n) || nm.includes(n)) return true;
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')).toLowerCase();
    return aria.includes(n);
  }

  function byText(needle, root = document) {
    const n = needle.toLowerCase();
    let best = null;
    const all = root.querySelectorAll('button, a, [role=button], [role=link], [role=tab], [role=menuitem], input, label, li, [tabindex]');
    for (const el of all) {
      if (!visible(el)) continue;
      if (!textMatches(el, n)) continue;
      const exact = nameOf(el, roleOf(el)).toLowerCase() === n;
      if (exact) return el;
      if (!best) best = el;
    }
    if (best) return best;
    // last resort: deepest visible text node
    const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = w.nextNode())) {
      const t = norm(node.nodeValue);
      if (t.toLowerCase().includes(n)) {
        const p = node.parentElement;
        if (p && visible(p)) return p.closest('button, a, [role=button], label, li') || p;
      }
    }
    return null;
  }

  function resolve(target) {
    if (target == null) return { error: 'no_target' };
    if (typeof target === 'object') {
      if (target.ref) return resolve('@' + String(target.ref).replace(/^@/, ''));
      if (target.selector) {
        const el = deepQuery(String(target.selector));
        return el ? { el } : { error: 'no_element', detail: target.selector };
      }
      if (target.text) {
        const el = byText(String(target.text));
        return el ? { el } : { error: 'no_element', detail: target.text };
      }
      if (target.x != null && target.y != null) return { point: { x: Number(target.x), y: Number(target.y) } };
      return { error: 'bad_target' };
    }
    const t = String(target).trim();
    if (t.startsWith('@') || /^e\d+$/.test(t)) {
      const ref = t.replace(/^@/, '');
      const el = elForRef(ref);
      if (!el) return { error: 'stale', detail: 'ref ' + ref + ' is gone' };
      const meta = s.meta.get(ref);
      const role = roleOf(el);
      const name = nameOf(el, role);
      if (meta && (meta.tag !== el.tagName || meta.role !== role)) {
        return { error: 'stale', detail: 'ref ' + ref + ' now ' + el.tagName + '/' + role };
      }
      if (meta && meta.name && name && !(name === meta.name || name.startsWith(meta.name.slice(0, 24)) || meta.name.startsWith(name.slice(0, 24)))) {
        return { error: 'stale', detail: 'ref ' + ref + ' label changed: "' + name.slice(0, 40) + '"' };
      }
      return { el, ref, role, name };
    }
    if (t.startsWith('css=')) {
      const el = deepQuery(t.slice(4));
      return el ? { el } : { error: 'no_element', detail: t };
    }
    if (t.startsWith('text=')) {
      const el = byText(t.slice(5));
      return el ? { el } : { error: 'no_element', detail: t };
    }
    if (/^[#.[>\s]/.test(t) || t.includes('>')) {
      const el = deepQuery(t);
      if (el) return { el };
    }
    const el = byText(t);
    return el ? { el } : { error: 'no_element', detail: t };
  }

  function pointOf(target) {
    const r = resolve(target);
    if (r.error) return { ok: false, ...r };
    if (r.point) {
      const hit = document.elementFromPoint(r.point.x, r.point.y);
      return { ok: true, x: r.point.x, y: r.point.y, hit: hit ? { tag: hit.tagName, name: nameOf(hit, roleOf(hit)).slice(0, 60), role: roleOf(hit) } : null };
    }
    const el = r.el;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch { el.scrollIntoView(); }
    const rect = el.getBoundingClientRect();
    const x = clamp(rect.left + rect.width / 2, 0, innerWidth - 1);
    const y = clamp(rect.top + rect.height / 2, 0, innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const same = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return {
      ok: true,
      x: num(x, 2), y: num(y, 2),
      rect: boundsOf(rect),
      ref: r.ref || s.byEl.get(el) || null,
      role: r.role || roleOf(el),
      name: (r.name || nameOf(el, roleOf(el))).slice(0, 80),
      hit: hit ? { tag: hit.tagName, role: roleOf(hit), name: nameOf(hit, roleOf(hit)).slice(0, 60), same } : null,
      occluded: !!hit && !same,
    };
  }

  /* --------------------------------------------------------------- actions */

  function click(target) {
    const r = resolve(target);
    if (r.error) return { ok: false, ...r };
    if (r.point) {
      const el = document.elementFromPoint(r.point.x, r.point.y);
      if (!el) return { ok: false, error: 'no_element' };
      el.click();
      return { ok: true, mode: 'point', name: nameOf(el, roleOf(el)).slice(0, 60) };
    }
    const el = r.el;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    el.click();
    return { ok: true, mode: 'dom', ref: r.ref || s.byEl.get(el) || null, name: (r.name || '').slice(0, 60) };
  }

  function focusEl(el) {
    try { el.focus({ preventScroll: false }); } catch { try { el.focus(); } catch {} }
    if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(target, text) {
    const r = resolve(target);
    if (r.error) return { ok: false, ...r };
    const el = r.el;
    focusEl(el);
    text = String(text);
    let method = 'native';
    if (el.isContentEditable) {
      try {
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, text);
        if (!ok) throw new Error('execCommand');
        method = 'execCommand';
      } catch {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        method = 'textContent';
      }
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      setNativeValue(el, text);
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      method = 'textContent';
    }
    return { ok: true, ref: r.ref || s.byEl.get(el) || null, value: valueOf(el), method };
  }

  function select(target, value) {
    const r = resolve(target);
    if (r.error) return { ok: false, ...r };
    const el = r.el;
    if (el.tagName !== 'SELECT') return { ok: false, error: 'not_select' };
    const vals = Array.isArray(value) ? value.map(String) : [String(value)];
    let ok = false;
    for (const opt of el.options) {
      const sel = vals.includes(opt.value) || vals.includes(norm(opt.textContent));
      opt.selected = sel;
      if (sel) ok = true;
    }
    if (!ok) return { ok: false, error: 'no_option', options: [...el.options].map((o) => o.value || o.textContent).slice(0, 20) };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: valueOf(el) };
  }

  function check(target, on) {
    const r = resolve(target);
    if (r.error) return { ok: false, ...r };
    const el = r.el;
    if (el.checked !== !!on) {
      el.click();
    }
    return { ok: true, checked: !!el.checked };
  }

  async function batch(steps, opts = {}) {
    const t0 = now();
    const results = [];
    const sigBefore = sig();
    let failed = null;
    for (const st of steps) {
      const t = now();
      const op = Object.keys(st).find((k) => !['optional', 'timeout_ms', 'label', 'force'].includes(k));
      const a = op ? st[op] : null;
      let r = { ok: true };
      try {
        if (op === 'click') {
          r = click(a);
        } else if (op === 'fill' || op === 'type') {
          const isObj = a && typeof a === 'object';
          const text = isObj ? String(a.text ?? a.value ?? '') : String(a);
          if (isObj && (a.ref || a.selector)) r = fill(a.ref ? { ref: a.ref } : { selector: a.selector }, text);
          else {
            const el = document.activeElement;
            if (!el || el === document.body) r = { ok: false, error: 'no_focus' };
            else if (el.isContentEditable) { el.focus(); document.execCommand('insertText', false, text); r = { ok: true, method: 'focused-contenteditable' }; }
            else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { setNativeValue(el, text); r = { ok: true, method: 'focused-native' }; }
            else r = { ok: false, error: 'not_editable' };
          }
        } else if (op === 'select') {
          r = select(a.ref ? { ref: a.ref } : a.selector ? { selector: a.selector } : a, a.value ?? a.text ?? '');
        } else if (op === 'check' || op === 'uncheck') {
          r = check(a, op === 'check');
        } else if (op === 'scroll') {
          const dy = typeof a === 'number' ? a : Number(a?.dy || 0);
          const dx = typeof a === 'object' && a ? Number(a.dx || 0) : 0;
          const target = typeof a === 'object' && a ? (a.ref || a.selector || a.text || null) : null;
          if (target) {
            const resolved = resolve(target);
            if (resolved.error) r = { ok: false, ...resolved };
            else { resolved.el.scrollIntoView({ block: 'center', inline: 'center' }); r = { ok: true }; }
          } else {
            scrollBy(dx, dy);
            r = { ok: true, dy, dx };
          }
        } else if (op === 'wait') {
          await new Promise((res) => setTimeout(res, Math.max(0, Math.min(Number(a) || 0, 30000))));
          r = { ok: true, waited_ms: Number(a) || 0 };
        } else if (op === 'waitFor') {
          r = await waitFor(typeof a === 'object' ? a : { text: String(a) });
        } else {
          r = { ok: false, error: 'unsupported_batch', op };
        }
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      results.push({ op, ok: r.ok !== false, ms: num(now() - t, 2), ...(r.ok === false ? { error: r.error, detail: r.detail } : {}) });
      if (r.ok === false && !st.optional) { failed = r; break; }
    }
    let changed = sig() !== sigBefore;
    if (!changed && opts.wait_ms) {
      await new Promise((res) => setTimeout(res, Math.min(Number(opts.wait_ms) || 0, 500)));
      changed = sig() !== sigBefore;
    }
    return {
      ok: !failed, steps: results, ms: num(now() - t0, 2), changed,
      sig_before: sigBefore, sig_after: sig(),
      error: failed ? failed.error : undefined,
      detail: failed ? failed.detail : undefined,
    };
  }

  async function waitFor({ text, selector, gone, predicate, timeout_ms = 5000, since = 0 } = {}) {
    const t0 = now();
    const timeout = clamp(Number(timeout_ms) || 5000, 0, 60000);
    const check = () => {
      try {
        if (since && s.seq <= since) return false;
        if (gone) {
          const el = selector ? deepQuery(selector) : byText(gone);
          return !el || !visible(el);
        }
        if (selector) { const el = deepQuery(selector); return !!el && visible(el); }
        if (text) { const el = byText(text); return !!el && visible(el); }
        if (predicate) {
          const fn = typeof predicate === 'function' ? predicate : new Function('iw', 'return (' + predicate + ')');
          return !!fn(IW);
        }
        return since ? s.seq > since : true;
      } catch { return false; }
    };
    if (check()) return { ok: true, ms: num(now() - t0, 2), immediate: true, seq: s.seq };
    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok, extra = {}) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        try { mo.disconnect(); } catch {}
        resolve({ ok, ms: num(now() - t0, 2), seq: s.seq, ...extra });
      };
      const tick = () => { if (check()) finish(true); };
      const iv = setInterval(tick, 12);
      let mo = null;
      try {
        mo = new MutationObserver(() => { if (check()) finish(true); });
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch {}
      setTimeout(() => finish(false, { timeout: true }), timeout);
    });
  }

  async function reflex({ until, do: action, every_ms = 8, timeout_ms = 8000, max_fires = 1, capture = true } = {}) {
    const t0 = now();
    const timeout = clamp(Number(timeout_ms) || 8000, 1, 60000);
    const every = clamp(Number(every_ms) || 8, 1, 1000);
    const pred = typeof until === 'function' ? until : new Function('iw', 'snap', 'return (' + String(until) + ')');
    const act = action == null ? null : (typeof action === 'function' ? action : new Function('iw', 'snap', String(action)));
    const samples = [];
    return await new Promise((resolve) => {
      let fired = 0, busy = false, stopped = false;
      const finish = (ok, extra = {}) => {
        if (stopped) return;
        stopped = true;
        clearInterval(iv); clearTimeout(to);
        resolve({ ok, fired, total_ms: num(now() - t0, 2), seq: s.seq, samples: samples.slice(-60), ...extra });
      };
      const tick = async () => {
        if (busy || stopped) return;
        busy = true;
        try {
          const p = pulse({ light: true });
          const truth = !!pred(IW, p);
          if (capture && samples.length < 240) {
            samples.push({ t: num(now() - t0, 1), v: p.countdown ? num(p.countdown.est, 3) : null, truth });
          }
          if (truth) {
            const at = now();
            let result = null;
            if (act) result = await act(IW, p);
            fired++;
            if (fired >= max_fires) {
              const reaction = num(now() - at, 2);
              finish(true, { reaction_ms: reaction, at: p.countdown || null, result, fired_at: Date.now() });
            }
          }
        } catch (e) {
          if (capture) samples.push({ t: num(now() - t0, 1), error: String(e && e.message || e) });
        }
        busy = false;
      };
      const iv = setInterval(tick, every);
      const to = setTimeout(() => finish(false, { timeout: true, last: pulse({ light: true }).countdown }), timeout);
      tick();
    });
  }

  function read(target, max = 4000) {
    let el = null;
    if (target) { const r = resolve(target); if (r.error) return { ok: false, ...r }; el = r.el || null; }
    const root = el || document.body;
    const text = norm(root ? root.innerText || root.textContent : '').slice(0, max);
    return { ok: true, text, chars: text.length };
  }

  function find(text, limit = 12) {
    const out = [];
    const needle = String(text || '').toLowerCase();
    if (!needle) return out;
    const all = document.querySelectorAll('button, a, [role=button], [role=link], [role=tab], li, p, h1, h2, h3, h4, span, div, label, input, td, th');
    const cap = Math.min(all.length, 6000);
    for (let i = 0; i < cap && out.length < limit; i++) {
      const el = all[i];
      if (!visible(el)) continue;
      const nm = nameOf(el, roleOf(el));
      if (!nm || !nm.toLowerCase().includes(needle)) continue;
      out.push({ ref: s.byEl.get(el) || null, role: roleOf(el), name: nm.slice(0, 100), bounds: boundsOf(el.getBoundingClientRect()) });
    }
    return out;
  }

  function sig() {
    let h = 2166136261;
    const mix = (v) => {
      const str = String(v);
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    };
    mix(document.title); mix(location.href);
    const els = document.querySelectorAll('button,a[href],input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[contenteditable="true"],[role=dialog]');
    let n = 0;
    for (const el of els) {
      if (n++ > 400) break;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const role = roleOf(el);
      mix(el.tagName); mix(role); mix(nameOf(el, role).slice(0, 90));
      mix(el.value ?? ''); mix(!!el.checked); mix(!!el.disabled);
      mix(el.getAttribute('aria-expanded')); mix(el.getAttribute('aria-selected')); mix(el.getAttribute('aria-checked'));
    }
    for (const d of document.querySelectorAll('[role=dialog],[role=alert],[role=status]')) {
      mix(norm(d.innerText || d.textContent).slice(0, 140));
    }
    return h >>> 0;
  }

  function frameInfo() {
    return { url: location.href, title: norm(document.title), w: innerWidth, h: innerHeight, seq: s.seq, ready: document.readyState };
  }

  const IW = {
    version,
    snap,
    pulse,
    point: pointOf,
    click,
    fill,
    select,
    check,
    waitFor,
    reflex,
    read,
    find,
    sig,
    batch,
    frameInfo,
    refs: () => s.refs.size,
    seq: () => s.seq,
    logs: (n = 20) => s.logs.slice(-n),
    clearLogs: () => { s.logs.length = 0; },
    _state: s,
  };

  window.__iw = IW;
  window.iw = IW;

  // keep timer history warm: direction and rate are known on the first read
  try {
    setInterval(() => {
      try {
        if (document.querySelectorAll('*').length > 9000) return;
        for (const el of candidateTimers()) timerSignal(el);
      } catch {}
    }, 120);
  } catch {}

  // keep numeric trackers fresh for scoreboards; cheap and local
  try {
    setInterval(() => {
      if (!s.lastSnap) return;
      // refresh a few known numeric value elements from the last snapshot
      for (const [ref, m] of s.meta) {
        if (!m || !m.name) continue;
        if (!/^\d{1,6}$/.test(m.name)) continue;
        const el = elForRef(ref);
        if (!el) continue;
        const v = Number(norm(el.textContent).slice(0, 8));
        if (!Number.isFinite(v)) continue;
        const prev = s.numberHist.get(el);
        if (!prev) s.numberHist.set(el, { v, delta: 0, t: now() });
        else if (prev.v !== v) { prev.delta = v - prev.v; prev.v = v; prev.t = now(); }
      }
    }, 500);
  } catch {}
})();

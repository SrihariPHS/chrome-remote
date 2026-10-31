import { round } from './util.mjs';

/** Thin, policy-free facade shared by HTTP, MCP and the UI. */
export class Service {
  constructor(fleet) { this.fleet = fleet; }

  resolve(id) {
    if (id) {
      const s = this.fleet.get(id);
      if (!s) { const e = new Error('unknown session: ' + id); e.code = 'no_session'; throw e; }
      return s;
    }
    const all = [...this.fleet.sessions.values()];
    if (!all.length) { const e = new Error('no sessions; create one first'); e.code = 'no_session'; throw e; }
    return all.sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  list() { return this.fleet.list(); }

  async open({ id, url, name, viewport, observe = true, max = 80 } = {}) {
    const t0 = performance.now();
    let s;
    if (id) {
      s = this.resolve(id);
      if (url) {
        const r = await s.goto(url);
        if (!r.ok) return { ...r, session: s.id, summary: s.summary() };
      }
    } else {
      s = await this.fleet.create({ name, url, viewport });
    }
    const out = {
      ok: true,
      session: s.id,
      summary: s.summary(),
      create_ms: s.createMs,
      handoff_ms: s.handoffMs ?? null,
      open_ms: round(performance.now() - t0, 1),
    };
    if (url && observe !== false) {
      const snap = await s.snap({ max, scope: 'viewport' });
      out.obs = { text: snap.text, elements: snap.elements, url: snap.url, title: snap.title, bytes: snap.bytes };
      out.text = snap.text;
      out.snap_ms = snap.ms;
      out.open_ms = round(performance.now() - t0, 1);
    }
    return out;
  }

  async close(id) { return { ok: await this.fleet.close(id), session: id }; }

  /** Open + a whole batch + observation in one call (the "do the task" path). */
  async task({ id, url, name, steps = [], input = 'dom', verify = 'change', observe = true, max = 80 } = {}) {
    const t0 = performance.now();
    let s;
    let created = false;
    if (id) {
      s = this.resolve(id);
      if (url) await s.goto(url);
    } else {
      s = await this.fleet.create({ name, url });
      created = true;
    }
    const openMs = round(performance.now() - t0, 1);
    if (!steps.length) {
      const snap = await s.snap({ max, scope: 'viewport' });
      return {
        ok: true, session: s.id, created,
        total_ms: round(performance.now() - t0, 1), open_ms: openMs, act_ms: 0,
        steps: [], changed: null,
        obs: { text: snap.text, elements: snap.elements, url: snap.url, title: snap.title, bytes: snap.bytes },
        text: snap.text,
      };
    }
    const act = await s.act({ steps, input, verify, observe, max });
    return {
      ok: act.ok,
      session: s.id,
      created,
      total_ms: round(performance.now() - t0, 1),
      open_ms: openMs,
      act_ms: act.ms,
      steps: act.steps,
      changed: act.changed,
      obs: act.obs,
      text: act.obs?.text,
      error: act.error,
      detail: act.detail,
    };
  }

  snap(id, opts = {}) { return this.resolve(id).snap(opts); }

  pulse(id, opts = {}) { return this.resolve(id).pulse(opts); }

  act(id, opts = {}) { return this.resolve(id).act(opts); }

  eval(id, { code, timeout_ms } = {}) { return this.resolve(id).evalCode(code, { timeout: timeout_ms }); }

  async reflex(id, { until, action, do: actCode, every_ms = 8, timeout_ms = 8000, max_fires = 1 } = {}) {
    const s = this.resolve(id);
    await s.ensurePage();
    const t0 = performance.now();
    const args = { until, do: actCode ?? action ?? null, every_ms, timeout_ms, max_fires };
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('reflex timed out at transport')), Number(timeout_ms) + 3000); });
    try {
      const r = await Promise.race([
        s.cdpEval(`window.__iw && window.__iw.reflex(${JSON.stringify(args)})`, { timeout: Number(timeout_ms) + 2500 }),
        timeout,
      ]);
      clearTimeout(timer);
      r.ms = round(performance.now() - t0, 2);
      s.log('reflex', r.ms, !!r.ok, r.fired ? `${r.fired} fired` : 'timeout');
      return { ...r, session: s.id };
    } catch (e) {
      clearTimeout(timer);
      s.log('reflex', round(performance.now() - t0, 2), false, e.message);
      return { ok: false, error: 'reflex_failed', detail: String(e.message || e).slice(0, 300), session: s.id };
    }
  }

  async wait(id, { text, selector, predicate, timeout_ms = 5000, since } = {}) {
    const s = this.resolve(id);
    const t0 = performance.now();
    try {
      const r = await s.cdpEval(`window.__iw && window.__iw.waitFor(${JSON.stringify({ text, selector, predicate, timeout_ms, since })})`, { timeout: Number(timeout_ms) + 2500 });
      const ms = round(performance.now() - t0, 2);
      s.log('wait', ms, !!r.ok, text || selector || predicate || '');
      return { ...r, session: s.id, ms };
    } catch (e) {
      return { ok: false, error: 'wait_failed', detail: String(e.message || e).slice(0, 300), session: s.id };
    }
  }

  async screenshot(id, { full_page = false, quality = 72 } = {}) {
    const s = this.resolve(id);
    const t0 = performance.now();
    const buf = await s.page.screenshot({ type: 'jpeg', quality, fullPage: !!full_page });
    const ms = round(performance.now() - t0, 2);
    s.log('screenshot', ms, true, `${buf.length}B`);
    return { ok: true, ms, bytes: buf.length, data_url: 'data:image/jpeg;base64,' + buf.toString('base64') };
  }

  async timeline(id) {
    const s = this.resolve(id);
    return { ok: true, session: s.id, timeline: s.timeline.slice(-120), console: s.console.slice(-10), errors: s.errors.slice(-10), dialogs: s.dialogs.slice(-5), downloads: s.downloads.slice(-10) };
  }
}

export const service = (fleet) => new Service(fleet);

/**
 * Recipes: small, deterministic intent shortcuts for common web apps.
 *
 * These are heuristics, not vendor integrations. They are deliberately generic
 * (quiz UIs, contenteditable documents) so they survive DOM changes, and they
 * return the evidence they used so an agent can verify the guess.
 */
export const recipes = {
  'quiz.state': {
    description: 'Read a Kahoot-style quiz: question, answer tiles (with refs), countdown, score, phase. Heuristic; verify against the returned evidence.',
    args: {},
    run: async (session) => session.evalCode(`
      const vis = (el) => {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
      };
      const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const pulse = iw.pulse();
      const heads = [...document.querySelectorAll('h1,h2,h3,[class*=question],[id*=question],[data-testid*=question]')]
        .filter(vis).map(el => ({ el, t: txt(el), fs: parseFloat(getComputedStyle(el).fontSize) || 0 }))
        .filter(x => x.t && x.t.length < 220).sort((a,b) => b.fs - a.fs);
      const question = heads[0] || null;
      const answerEls = [...document.querySelectorAll('button,[role=button],[class*=answer],[class*=tile],[class*=choice]')]
        .filter(vis)
        .map(el => ({ el, t: txt(el) }))
        .filter(x => x.t && x.t.length <= 90 && x.el !== (question && question.el))
        .filter(x => !/^(next|continue|submit|skip|back|start|play|join|close)\b/i.test(x.t))
        .filter(x => !x.el.querySelector('button,[role=button],[class*=answer],[class*=tile],[class*=choice]'))
        .filter((x, i, arr) => arr.findIndex(y => y.t === x.t) === i);
      const snap = iw.snap({ max: 140 });
      const refOf = (el) => { const row = snap.elements.find(r => r.name === txt(el)); return row ? row.ref : null; };
      const scoreCandidates = [...document.querySelectorAll('[class*=score],[class*=points],[class*=streak],[data-testid*=score]')]
        .filter(vis).map(el => ({ name: (el.getAttribute('aria-label') || el.className || 'score').toString().slice(0,60), value: txt(el).slice(0,30) }));
      return {
        question: question ? question.t : null,
        answers: answerEls.slice(0, 6).map((x, i) => ({ index: i, text: x.t, ref: refOf(x.el) })),
        countdown: pulse.countdown,
        numbers: pulse.numbers,
        score: scoreCandidates.slice(0, 4),
        phase: answerEls.length ? 'question' : (pulse.countdown ? 'interstitial' : 'unknown'),
        url: location.href,
        evidence: { headings: heads.slice(0, 3).map(h => ({ text: h.t.slice(0, 80), fontSize: h.fs })) },
      };
    `),
  },

  'quiz.answer': {
    description: 'Answer the current quiz question by index (0-based), visible text, or ref. Uses the page-side click (instant, synthetic) after re-reading quiz.state.',
    args: { index: 'number (0-based)', text: 'string', ref: 'string' },
    run: async (session, args = {}) => {
      const state = await recipes['quiz.state'].run(session);
      if (!state.ok) return state;
      const v = state.value || {};
      const answers = v.answers || [];
      let pick = null;
      if (args.ref) pick = { ref: args.ref, text: '' };
      else if (args.text) pick = answers.find((a) => a.text.toLowerCase().includes(String(args.text).toLowerCase()));
      else if (Number.isInteger(args.index)) pick = answers[args.index];
      if (!pick) return { ok: false, error: 'no_answer_match', answers: answers.map((a) => a.text) };
      const code = pick.ref
        ? `return iw.click(${JSON.stringify(pick.ref)})`
        : `return iw.click(${JSON.stringify(pick.text)})`;
      const r = await session.evalCode(code);
      return { ok: r.ok && r.value?.ok !== false, picked: pick, result: r.value, ms: r.ms, state: v };
    },
  },

  'kahoot.join': {
    description: 'Open kahoot.it, accept the cookie banner, enter a game PIN and (unless dry_run) a nickname. Returns the join-screen evidence or the in-game snapshot. Experimental; the join screen was verified live, a real game was not.',
    args: { pin: 'string (required unless dry_run)', name: 'nickname (default "agent")', dry_run: 'boolean: stop after filling the PIN' },
    run: async (session, args = {}) => {
      const page = session.page;
      const t0 = performance.now();
      await page.goto('https://kahoot.it', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(600);
      // Cookie banner (DOM, not a JS dialog).
      for (const name of [/accept all cookies/i, /^accept$/i]) {
        const b = page.getByRole('button', { name }).first();
        if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break; }
      }
      const pin = String(args.pin || '').replace(/\D/g, '');
      if (!pin) return { ok: false, error: 'pin_required', hint: 'pass {"pin":"123456","name":"agent"}' };
      const input = page.locator('input[name="gameId"], input[placeholder*="PIN" i], input[autocomplete="off"][type="text"]').first();
      await input.waitFor({ state: 'visible', timeout: 8000 });
      await input.fill(pin);
      if (args.dry_run) {
        return { ok: true, phase: 'pin-filled', pin, ms: Math.round((performance.now() - t0) * 10) / 10, snap: (await session.snap({ max: 60 })).text };
      }
      await input.press('Enter');
      const nick = page.locator('input[name="nickname"], input[placeholder*="Nickname" i], input[type="text"]').last();
      const gotNick = await nick.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      if (!gotNick) {
        const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
        return { ok: false, error: 'join_rejected', phase: 'pin', detail: text, pin, ms: Math.round((performance.now() - t0) * 10) / 10 };
      }
      await nick.fill(String(args.name || 'agent'));
      await nick.press('Enter');
      await page.waitForTimeout(1200);
      const snap = await session.snap({ max: 100 });
      return { ok: true, phase: 'joined', pin, name: String(args.name || 'agent'), ms: Math.round((performance.now() - t0) * 10) / 10, snap: snap.text, url: page.url(), title: snap.title };
    },
  },

  'doc.append': {
    description: 'Append text to a contenteditable document (Google Docs, Notion-style editors, ProseMirror). Clicks the page, presses Control+End, then inserts text as one trusted input event.',
    args: { text: 'string', newline: 'boolean (default true)' },
    run: async (session, args = {}) => {
      const text = String(args.text ?? '');
      const page = session.page;
      const t0 = performance.now();
      const hit = await page.evaluate(() => {
        const ed = document.querySelector('[contenteditable="true"], .ProseMirror, .kix-appview-editor, .docs-texteventtarget-iframe, textarea');
        if (!ed) return null;
        const r = ed.getBoundingClientRect();
        const target = document.querySelector('.kix-page') || ed;
        const rr = target.getBoundingClientRect();
        return { x: rr.left + rr.width / 2, y: rr.top + Math.min(rr.height - 10, 120), tag: target.className || target.tagName };
      });
      if (!hit) return { ok: false, error: 'no_editor' };
      await page.mouse.click(hit.x, hit.y);
      await page.keyboard.press('Control+End');
      if (args.newline !== false && text) await page.keyboard.press('Enter');
      if (text) await page.keyboard.insertText(text);
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      return { ok: true, ms, chars: text.length, editor: hit.tag };
    },
  },

  'doc.read': {
    description: 'Read the visible text of the document/editor (or the whole page body if no editor is found).',
    args: { max: 'number (default 4000)' },
    run: async (session, args = {}) => session.evalCode(`
      const ed = document.querySelector('[contenteditable="true"], .ProseMirror, .kix-appview-editor, textarea');
      return iw.read(ed ? { selector: ed.matches('[contenteditable="true"]') ? '[contenteditable="true"]' : undefined } : undefined, ${Number(args.max) || 4000});
    `),
  },
};

export function listRecipes() {
  return Object.entries(recipes).map(([name, r]) => ({ name, description: r.description, args: r.args }));
}

export async function runRecipe(session, name, args) {
  const r = recipes[name];
  if (!r) return { ok: false, error: 'unknown_recipe', name, available: Object.keys(recipes) };
  const t0 = performance.now();
  const out = await r.run(session, args || {});
  return { ...out, recipe: name, ms: out.ms ?? Math.round((performance.now() - t0) * 10) / 10 };
}

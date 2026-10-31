/*
 * Kahoot 300 ms in-page watcher / auto-answerer.
 * Install with one chrome_eval after joining. No model in the loop.
 *
 * It matches the question image's alt/src against the answer labels. If the
 * flag image carries a country name (Kahoot usually gives question images an
 * accessible alt), it clicks the matching answer. If not, it records the state
 * in window.__kahoot so the operator can decide with one quick eval.
 */
(() => {
  if (window.__kbot) clearInterval(window.__kbot);
  window.__kahoot = { state: 'waiting', answers: [], key: '', img: '', t: 0, clicked: '' };
  window.__kbot = setInterval(() => {
    const buttons = [...document.querySelectorAll(
      'button[data-functional-selector^="answer"], button[class*="answer"], [data-testid^="answer"]'
    )].filter((b) => b.offsetParent !== null && (b.innerText || '').trim());
    if (buttons.length < 2) {
      if (window.__kahoot.state === 'question') window.__kahoot.state = 'result';
      return;
    }
    const imgs = [...document.querySelectorAll('img')]
      .filter((i) => i.naturalWidth > 120 && !/avatar|logo|onetrust|powered/i.test(i.src + ' ' + i.className))
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    const img = imgs[0] || null;
    const key = `${img ? (img.alt || '') : ''} ${img ? img.src : ''}`.trim();
    const answers = buttons.map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim());
    window.__kahoot = { state: 'question', answers, key, img: img ? img.src : '', t: Date.now(), clicked: window.__kahoot.clicked || '' };
    if (window.__kahoot.clicked === key) return;
    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const k = norm(key);
    const hit = buttons.find((b) => {
      const t = norm(b.innerText || '');
      return t.length > 2 && k.includes(t);
    });
    if (hit) {
      window.__kahoot.clicked = key;
      window.__kahoot.state = 'clicked';
      hit.click();
    }
  }, 300);
  return 'armed 300ms';
})();

/*
 * Kahoot self-test bot — event-driven.
 * The only worker-owned file. The fixture and oracle are pinned.
 *
 * Answers as soon as the question mutates into the DOM: no polling delay in the
 * path. A 300 ms interval is kept only as a watchdog for the case where the
 * observer is somehow starved.
 */
(() => {
  let last = '';

  const tick = () => {
    const q = document.querySelector('#question');
    const text = q ? q.textContent.trim() : '';
    if (!text || text === last) return;
    const m = text.match(/(\d+)\s*\+\s*(\d+)/);
    if (!m) return;
    const sum = Number(m[1]) + Number(m[2]);
    const hit = [...document.querySelectorAll('.answer')]
      .find((b) => Number((b.textContent || '').trim()) === sum);
    if (!hit) return;
    last = text;
    hit.click();
  };

  const mo = new MutationObserver(tick);
  mo.observe(document.body, { subtree: true, childList: true, characterData: true });

  setInterval(tick, 300); // watchdog only
  tick(); // the question may already be on screen
  window.__kbot = { mode: 'mutation' };
})();

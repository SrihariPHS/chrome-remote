/*
 * Kahoot self-test bot — event-driven.
 * The only worker-owned file. The fixture and oracle are pinned.
 *
 * The fixture paints a question, then flips `#answers[data-live="1"]`. Reacting
 * to that mutation removes the poll interval from the path: the click lands in
 * the same frame the question becomes answerable. The 300 ms interval is only a
 * watchdog for a starved observer.
 */
(() => {
  const tick = () => {
    if (!document.querySelector('#answers[data-live="1"]')) return;
    const q = document.querySelector('#question');
    const text = q ? q.textContent.trim() : '';
    if (!text) return;
    const m = text.match(/(\d+)\s*\+\s*(\d+)/);
    if (!m) return;
    const sum = Number(m[1]) + Number(m[2]);
    const hit = [...document.querySelectorAll('.answer')]
      .find((b) => Number((b.textContent || '').trim()) === sum);
    if (hit) hit.click();
  };

  new MutationObserver(tick).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-live'],
  });

  setInterval(tick, 300); // watchdog only
  tick(); // a question may already be live
  window.__kbot = { mode: 'mutation' };
})();

/*
 * Kahoot self-test bot — baseline: poll every 300 ms.
 * The only worker-owned file. The fixture and oracle are pinned.
 *
 * v2 fixture: a question becomes answerable only after it has been painted, and
 * a click before that is ignored (like a real client that must receive the
 * question first). So the bot re-reads the live flag on every tick.
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
  setInterval(tick, 300);
  tick();
  window.__kbot = { mode: 'poll300' };
})();

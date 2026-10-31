/*
 * Kahoot self-test bot — baseline: poll every 300 ms.
 * The only worker-owned file. The fixture and oracle are pinned.
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
  setInterval(tick, 300);
  tick();
  window.__kbot = { mode: 'poll300' };
})();

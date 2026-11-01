import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const FIX = 'file:///workspace/chrome/fixtures/selftest3.html';
const shipped = await readFile('/workspace/chrome/src/kahoot-selftest-bot.js','utf8');
const secondSmallest = `(() => {
  const tick = () => {
    if (!document.querySelector('#answers[data-live="1"]')) return;
    const b = [...document.querySelectorAll('.answer')]
      .map(x => ({ x, v: Number(x.textContent.trim()) })).sort((p,q) => p.v - q.v);
    if (b.length === 4) b[1].x.click();
  };
  new MutationObserver(tick).observe(document.body, { subtree:true, childList:true, attributes:true, attributeFilter:['data-live'] });
  tick();
})();`;

const browser = await chromium.launch({ executablePath: '/workspace/chromium-1243/chrome-linux64/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
async function run(bot, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(FIX, { waitUntil: 'domcontentloaded' });
    await p.evaluate(bot);
    await p.click('#start');
    try {
      await p.waitForFunction('window.__selftest.done === true', null, { timeout: 15000 });
      out.push(await p.evaluate(() => ({ ms: +window.__selftest.total_ms.toFixed(1), correct: window.__selftest.correct, paints: window.__selftest.paints })));
    } catch { out.push({ ms: null, correct: 0, paints: await p.evaluate(() => window.__selftest.paints) }); }
    await ctx.close();
  }
  return out;
}
const a = await run(shipped, 5);
const b = await run(secondSmallest, 3);
await browser.close();
console.log('shipped bot      ', JSON.stringify(a));
console.log('second-smallest  ', JSON.stringify(b));
console.log('SHIPPED max=' + Math.max(...a.map(x=>x.ms ?? 1e9)) + 'ms correct=' + a.filter(x=>x.correct===10).length + '/' + a.length);
console.log('LAZY correct     ' + b.reduce((s,x)=>s+x.correct,0) + '/' + (b.length*10));

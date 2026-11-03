import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { resolveChromePath } from '../src/browser.mjs';

// Screenshot the diagnostics UI. BASE defaults to a local dev server,
// TOKEN to `data/token` (or IW_TOKEN when the server runs elsewhere).
const base = process.env.BASE || 'http://127.0.0.1:8787';
const token = process.env.IW_TOKEN
  || (await readFile(new URL('../data/token', import.meta.url), 'utf8').catch(() => '')).trim();

if (!token) {
  console.error('no token: set IW_TOKEN or let the server write data/token');
  process.exit(1);
}

const executablePath = resolveChromePath();
if (!executablePath) {
  console.error('no Chromium found: set IW_CHROME or run `npx playwright install chromium`');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.message || e)));

// The diagnostics UI lives on /console; / is the plain browser window.
await page.goto(`${base}/console?token=${token}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.screenshot({ path: new URL('../bench/ui.png', import.meta.url).pathname });
console.log(JSON.stringify({
  title: await page.title(),
  sessions: await page.locator('.session').count(),
  live: await page.locator('#liveChip:not(.hidden)').count(),
  errors,
}, null, 1));
await browser.close();

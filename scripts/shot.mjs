import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const base = process.env.BASE || 'http://127.0.0.1:8787';
const token = (await readFile(new URL('../data/token', import.meta.url), 'utf8')).trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const j = async (p, body) => { const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined }); return r.json(); };

const browser = await chromium.launch({ executablePath: '/workspace/chromium-1243/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.message || e)));
await page.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.screenshot({ path: new URL('../bench/ui.png', import.meta.url).pathname });
console.log(JSON.stringify({ title: await page.title(), sessions: await page.locator('.session').count(), live: await page.locator('#liveChip:not(.hidden)').count(), errors }, null, 1));
await browser.close();

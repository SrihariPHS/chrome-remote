#!/usr/bin/env node
/**
 * Pinned oracle for the Kahoot self-test loop.
 * Runs the fixture in Chromium, installs the bot, clicks Start, waits for the
 * page's own done flag, and reports the page-measured total (not Playwright).
 *
 *   node bench/selftest-oracle.mjs --runs 7
 *   node bench/selftest-oracle.mjs --runs 1 --assert
 */
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = 'file://' + path.join(ROOT, 'fixtures', 'selftest.html');
const BOT = await readFile(path.join(ROOT, 'src', 'kahoot-selftest-bot.js'), 'utf8');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
const runs = Number(arg('runs', 7));
const assertMode = !!arg('assert', false);

const browser = await chromium.launch({
  executablePath: process.env.IW_CHROME || '/workspace/chromium-1243/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const totals = [];
const corrects = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(BOT);
  await page.click('#start');
  await page.waitForFunction('window.__selftest && window.__selftest.done === true', null, { timeout: 15000 });
  const s = await page.evaluate(() => ({
    total_ms: window.__selftest.total_ms,
    correct: window.__selftest.correct,
    answers: window.__selftest.answers,
  }));
  totals.push(Number(s.total_ms));
  corrects.push(Number(s.correct));
  await ctx.close();
}
await browser.close();

const sorted = totals.slice().sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const p50 = +p(0.5).toFixed(1);
const p95 = +p(0.95).toFixed(1);
const min = +Math.min(...totals).toFixed(1);
const max = +Math.max(...totals).toFixed(1);
const allCorrect = corrects.every((c) => c === 10);

console.log(JSON.stringify({ runs, totals, corrects, p50, p95, min, max, allCorrect }));
console.log(`SELFTEST p50_ms=${p50} p95_ms=${p95} min_ms=${min} max_ms=${max} correct=${allCorrect ? '10/10' : corrects.join(',')}`);

if (!allCorrect) process.exit(1);
if (assertMode && p50 >= 1000) {
  console.error(`assert failed: p50 ${p50}ms is not under 1000ms`);
  process.exit(3);
}

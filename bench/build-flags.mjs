#!/usr/bin/env node
/**
 * Build the flag fixtures and the recogniser's knowledge base.
 *
 * Reads fixtures/flags/*.png, renders each into a 6x6 RGB signature inside
 * Chromium (the same downscale the bot performs at answer time), checks that
 * every flag is nearest to itself among all 22, then writes:
 *
 *   fixtures/flags-data.js      window.__FLAGS = { Country: "data:image/png;base64,..." }
 *   src/flags-signatures.json   { Country: [r,g,b, ... 108 values] }
 *
 * Data URIs are used because a file:// page that loads file:// images gets a
 * tainted canvas, and a tainted canvas cannot be read.
 */
import { chromium } from 'playwright-core';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'fixtures', 'flags');

const NAMES = {
  au: 'Australia', br: 'Brazil', ca: 'Canada', cn: 'China', eg: 'Egypt',
  fr: 'France', de: 'Germany', gr: 'Greece', in: 'India', it: 'Italy',
  jp: 'Japan', mx: 'Mexico', nl: 'Netherlands', no: 'Norway', ru: 'Russia',
  za: 'South Africa', es: 'Spain', se: 'Sweden', ch: 'Switzerland',
  tr: 'Turkey', us: 'United States', gb: 'United Kingdom',
};

const files = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort();
const images = [];
for (const f of files) {
  const code = f.replace(/\.png$/, '');
  const name = NAMES[code];
  if (!name) continue;
  const b64 = (await readFile(path.join(DIR, f))).toString('base64');
  images.push({ code, name, uri: `data:image/png;base64,${b64}` });
}

const browser = await chromium.launch({
  executablePath: process.env.IW_CHROME || '/workspace/chromium-1243/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setContent('<body></body>');

const sigs = await page.evaluate(async (imgs) => {
  const SIG = 6;
  const signature = (img) => {
    const c = document.createElement('canvas');
    c.width = SIG; c.height = SIG;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, SIG, SIG);
    const d = x.getImageData(0, 0, SIG, SIG).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
    return out;
  };
  const out = {};
  for (const { name, uri } of imgs) {
    const img = new Image();
    img.src = uri;
    await img.decode();
    out[name] = signature(img);
  }
  return out;
}, images.map(({ name, uri }) => ({ name, uri })));

await browser.close();

// Self-test: every flag must be nearest to itself among all of them.
const dist = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
};
const names = Object.keys(sigs);
const wrong = [];
for (const n of names) {
  let best = null, bestD = Infinity;
  for (const m of names) {
    if (m === n) continue;
    const d = dist(sigs[n], sigs[m]);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (bestD === 0) wrong.push(`${n} is pixel-identical to ${best}`);
}

// Rank separation: how close is the nearest wrong flag, relative to nothing?
const margins = names.map((n) => {
  const own = 0;
  let bestD = Infinity, best = null;
  for (const m of names) {
    if (m === n) continue;
    const d = dist(sigs[n], sigs[m]);
    if (d < bestD) { bestD = d; best = m; }
  }
  return { n, best, bestD, own };
}).sort((a, b) => a.bestD - b.bestD);

await writeFile(
  path.join(ROOT, 'fixtures', 'flags-data.js'),
  'window.__FLAGS = ' + JSON.stringify(Object.fromEntries(images.map((i) => [i.name, i.uri]))) + ';\n'
);
await writeFile(path.join(ROOT, 'src', 'flags-signatures.json'), JSON.stringify(sigs));

console.log(`flags: ${names.length}`);
console.log(`identical pairs: ${wrong.length ? wrong.join('; ') : 'none'}`);
console.log('closest confusable pairs:');
for (const m of margins.slice(0, 5)) console.log(`  ${m.n} vs ${m.best}: ${Math.round(m.bestD)}`);
console.log(`wrote fixtures/flags-data.js and src/flags-signatures.json`);

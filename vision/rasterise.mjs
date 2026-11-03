import { chromium } from 'playwright-core';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const dir = '/workspace/chrome/vision/icons';
const svgs = (await readdir(dir)).filter((f) => f.endsWith('.svg'));
const b = await chromium.launch({ executablePath: '/workspace/chromium-1243/chrome-linux64/chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const p = await b.newPage({ viewport: { width: 300, height: 300 } });
for (const f of svgs) {
  const uri = 'data:image/svg+xml;base64,' + (await readFile(path.join(dir, f))).toString('base64');
  await p.setContent(`<body style="margin:0;background:#fff;display:grid;place-items:center;width:300px;height:300px"><img src="${uri}" style="width:256px;height:256px;object-fit:contain"></body>`);
  await new Promise((r) => setTimeout(r, 50));
  await writeFile(path.join(dir, f.replace('.svg', '.png')), await p.screenshot({ clip: { x: 22, y: 22, width: 256, height: 256 } }));
}
await b.close();
console.log('rasterised', svgs.length);

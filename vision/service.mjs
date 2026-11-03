/**
 * Logo matcher service.
 *
 * POST /match { url }  or  { image_base64 }
 *   -> { best, scores: [{name,score}], ms }
 *
 * The bot sends the question image and the four answer labels; the service
 * embeds the image once and scores it against the brand database. Embedding a
 * query costs ~85 ms on this box; the whole request is dominated by fetching
 * the image.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';

const PORT = Number(process.env.VISION_PORT || 8790);
const t0 = Date.now();
const proc = await AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32');
const model = await CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', { dtype: 'q8' });
const db = JSON.parse(await readFile('/workspace/chrome/vision/db.json', 'utf8'));
console.log(`ready in ${Date.now() - t0} ms · ${db.entries.length} brands`);

const norm = (v) => { const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1; return v.map((x) => x / n); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const embedBytes = async (buf, mime = 'image/png') => {
  const blob = new Blob([buf], { type: mime });
  const img = await RawImage.fromBlob(blob);
  const out = await model(await proc(img));
  return norm(Array.from(out.image_embeds.data));
};

const server = createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, brands: db.entries.length, uptime_s: Math.round((Date.now() - t0) / 1000) });
  if (req.method !== 'POST' || req.url !== '/match') return send(404, { error: 'not found' });
  try {
    let raw = '';
    for await (const c of req) raw += c;
    const { url, image_base64, candidates } = JSON.parse(raw || '{}');
    const t = Date.now();
    let buf;
    if (image_base64) buf = Buffer.from(image_base64, 'base64');
    else if (url) {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) return send(502, { error: `image fetch ${r.status}` });
      buf = Buffer.from(await r.arrayBuffer());
    } else return send(400, { error: 'url or image_base64 required' });

    const vec = await embedBytes(buf);
    const pool = candidates && candidates.length
      ? db.entries.filter((e) => candidates.some((c) => c.toLowerCase() === e.name.toLowerCase()))
      : db.entries;
    if (!pool.length) return send(422, { error: 'no candidate in database', candidates });
    const scores = pool.map((e) => ({ name: e.name, score: Math.max(...e.variants.map((v) => dot(vec, v.vec))) }))
      .sort((a, b) => b.score - a.score);
    return send(200, { best: scores[0].name, scores, ms: Date.now() - t });
  } catch (err) {
    return send(500, { error: String(err && err.message || err) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`listening on 127.0.0.1:${PORT}`));

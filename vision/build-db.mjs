import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { readdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = '/workspace/chrome/vision';
const proc = await AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32');
const model = await CLIPVisionModelWithProjection.from_pretrained('Xenova/clip-vit-base-patch32', { dtype: 'q8' });
const embed = async (file) => {
  const out = await model(await proc(await RawImage.read(file)));
  const v = Array.from(out.image_embeds.data);
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => +(x / n).toFixed(5));
};
const brands = JSON.parse(await readFile(path.join(ROOT, 'brands.json'), 'utf8'));
const NAME = Object.fromEntries(brands.map((b) => [b.slug, b.name]));
const db = {};
for (const [sub, label] of [['icons', 'mono'], ['fav', 'colour']]) {
  for (const f of (await readdir(path.join(ROOT, sub))).filter((f) => f.endsWith('.png'))) {
    const slug = f.replace('.png', '');
    const name = NAME[slug] || slug;
    db[name] = db[name] || { name, variants: [] };
    db[name].variants.push({ style: label, vec: await embed(path.join(ROOT, sub, f)) });
  }
}
const out = Object.values(db).map((e) => ({ name: e.name, variants: e.variants }));
await writeFile(path.join(ROOT, 'db.json'), JSON.stringify({ model: 'clip-vit-base-patch32', dims: 512, entries: out }));
console.log('brands', out.length, 'variants', out.reduce((s, e) => s + e.variants.length, 0));

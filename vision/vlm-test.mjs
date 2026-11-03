import { AutoProcessor, AutoModelForVision2Seq, RawImage } from '@huggingface/transformers';
const t0 = Date.now();
const MODEL = process.env.VLM || 'onnx-community/SmolVLM-256M-Instruct';
const model = await AutoModelForVision2Seq.from_pretrained(MODEL, { dtype: 'q8' });
const processor = await AutoProcessor.from_pretrained(MODEL);
console.log('load', Date.now() - t0, 'ms');
const image = await RawImage.read('/workspace/chrome/bench/q1.png');
const messages = [{ role: 'user', content: [
  { type: 'image' },
  { type: 'text', text: 'This is a Kahoot quiz question. The picture shows a car part with a badge. What car brand is it? Answer with one word.' },
] }];
const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
const t1 = Date.now();
const inputs = await processor(prompt, [image]);
const out = await model.generate({ ...inputs, max_new_tokens: 24 });
const txt = processor.batch_decode(out.slice(null, inputs.input_ids.dims[1]), { skip_special_tokens: true });
console.log('infer', Date.now() - t1, 'ms');
console.log('OUT:', JSON.stringify(txt[0].slice(-160)));

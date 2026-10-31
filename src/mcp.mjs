/**
 * Minimal stateless MCP server over streamable HTTP (JSON responses).
 *
 * The tool surface is deliberately small and intent-shaped: an MCP client gets
 * one call per intent, not one call per click. `chrome_act` and `chrome_eval`
 * are the workhorses; `chrome_reflex` is what makes a countdown usable.
 */
import { compactPulse, jsonText, truncate } from './util.mjs';

const SESSION = {
  type: 'string',
  description: 'Session id. Omit to use the most recently active session.',
};

const TARGET = {
  description: 'Target: "@e12" (ref from snap), "Submit" (visible label), "css=#id", "text=Next", or {ref|selector|text|x,y}.',
};

const STEP_DOC = `One step per object. Supported:
  {"click":"@e3"} | {"click":{"text":"Submit"}} | {"click":{"x":100,"y":200}}
  {"fill":{"ref":"@e2","text":"Ada"}} | {"type":"text into the focused element"}
  {"press":"Enter"} | {"key":"Control+A"}
  {"scroll":{"dy":800}} | {"scroll":{"ref":"@e5","dy":400}}
  {"draw":{"paths":[[[x,y],[x,y],...]],"duration_ms":400}}  // trusted mouse strokes
  {"hover":"@e4"} | {"select":{"ref":"@e6","value":"blue"}}
  {"check":"@e7"} | {"uncheck":"@e7"}
  {"wait":150} | {"waitFor":{"text":"Saved","timeout_ms":4000}}
  {"goto":"https://…"} | {"back":true} | {"reload":true}
  {"eval":"return document.title"}
  {"dialog":"accept"}
A failing step stops the batch unless it sets "optional":true.`;

function tool(name, description, props = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties: props, required, additionalProperties: true } };
}

export const tools = [
  tool('chrome_sessions', 'List warm browser sessions. Call this first if you do not know the session id.', {}, []),
  tool('chrome_open', 'Create a browser session and optionally open a URL. Reuses an existing session when session is given.', {
    session: SESSION,
    url: { type: 'string', description: 'URL to open.' },
    name: { type: 'string', description: 'Human label for a new session.' },
    viewport: { type: 'object', description: '{width,height}; default 1280x800.' },
    observe: { type: 'boolean', description: 'Return the first ref snapshot in the same call (default true).' },
    max: { type: 'number', description: 'Max refs in the first observation (default 80).' },
  }),
  tool('chrome_snap', 'Read the page as a compact ref tree. This is the observation; do not screenshot unless layout matters. Refs are stable for the life of the element.', {
    session: SESSION,
    max: { type: 'number', description: 'Max elements (default 120).' },
    scope: { type: 'string', enum: ['viewport', 'full'], description: 'Default full.' },
  }),
  tool('chrome_task', 'Open a URL and run a whole UI batch in ONE call, returning the post-task observation. Use this for a known flow (open the page, fill/click, done) — it is the fastest path and the whole task is one round trip.', {
    session: SESSION,
    url: { type: 'string', description: 'URL to open (new session if session is omitted).' },
    name: { type: 'string', description: 'Session label.' },
    steps: { type: 'array', items: { type: 'object' }, description: STEP_DOC },
    input: { type: 'string', enum: ['dom', 'cdp'], description: 'dom (default here) clicks in-page; cdp for trusted input.' },
    verify: { type: 'string', description: '"change" (default) or "none".' },
    observe: { type: 'boolean', description: 'Return the post-task ref snapshot (default true).' },
    max: { type: 'number', description: 'Max refs in the observation (default 80).' },
  }),
  tool('chrome_act', 'Run a whole batch of UI steps in one call, then return the new observation. This is the primary tool: put every click/fill/key in one batch, not one call each.', {
    session: SESSION,
    steps: { type: 'array', items: { type: 'object' }, description: STEP_DOC },
    verify: { type: 'string', description: '"change" (default) waits up to 300 ms for the control/url/title/dialog signature to change; "mutation" checks raw DOM mutations; "none" skips; or {expect:"text"}.' },
    input: { type: 'string', enum: ['cdp', 'dom'], description: 'cdp (default) sends trusted mouse events; dom clicks in-page (~10x faster, works with most React apps).' },
    observe: { type: 'boolean', description: 'Return the post-batch snapshot (default true).' },
    max: { type: 'number', description: 'Max elements in the observation (default 90).' },
  }),
  tool('chrome_eval', 'Run JavaScript in the page with the `iw` SDK: iw.snap(), iw.pulse(), iw.click(ref), iw.fill(ref,text), iw.waitFor({text}), iw.read(), iw.reflex({until,do}). Return a JSON value. One call can loop over many elements internally — this is the fast path.', {
    session: SESSION,
    code: { type: 'string', description: 'JavaScript. Use `return` to return a value; async is supported. Example: `return iw.snap({max:60})`.' },
    timeout_ms: { type: 'number', description: 'Default 20000.' },
  }),
  tool('chrome_pulse', 'Read the page’s vital signs without a screenshot: countdown (value, ms remaining, rate, sample age), changed numbers/score, focus, dialogs, mutation age.', { session: SESSION }, []),
  tool('chrome_reflex', 'Arm an in-page reflex that runs at 4–16 ms, not at model speed. When `until` becomes true, `do` runs immediately, then the call returns with reaction_ms. Ideal for countdowns and fast-changing UI.', {
    session: SESSION,
    until: { type: 'string', description: 'JS expression over (iw, snap). Example: `snap.countdown && snap.countdown.est < 1.5`.' },
    do: { type: 'string', description: 'JS expression run when true. Example: `iw.click("@e9")`.' },
    every_ms: { type: 'number', description: 'Sampling interval, default 8.' },
    timeout_ms: { type: 'number', description: 'Default 8000.' },
    max_fires: { type: 'number', description: 'Default 1.' },
  }),
  tool('chrome_wait', 'Wait server-side, inside the page, for text/selector/predicate. One call instead of polling from the model.', {
    session: SESSION,
    text: { type: 'string' }, selector: { type: 'string' },
    predicate: { type: 'string', description: 'JS expression over `iw`.' },
    timeout_ms: { type: 'number', description: 'Default 5000.' },
  }),
  tool('chrome_close', 'Close a session and free its browser context.', { session: SESSION }, []),
];

async function sessionArg(service, args) {
  return service.resolve(args.session || args.id);
}

export async function callTool(service, name, args = {}) {
  switch (name) {
    case 'chrome_sessions':
      return service.list();
    case 'chrome_open': {
      const r = await service.open({ id: args.session, url: args.url, name: args.name, viewport: args.viewport, observe: args.observe !== false, max: args.max || 80 });
      return r;
    }
    case 'chrome_snap': {
      const s = await sessionArg(service, args);
      const r = await s.snap({ max: args.max || 120, scope: args.scope || 'full' });
      return { session: s.id, ms: r.ms, url: r.url, title: r.title, bytes: r.bytes, text: r.text };
    }
    case 'chrome_task': {
      const r = await service.task({ id: args.session, url: args.url, name: args.name, steps: args.steps || [], input: args.input === 'cdp' ? 'cdp' : 'dom', verify: args.verify || 'change', observe: args.observe !== false, max: args.max || 80 });
      return r;
    }
    case 'chrome_act': {
      const s = await sessionArg(service, args);
      const r = await s.act({ steps: args.steps || [], verify: args.verify || 'change', observe: args.observe !== false, max: args.max || 90, input: args.input === 'dom' ? 'dom' : 'cdp' });
      return { ...r, text: r.obs?.text, obs: undefined };
    }
    case 'chrome_eval': {
      const s = await sessionArg(service, args);
      const r = await s.evalCode(args.code, { timeout: args.timeout_ms || 20000 });
      return r;
    }
    case 'chrome_pulse': {
      const s = await sessionArg(service, args);
      return compactPulse(await s.pulse({ allFrames: !!args.all_frames }));
    }
    case 'chrome_reflex': {
      const r = await service.reflex(args.session, args);
      return r;
    }
    case 'chrome_wait': {
      const r = await service.wait(args.session, args);
      return r;
    }
    case 'chrome_close':
      return service.close((await sessionArg(service, args)).id);
    default: {
      const e = new Error('unknown tool: ' + name);
      e.code = 'unknown_tool';
      throw e;
    }
  }
}

export async function handleMcp(service, body) {
  const msg = Array.isArray(body) ? body[0] : body;
  const id = msg?.id ?? null;
  if (!msg || msg.jsonrpc !== '2.0' || !msg.method) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } };
  }
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chrome.inkwork.studio', version: '0.1.0' },
        instructions: 'A remote Chromium you drive with one intent per call. Start with chrome_sessions or chrome_open, then chrome_snap, then chrome_act with a whole batch of steps. Use chrome_pulse/chrome_reflex for countdowns and fast-changing UI. Prefer chrome_eval when a loop over many elements would otherwise take many calls.',
      });
    }
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      try {
        const value = await callTool(service, name, args);
        const text = typeof value === 'string' ? truncate(value, 12000) : jsonText(value, 12000);
        return reply({ content: [{ type: 'text', text }], isError: false, structuredContent: { result: value } });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `${e.code || 'error'}: ${e.message}` }], isError: true });
      }
    }
    if (msg.method === 'resources/list') return reply({ resources: [] });
    if (msg.method === 'prompts/list') return reply({ prompts: [] });
    if (msg.method.startsWith('notifications/')) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + msg.method } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}

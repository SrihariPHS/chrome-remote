# chrome.inkwork.studio

A warm remote Chromium you drive with **one intent per call**.

Most "computer use" is slow because it moves pixels and one action at a time
across the network: screenshot → model → one click → screenshot → model. This
service makes the browser do the waiting and the looping, and gives the agent a
compact, timestamped view of the page instead of an image.

```
 agent ── one HTTP/MCP call ──►  session (warm Chromium)
                                   │  page-side SDK: snap / pulse / reflex
                                   │  direct CDP:    input, frames, screencast
                                   ▼
                              text tree + timers + changed numbers
```

- **Warm**: one browser process, one CDP session per page, no launch per action.
- **Compact**: a snapshot is ~1–6 KB of refs (`@e12 button "Mars"`), not a 45 ms
  JPEG or 700 KB of HTML.
- **Batched**: an 8-step form fill is one call. The post-batch observation comes
  back in the same response.
- **Time-aware**: `pulse` returns countdown values extrapolated to read time,
  with the sample age and rate. `reflex` runs `until → do` inside the page at
  an 8 ms loop, so a 20-second Kahoot timer is a solved problem rather than a
  race — even when the host is too busy to paint at 60 fps.
- **Frame-aware**: cross-origin iframes are snapshotted and clicked with the
  right offsets (tested, not assumed).

The console at `/` is the human side: live JPEG screencast, take-control input,
countdown, focus, mutation age, ref tree, operation timeline and latency.

---

## Quick start

```bash
cd /workspace/chrome
npm install                 # playwright-core + ws only
node server.mjs
# prints: http://127.0.0.1:8787/?token=…
```

It uses the Chromium already on this box
(`/workspace/chromium-1243/chrome-linux64/chrome`). Override with
`IW_CHROME=/path/to/chrome`.

```bash
export IW=http://127.0.0.1:8787
export T=$(cat data/token)
curl -s $IW/api/sessions -H "Authorization: Bearer $T"
```

Create a session and read the page:

```bash
curl -s -X POST $IW/api/sessions -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' \
  -d '{"name":"quiz","url":"http://127.0.0.1:8787/fixtures/kahoot.html"}'

curl -s -X POST $IW/api/s/<id>/snap -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"max":100}'
```

Act with a whole batch:

```bash
curl -s -X POST $IW/api/s/<id>/act -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{
    "input": "dom",
    "steps": [
      {"fill": {"selector": "input[name=name]", "text": "Ada Lovelace"}},
      {"fill": {"selector": "input[name=email]", "text": "ada@example.com"}},
      {"click": {"text": "Create account"}}
    ]
  }'
```

`input: "cdp"` (default) sends trusted mouse events; `"dom"` clicks in-page and
is roughly 3–10× faster on a loaded box. Use `dom` for normal apps, `cdp` for
canvas/pickers/anti-synthetic-event flows.

## The four observation tools

| tool | what it answers | cost |
|---|---|---|
| `snap` | what is on the page, as refs | ~3–12 ms engine |
| `pulse` | countdown, score, focus, dialogs, how stale | ~1–7 ms |
| `wait` | block until text/selector/predicate | one call, in-page |
| `screenshot` | layout / canvas / overlap | ~45–150 ms, avoid in loops |

`pulse.countdown` looks like:

```json
{"text":"12.41","v":12.41,"est":12.402,"dir":"down","rate":0.001,
 "age":4.2,"ref":"e17","fs":76,"keyed":true,"bounds":[986,354,225,76]}
```

`est` is seconds remaining extrapolated to the moment of the read. A timestamp
that stopped changing is reported as `dir:"idle"` and is **not** extrapolated,
so an answered Kahoot question cannot look like a live timer.

## The reflex

```bash
curl -s -X POST $IW/api/s/<id>/reflex -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{
    "until": "snap.countdown && snap.countdown.est < 1.5",
    "do":    "iw.click({text: \"Mars\"})",
    "every_ms": 8,
    "timeout_ms": 12000
  }'
```

Measured reaction: **0.8–2.7 ms p50** in the benchmark below. This is the only
honest way to interact with something that changes every millisecond: never
route the decision through the model. Declare the reflex once, let the page
execute it.

## Code mode

`POST /api/s/<id>/eval` with `{"code":"return iw.snap({max:40})"}`.

```js
// one round trip, many actions
const rows = [...document.querySelectorAll('article')].map(a => a.innerText);
return { n: rows.length, rows: rows.slice(0, 10) };
```

In-page `iw` SDK: `snap`, `pulse`, `click`, `fill`, `select`, `check`,
`waitFor`, `reflex`, `read`, `find`, `logs`, `seq`.

## Recipes

`GET /api/recipes` → `quiz.state`, `quiz.answer`, `kahoot.join`, `doc.append`,
`doc.read`. They are heuristics over generic quiz/doc UIs and return the
evidence they used. `kahoot.join` was verified against the live kahoot.it join
screen; a full game was not (that needs a real PIN).

```bash
curl -s -X POST $IW/api/s/<id>/recipe/quiz.state -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{}'
```

## MCP

`/mcp` is a stateless streamable-HTTP MCP server. Tools:
`chrome_sessions`, `chrome_open`, `chrome_snap`, `chrome_act`, `chrome_eval`,
`chrome_pulse`, `chrome_reflex`, `chrome_wait`, `chrome_close`.

```json
{
  "mcpServers": {
    "chrome": {
      "type": "http",
      "url": "https://chrome.inkwork.studio/mcp",
      "headers": { "Authorization": "Bearer $IW_TOKEN" }
    }
  }
}
```

`llms.txt` is the agent-facing quick reference served at `/llms.txt`.

## Measured

This box is shared. The numbers below are real artifacts, including the load
average, because the honest story is about the shape of the curve, not a single
hero number.

| run | loadavg | snap p50 | pulse p50 | 8-step batch (dom) | screenshot | reflex |
|---|---:|---:|---:|---:|---:|---:|
| `05:28` | 10–16 | 12.7 ms (6.0 engine) | 10.1 ms (4.3) | 274 ms (107 engine) | 115 ms | 1.2 ms |
| `05:39` | 28 | 33.2 ms (15.6) | 19.0 ms (6.2) | 405 ms (330) | 109 ms | 23.9 ms |

- Engine-only floor on a static page, measured separately: at low load
  **CDP evaluate 0.75 ms, `iw.snap` 1.0–1.4 ms, `iw.sig` 4.7 ms, screenshot
  44.7 ms**; at load 30 the same calls were 4.4 / 36.5 / 8.0 ms. Everything
  slows roughly with CPU contention, including the page's own timer.
- Timer accuracy when read in the same eval as the page's own clock: **−3 to
  +4 ms**. The rate estimate needs ~700 ms of history; before that `est` is the
  last sample and `rate` is 0, which is safe.
- Observation: 21 refs / 1,260 B; post-batch observation 1,260 B. A screenshot
  is 100–220 ms and carries no refs or timers.
- The reflex never leaves the page. Its reaction is one task-loop turn
  (single-digit ms on a healthy page; 24 ms on this box at load 28), not a model
  or HTTP round trip.

Artifacts: `bench/results/bench-2026-10-31T05-28-28-581Z.json` and
`bench-2026-10-31T05-39-34-337Z.json`. Re-run `npm run bench` for a fresh one.
For the lowest latency, run the service on the machine the agent is on (the Mac)
rather than a loaded NAS.

## Security model

This is a browser-control service. The token is equivalent to control of the
browser, including whatever is logged into it.

- A random token is generated on first boot at `data/token` (0600) unless
  `IW_TOKEN` is set. Every `/api/*` and `/mcp` call requires it.
- Sessions are isolated browser contexts, not the owner's profile. There are no
  imported Chrome cookies by default.
- `eval` runs page JavaScript, not Node. But the browser can reach private
  network addresses, so treat the service as a network foothold.
- URLs are `http(s)`/`about:blank`; uploads are confined to `data/uploads`.
- For a public deployment, terminate TLS at Cloudflare and put the service
  behind a long token or Cloudflare Access. Do not publish an unauthenticated
  port. See `deploy/DEPLOY.md`.

## Repo map

```
server.mjs            HTTP + WS + SSE + auth + screencast + routes
src/browser.mjs       Fleet/Session, direct CDP hot paths, input, frames
src/page-sdk.js       injected SDK: snap, pulse, reflex, wait, click/fill
src/service.mjs       facade shared by HTTP and MCP
src/mcp.mjs           stateless MCP server + intent-shaped tools
src/recipes.mjs       quiz/doc heuristics
public/               console (vanilla JS, no build step)
fixtures/             Kahoot-shaped, Docs-shaped, form, cross-origin frames
test/e2e.test.mjs     11 end-to-end tests (real Chromium)
bench/bench.mjs       reproducible latency/bytes benchmark
deploy/               Dockerfile, compose, tunnel notes
skill/SKILL.md        installable agent skill for T3 Code / OpenCode
```

## Limits / next

- Quiz/doc recipes are tested against the fixtures. `kahoot.join` was checked
  against the live join screen (PIN entry, cookie banner), but a full live game
  and Google Docs were not. That live pass is the next verification step.
- No persistent profile / login import yet. `storageState` export is the
  obvious next addition, with an explicit per-profile opt-in.
- Screencast is JPEG and best-effort; on a loaded box it drops to 6–10 fps. The
  pulse stream is the ground truth for time-sensitive work.
- One agent per session. A lease/lock API is worth adding before parallel agents
  share the same browser.
- No video/audio action support, no OS-level computer use — this is Chromium.

![the console](bench/ui.png)

MIT-style internal project. No third-party code copied; the design draws on
public ideas from ego lite (code-mode intents + compact snapshots), Stagehand
(observe → replay, deterministic actions) and flashact/cua-driver (warm daemon,
refs, verify-in-the-same-call).
